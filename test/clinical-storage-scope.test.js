const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const source=html.slice(html.indexOf('function scopedKey(fullKey) {'),html.indexOf('\n}',html.indexOf('function scopedKey(fullKey) {'))+2);
test('local clinical storage keys do not follow a user into another clinic',()=>{
 const ctx={window:{KB_INSTANCE_ID:'main',KB_CLINIC_CONTEXT:{id:'clinic-a'}}}; vm.createContext(ctx); vm.runInContext(source,ctx);
 const first=vm.runInContext('scopedKey("kbdc_master_unlocked")',ctx);
 ctx.window.KB_CLINIC_CONTEXT.id='clinic-b';
 assert.notEqual(vm.runInContext('scopedKey("kbdc_master_unlocked")',ctx),first);
 delete ctx.window.KB_CLINIC_CONTEXT;
 assert.equal(vm.runInContext('scopedKey("kbdc_master_unlocked")',ctx),'kbdc_master_unlocked');
});
