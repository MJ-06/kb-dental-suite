// New, marked DB/roles/storage only. No reset/import/source patient access.
import {randomBytes,randomUUID} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import pg from "pg";
import {migrate} from "../src/migrator.js";
import {createClinic,createUser} from "../src/admin.js";
import {hashPassword} from "../src/auth/password.js";
const root=fileURLToPath(new URL("../.organization-demo-runtime/public-clinical/",import.meta.url));
const database="kb_public_clinical_demo";
const stateFile=join(root,"state.json");
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
let phase="preflight";
async function main(){
 if(!process.argv.includes("--apply")){console.log("Dry run: create a NEW isolated two-clinic synthetic review database, roles and storage; existing databases are untouched.");return;}
 mkdirSync(root,{recursive:true,mode:0o700});
 if(process.platform==="win32"){
  const sid=execFileSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",windowsHide:true}).match(/S-1-[0-9-]+/)?.[0];
  if(!sid)throw Error("No SID");execFileSync("icacls",[root,"/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`],{stdio:"ignore",windowsHide:true});
 }
 const password=readFileSync(join(homedir(),".kb-pms","postgres-superuser.txt"),"utf8").trim();
 const admin=new pg.Client({host:"localhost",database:"postgres",user:"postgres",password});await admin.connect();
 try{
  const old=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[database])).rows[0];
  if(existsSync(stateFile)){
   const state=JSON.parse(readFileSync(stateFile,"utf8"));
   if(!old || old.marker!==state.marker || !state.complete)throw Error("Existing incomplete/mismatched demo requires owner review");
   console.log("Existing marked public demo retained; no database or credentials changed.");return;
  }
  if(old)throw Error("Refusing an unowned existing target");
  const suffix=randomBytes(4).toString("hex"),secret=()=>randomBytes(22).toString("base64url");
  const state={marker:`kb-public-synthetic:${randomUUID()}`,owner:`kb_review_owner_${suffix}`,app:`kb_review_app_${suffix}`,ownerPassword:secret(),appPassword:secret(),loginPassword:secret(),screenPassword:secret(),complete:false};
  writeFileSync(stateFile,JSON.stringify(state),{mode:0o600,flag:"wx"});
  phase="role/database provisioning";
  for(const [role,pw] of [[state.owner,state.ownerPassword],[state.app,state.appPassword]]) await admin.query(`CREATE ROLE ${ident(role!)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD ${literal(pw!)}`);
  await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(state.owner)}`);
  await admin.query(`COMMENT ON DATABASE ${ident(database)} IS ${literal(state.marker)}`);
  await admin.query(`REVOKE ALL ON DATABASE ${ident(database)} FROM PUBLIC,kb_app`);
  const url=(user:string,pw:string)=>{const u=new URL(`postgresql://localhost:5432/${database}`);u.username=user;u.password=pw;return u.toString();};
  const ownerUrl=url(state.owner,state.ownerPassword);
  phase="migrations";await migrate(ownerUrl,()=>{});
  phase="fictional seed";
  const clinics=[];
  for(const [code,name] of [["demo-one","Demo Riverside Clinic"],["demo-two","Demo Orchard Clinic"]]) clinics.push(await createClinic(ownerUrl,{code:code!,name:name!}));
  for(const clinic of clinics)for(const [username,displayName,role] of [["admin","Demo Administrator","admin"],["doctor","Dr Rowan Example","doctor"],["doctor-one","Dr Morgan Example","doctor"],["reception","Demo Reception","reception"],["accounts","Demo Accounts","accounts"]])
    await createUser(ownerUrl,clinic,{username:username!,displayName:displayName!,role:role!,password:state.loginPassword});
  const c=new pg.Client({connectionString:ownerUrl});await c.connect();
  try{
   await c.query("BEGIN");
   const org=(await c.query("INSERT INTO org_identity(id,code,name,hostname) VALUES(uuidv7(),'review-demo','Fictional Dental Review Organization','public-review') RETURNING id")).rows[0].id;
   await c.query("SELECT set_config('app.organization_id',$1,true)",[org]);
   for(const [i,clinic]of clinics.entries()){
    const unit=(await c.query("INSERT INTO org_units(code,name) VALUES($1,$2) RETURNING id",[`clinic-${i+1}`,i===0?"Demo Riverside Clinic":"Demo Orchard Clinic"])).rows[0].id;
    await c.query("INSERT INTO org_clinical_units VALUES($1,$2,$3)",[org,unit,clinic]);
   }
   await c.query("SELECT set_config('app.clinic_id',$1,true)",[clinics[0]]);
   const principals=(await c.query("SELECT id,username FROM app_users")).rows;
   const screenHash=await hashPassword(state.screenPassword);
   await c.query("INSERT INTO org_settings(key,value) VALUES('clinical_master_password',$1::jsonb),('clinical_profile',$2::jsonb)",[JSON.stringify(screenHash),JSON.stringify({displayName:"Fictional Dental Review Organization",legalName:"Synthetic demonstration only"})]);
   for(const [i,clinic]of clinics.entries()){
    await c.query("SELECT set_config('app.clinic_id',$1,true)",[clinic]);
    const users=(await c.query("SELECT id,username FROM app_users")).rows;
    for(const principal of principals){
      if(i>0 && !["admin","doctor"].includes(principal.username))continue;
      const target=users.find(u=>u.username===principal.username)!;
      await c.query("INSERT INTO org_clinical_access VALUES($1,$2,$3,$4,$5,$6)",[org,clinics[0],principal.id,clinic,target.id,principal.username==="admin"]);
    }
    for(const key of ["finance_password","reports_password_1","reports_password_2"])await c.query("INSERT INTO clinic_settings(key,value) VALUES($1,$2::jsonb)",[key,JSON.stringify(screenHash)]);
    for(const [key,value]of Object.entries({clinic_profile:{name:i===0?"Demo Riverside Clinic":"Demo Orchard Clinic",address:"Fictional address for testing only",phone:"9000000090",email:"demo@example.invalid"},clinic_timings:{open:"09:00",close:"19:00",slotMinutes:30,breaks:[{name:"Lunch",from:"13:00",to:"14:00"}]},week_off:[]}))
      await c.query("INSERT INTO clinic_settings(key,value) VALUES($1,$2::jsonb)",[key,JSON.stringify(value)]);
    await c.query("INSERT INTO chairs(name) VALUES('Chair 1'),('Chair 2')");
    await c.query("INSERT INTO doctors(name,registration_no) VALUES('Dr Rowan Example','DEMO-DOCTOR-01'),('Dr Morgan Example','DEMO-DOCTOR-02')");
    for(const [list,values]of Object.entries({payment_mode:["Cash","UPI","Card"],expense_category:["Demo supplies","Demo utilities"]}))for(const [order,value]of values.entries())await c.query("INSERT INTO pick_lists(list_name,value,sort_order) VALUES($1,$2,$3)",[list,value,order]);
    await c.query("INSERT INTO treatments(name,fee,active) VALUES('Demo consultation',300,true)").catch(async()=>{throw Error("Treatment catalogue seed mismatch");});
   }
   await c.query("SELECT set_config('app.clinic_id',$1,true),set_config('app.user_id',$2,true)",[clinics[0],principals.find(u=>u.username==="admin")!.id]);
   for(const [name,dob,mobile]of [["Aster Demo Patient","1990-01-15","9000000001"],["Cedar Demo Patient","1985-06-20","9000000002"],["Juniper Demo Patient","2000-02-10","9000000002"]])
     await c.query("INSERT INTO patients(uhid,full_name,date_of_birth,mobile,gender) VALUES(next_uhid(),$1,$2,$3,'Other')",[name,dob,mobile]);
   const canonical=(await c.query("SELECT l.organization_patient_id FROM org_clinical_patient_links l JOIN patients p ON p.id=l.patient_id WHERE p.full_name='Aster Demo Patient'")).rows[0].organization_patient_id;
   for(const [i,clinic]of clinics.entries()){
    await c.query("SELECT set_config('app.clinic_id',$1,true),set_config('app.user_id',$2,true)",[clinic,(await c.query("SELECT id FROM app_users WHERE username='admin' AND clinic_id=$1",[clinic])).rows[0]?.id ?? principals.find(u=>u.username==="admin")!.id]);
    // Resolve user after tenant selection for forced RLS.
    const user=(await c.query("SELECT id FROM app_users WHERE username='admin'")).rows[0].id;await c.query("SELECT set_config('app.user_id',$1,true)",[user]);
    const patient=(await c.query("SELECT clinical_open_patient($1) AS patient",[canonical])).rows[0].patient;
    const day=i===0?"2026-10-28":"2026-11-02",doctor=i===0?"Dr Rowan Example":"Dr Morgan Example";
    await c.query("INSERT INTO daily_register(patient_id,uhid,visit_date,procedure_done,work_done,operating_doctor,tooth_no) VALUES($1,$2,$3,'Synthetic care example','Fictional demonstration only',$4,'Demo site')",[patient.id,patient.uhid,day,doctor]);
    await c.query("INSERT INTO clinical_records(patient_id,uhid,tab_name,fields,recorded_at) VALUES($1,$2,'Synthetic material example',$3::jsonb,$4)",[patient.id,patient.uhid,JSON.stringify({Doctor:doctor,Treatment:"Synthetic treatment",Material:i===0?"Demo material A":"Demo material B",LOT:"DEMO-LOT-01",Notes:"Synthetic review fixture; no actual clinical care"}),day+"T10:00:00+05:30"]);
   }
   await c.query("COMMIT");
  }catch(e){await c.query("ROLLBACK");throw e;}finally{await c.end();}
  phase="isolated runtime grants";
  const grantClient=new pg.Client({host:"localhost",database,user:"postgres",password});await grantClient.connect();
  try{
   const grants=readFileSync(fileURLToPath(new URL("../migrations/grants.sql",import.meta.url)),"utf8").replace(/\bkb_app\b/g,ident(state.app));
   await grantClient.query(grants);
   await grantClient.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kb_app; REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,kb_app");
   await admin.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(state.app)}`);
  }finally{await grantClient.end();}
  const documents=join(root,"documents");mkdirSync(documents,{recursive:true,mode:0o700});
  writeFileSync(join(root,"app.env"),`DATABASE_URL=${url(state.app,state.appPassword)}\nPORT=8200\nDOCUMENT_DIR=${documents.replaceAll('\\','/')}\nKB_SECRETS_KEY=${randomBytes(32).toString('base64')}\nANTHROPIC_API_KEY=\nPDF_BROWSER=\n`,{mode:0o600});
  writeFileSync(join(root,"demo-logins.txt"),`SYNTHETIC PUBLIC REVIEW ONLY. Share privately with the reviewer.\nClinic code: demo-one\nUsernames: admin (both clinics), doctor (both clinics), doctor-one (first clinic), reception, accounts\nLogin password: ${state.loginPassword}\nMaster / Finance / Reports password: ${state.screenPassword}\nNo real patient data or real integrations.\n`,{mode:0o600});
  state.complete=true;writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});
  console.log("Dedicated synthetic two-clinic review database provisioned. Credentials/config are in the ignored public-clinical runtime directory; none printed.");
 }finally{await admin.end();}
}
main().catch(()=>{console.error(`Public clinical demo stopped at ${phase}; no existing database was reset and no credentials were printed.`);process.exitCode=1;});
