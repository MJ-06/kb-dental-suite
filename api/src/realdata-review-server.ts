// Dedicated authenticated real-data review. No development or source credentials.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
const file=fileURLToPath(new URL('../.organization-demo-runtime/realdata-review/app.env',import.meta.url));
const config=parseEnv(readFileSync(file,'utf8'));
const system=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','COMSPEC','PATHEXT']);
for(const key of Object.keys(process.env))if(!system.has(key.toUpperCase()))delete process.env[key];
Object.assign(process.env,config,{KB_APP_ENV_FILE:file,KB_LOAD_OWNER_ENV:'false',ANTHROPIC_API_KEY:'',PDF_BROWSER:''});
const {createDb}=await import('./db/index.js');const {buildApp}=await import('./app.js');const {sql}=await import('kysely');
const db=createDb(config.DATABASE_URL!,8);
const identity=(await sql<{code:string}>`SELECT code FROM org_identity`.execute(db)).rows;
if(identity.length!==1||identity[0]!.code!=='kb-real-review')throw Error('Unexpected review database');
const app=await buildApp({db,cookieSecure:true,publicDemo:true,logger:false});
await app.listen({host:'127.0.0.1',port:8300});console.log('Authenticated real-data review listening on loopback8300. Source environment is not loaded.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await app.close();await db.destroy();process.exit(0);});
