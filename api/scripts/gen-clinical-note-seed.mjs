// The checked-in source is the live Apps Script copy, never a patient export.
import {readFileSync,writeFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../../apps-script/out/Code.gs',import.meta.url),'utf8');
const start=source.indexOf('var CLINICAL_NOTE_SEED = [')+'var CLINICAL_NOTE_SEED = '.length,end=source.indexOf('\n];',start)+2;
if(start<25||end<start)throw Error('Clinical note seed not found');
const rows=runInNewContext(source.slice(start,end),{},{timeout:1000});
if(!Array.isArray(rows)||rows.length!==188||rows.some(r=>r.length!==3||r.some(v=>typeof v!=='string')))throw Error('Unexpected template shape');
writeFileSync(new URL('../src/legacy/clinical-note-seed.ts',import.meta.url),'// Generated from CLINICAL_NOTE_SEED in apps-script/out/Code.gs. No patient data.\nexport const CLINICAL_NOTE_SEED:readonly (readonly string[])[]='+JSON.stringify(rows,null,2)+';\n');
console.log('Generated '+rows.length+' reusable clinical note templates.');
