// Start on the clinic laptop/server, separately from the HTTP process.
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {archiveTick} from '../src/archive/worker.js';
import {DriveClient,parseCredential} from '../src/drive/client.js';
const file=process.env.KB_ARCHIVE_WORKER_ENV??process.argv.find(a=>a.startsWith('--config='))?.slice(9);
if(!file)throw Error('Set KB_ARCHIVE_WORKER_ENV to the private archive worker env file.');
const config=parseEnv(readFileSync(file,'utf8'));
for(const key of ['ARCHIVE_DATABASE_URL','ARCHIVE_DIR','DOCUMENT_DIR','PG_DUMP','PG_RESTORE','ARCHIVE_TAR'])if(!config[key])throw Error('Archive worker configuration is incomplete.');
const drive=config.ARCHIVE_DRIVE_CREDENTIAL_FILE?new DriveClient(parseCredential(JSON.parse(readFileSync(config.ARCHIVE_DRIVE_CREDENTIAL_FILE,'utf8')))):undefined;
const options={databaseUrl:config.ARCHIVE_DATABASE_URL!,root:config.ARCHIVE_DIR!,documentRoot:config.DOCUMENT_DIR!,organizationDocumentRoot:config.ORG_DOCUMENT_DIR,pgDump:config.PG_DUMP!,pgRestore:config.PG_RESTORE!,tar:config.ARCHIVE_TAR!,drive};
let stopped=false;for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>{stopped=true;});
do{
 try{await archiveTick(options);console.log('Archive worker check completed.');}
 catch{console.error('Archive worker could not complete its check. Verify private configuration and tool permissions.');}
 if(stopped||process.argv.includes('--once'))break;
 await new Promise(resolve=>setTimeout(resolve,60000));
}while(!stopped);
