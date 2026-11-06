// Isolated local analytics; this role has no grants on clinical databases.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {randomBytes,randomUUID} from 'node:crypto';import pg from 'pg';
const root=fileURLToPath(new URL('../.organization-demo-runtime/analytics/',import.meta.url));mkdirSync(root,{recursive:true});
const file=join(root,'state.json'),marker='kb-dental-local-analytics-v1';
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{database:'kb_umami_review',role:'kb_umami_'+randomBytes(6).toString('hex'),password:randomBytes(32).toString('base64url'),adminPassword:randomBytes(24).toString('base64url'),websiteId:randomUUID(),secret:randomBytes(32).toString('hex'),salt:randomBytes(32).toString('hex'),marker};
if(state.database!=='kb_umami_review'||state.marker!==marker)throw Error('Unexpected analytics runtime');
if(!process.argv.includes('--apply')){console.log('Dry run. Add --apply to provision the isolated local analytics database.');process.exit(0);}
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"',literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const c=new pg.Client({host:'localhost',database:'postgres',user:'postgres',password:readFileSync(join(homedir(),'.kb-pms/postgres-superuser.txt'),'utf8').trim()});await c.connect();
try{
 const existing=(await c.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",[state.database])).rows[0];
 if(existing&&existing.marker!==marker)throw Error('Existing database is not an analytics target');
 writeFileSync(file,JSON.stringify(state),{mode:0o600});
 if(!(await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[state.role])).rowCount)await c.query(`CREATE ROLE ${ident(state.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(state.password)}`);
 if(!existing){await c.query(`CREATE DATABASE ${ident(state.database)} OWNER ${ident(state.role)}`);await c.query(`COMMENT ON DATABASE ${ident(state.database)} IS ${literal(marker)}`);}
 await c.query(`REVOKE ALL ON DATABASE ${ident(state.database)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${ident(state.database)} TO ${ident(state.role)}`);
 const url=new URL('postgresql://localhost:5432/'+state.database);url.username=state.role;url.password=state.password;
 const config={DATABASE_URL:url.href,APP_SECRET:state.secret,DISABLE_TELEMETRY:'1',NEXT_TELEMETRY_DISABLED:'1',SKIP_BUILD_GEO:'1',HOSTNAME:'127.0.0.1',PORT:'8091',DISABLE_BOT_CHECK:'1'};
 writeFileSync(join(root,'umami','.env'),Object.entries(config).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
 const layoutFile=join(root,'umami','src','app','layout.tsx');
 let layout=readFileSync(layoutFile,'utf8');
 if(layout.includes("from 'next/font/google'")){
  layout=layout.replace(/^import \{ Inter \} from 'next\/font\/google';\r?\n/m,'').replace(/const inter = Inter\(\{[\s\S]*?\}\);/,"const inter = {className:'',variable:''}; // Local setup: system fonts, no Google font requests.");
  writeFileSync(layoutFile,layout);
  const css=join(root,'umami','src','app','global.css');writeFileSync(css,readFileSync(css,'utf8')+'\n:root { --font-inter: Arial, Helvetica, sans-serif; }\n');
 }
 writeFileSync(join(root,'demo-logins.txt'),'PRIVATE LOCAL ANALYTICS\nURL: http://127.0.0.1:8091\nUsername: admin\nPassword: '+state.adminPassword+'\nSeparate from clinical sign-in. No patient details are collected.\n',{mode:0o600});
 console.log('Isolated local analytics database and private configuration ready. No credentials printed.');
}finally{await c.end();}
