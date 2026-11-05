// Run AFTER verification, as authorized by the owner. No passwords in output.
import {readFileSync,writeFileSync} from 'node:fs';import {randomBytes} from 'node:crypto';import pg from 'pg';import {hashPassword} from '../src/auth/password.js';
const root=new URL('../.organization-demo-runtime/realdata-review/',import.meta.url);
async function main(){
 if(!process.argv.includes('--apply')){console.log('Dry run: rotate temporary review staff and screen credentials; end existing review sessions.');return;}
 const state=JSON.parse(readFileSync(new URL('state.json',root),'utf8'));if(!state.complete)throw Error('Incomplete review');
 const c=new pg.Client({host:'localhost',database:'kb_realdata_review',user:state.owner,password:state.ownerPassword});await c.connect();
 try{const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;if(marker!==state.marker)throw Error('Unexpected database');
  const passwords=Object.fromEntries(['admin','doctor','reception','accounts'].map(user=>[user,randomBytes(24).toString('base64url')]));const screen=randomBytes(24).toString('base64url'),screenHash=await hashPassword(screen);
  await c.query('BEGIN');const org=(await c.query("SELECT id FROM org_identity WHERE code::text='kb-real-review'")).rows[0]?.id;if(!org)throw Error('Unexpected organization');await c.query("SELECT set_config('app.organization_id',$1,true)",[org]);
  await c.query("UPDATE org_settings SET value=$1::jsonb WHERE unit_id IS NULL AND key='clinical_master_password'",[JSON.stringify(screenHash)]);
  const clinics=(await c.query('SELECT id FROM clinics')).rows;
  for(const clinic of clinics){await c.query("SELECT set_config('app.clinic_id',$1,true)",[clinic.id]);for(const [user,pw]of Object.entries(passwords))await c.query('UPDATE app_users SET password_hash=$1,failed_attempts=0,locked_until=NULL WHERE username::text=$2',[await hashPassword(pw),user]);await c.query("UPDATE clinic_settings SET value=$1::jsonb WHERE key=ANY($2::text[])",[JSON.stringify(screenHash),['finance_password','reports_password_1','reports_password_2']]);await c.query('DELETE FROM sessions');}
  await c.query('COMMIT');state.userPasswords=passwords;state.loginPassword=passwords.admin;state.screenPassword=screen;state.credentialsRotatedAt=new Date().toISOString();writeFileSync(new URL('state.json',root),JSON.stringify(state),{mode:0o600});
  writeFileSync(new URL('demo-logins.txt',root),`PRIVATE REAL-DATA REVIEW — credentials rotated after testing.\nShare only the relevant credential with each authorized reviewer.\nClinic code: kb-review\n${Object.entries(passwords).map(([user,pw])=>user+': '+pw).join('\n')}\nMaster / Finance / Reports: ${screen}\nPrevious staff sessions were ended.\n`,{mode:0o600});
  console.log('Temporary staff and screen passwords rotated; prior review sessions ended; private login file updated. No passwords printed.');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
}
main().catch(()=>{console.error('Review credential rotation failed; inspect private configuration without printing credentials.');process.exitCode=1;});
