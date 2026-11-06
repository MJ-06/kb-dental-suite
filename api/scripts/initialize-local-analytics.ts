import {readFileSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {join} from 'node:path';import {createRequire} from 'node:module';import {parseEnv} from 'node:util';import pg from 'pg';
const root=fileURLToPath(new URL('../.organization-demo-runtime/analytics/',import.meta.url)),state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
if(state.database!=='kb_umami_review'||state.marker!=='kb-dental-local-analytics-v1')throw Error('Unexpected analytics target');
const require=createRequire(join(root,'umami','package.json')),bcrypt=require('bcryptjs');
const c=new pg.Client({host:'localhost',database:state.database,user:state.role,password:state.password});await c.connect();
try{
 const marker=(await c.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected database marker');
 await c.query('BEGIN');
 const user=(await c.query('UPDATE "user" SET password=$1 WHERE username=\'admin\' RETURNING user_id',[await bcrypt.hash(state.adminPassword,12)])).rows[0];if(!user)throw Error('Analytics admin missing');
 await c.query('INSERT INTO website(website_id,name,domain,user_id,created_by,recorder_enabled) VALUES($1,\'Clinical Suite review\',\'kb-dental-local\',$2,$2,false) ON CONFLICT(website_id) DO UPDATE SET recorder_enabled=false',[state.websiteId,user.user_id]);await c.query('COMMIT');
 if(process.argv.includes('--connect-review')){
  const envPath=fileURLToPath(new URL('../.organization-demo-runtime/realdata-review/app.env',import.meta.url)),config=parseEnv(readFileSync(envPath,'utf8'));
  if(new URL(config.DATABASE_URL!).pathname!=='/kb_realdata_review')throw Error('Unexpected clinical review');
  Object.assign(config,{UMAMI_LOCAL_URL:'http://127.0.0.1:8091',UMAMI_WEBSITE_ID:state.websiteId,UMAMI_EVENT_SALT:state.salt});
  writeFileSync(envPath,Object.entries(config).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
 }
 console.log('Local analytics initialized with private credentials and replay disabled. No credentials printed.');
}finally{await c.end();}
