const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const source=html.slice(html.indexOf('function handleAuthFailure(res) {'),html.indexOf('\n}',html.indexOf('function handleAuthFailure(res) {'))+2);
test('auth status metadata does not recursively reopen sign-in',()=>{
 const ctx={cleared:0,opened:0}; vm.createContext(ctx);
 vm.runInContext('function setSessionToken(){cleared++}; var _onAuthRequired=()=>opened++;'+source,ctx);
 vm.runInContext('handleAuthFailure({success:true,authRequired:true,valid:true}); handleAuthFailure({success:true,authRequired:true,valid:false});',ctx);
 assert.equal(ctx.opened,0); assert.equal(ctx.cleared,0);
 vm.runInContext('handleAuthFailure({success:false,authRequired:true});',ctx);
 assert.equal(ctx.opened,1); assert.equal(ctx.cleared,1);
});
