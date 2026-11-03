import {readFileSync} from "node:fs";
import pg from "pg";
import {migrate} from "../src/migrator.js";
const state=JSON.parse(readFileSync(new URL("../.organization-demo-runtime/public-clinical/state.json",import.meta.url),"utf8"));
if(!state.complete || !/^kb_review_app_[a-z0-9]+$/.test(state.app))throw Error("Unexpected demo state");
const url=new URL("postgresql://localhost:5432/kb_public_clinical_demo");url.username=state.owner;url.password=state.ownerPassword;
const c=new pg.Client({connectionString:url.href});await c.connect();
try{
 const marker=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker;
 if(marker!==state.marker)throw Error("Unexpected database marker");
 await migrate(url.href,()=>{},{applyGrants:false});
 await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kb_app');
 await c.query('REVOKE EXECUTE ON FUNCTION clinical_report_access(bytea) FROM PUBLIC,kb_app');
 await c.query(`GRANT EXECUTE ON FUNCTION clinical_report_access(bytea) TO "${state.app}"`);
 console.log("Marked synthetic database migrated; reporting function granted only to its dedicated runtime role.");
}finally{await c.end();}
