/* Local-backend edit protection. Never stores form values or sends analytics. */
(function(){
 const pending=new Map(),versions=new Map(),blocking=new Set();let generation=0,dirty=false;
 const reads={getCarePlan:'care',getTreatmentPlan:'treatment',getPatient:'patient',getClinicalSheets:'sheet'};
 const writes={saveCarePlan:'care',saveTreatmentPlan:'treatment',saveRegistration:'patient',saveClinicalSheets:'sheet'};
 const mutation=a=>/^(save|delete|update|queue|mark|start|resolve|append|switch|open|attach|sweep)/.test(a);
 const key=(kind,p)=>[window.KB_CLINIC_CONTEXT?.id||'',kind,String(p.uhid||'').toUpperCase(),p.sheetType||''].join('|');
 const api={
  async run(action,data,send){
   const params={...data},kind=writes[action],scope=kind?key(kind,params):'';
   if(kind&&versions.has(scope)&&params.version===undefined)params.version=versions.get(scope);
   const requestKey=action+'|'+JSON.stringify(params);
   if(mutation(action)&&pending.has(requestKey))return pending.get(requestKey);
   const before=generation;
   const task=(async()=>{
    try{
     const result=await send(params);
     if(result?.success){
      const readKind=reads[action];
      if(readKind&&Number.isSafeInteger(result.version))versions.set(key(readKind,params),result.version);
      if(kind&&Number.isSafeInteger(result.version))versions.set(scope,result.version);
      if((kind||window.KB_ALLOWED_RECORD_ACTIONS?.includes(action))&&before===generation)dirty=false;
     }
     return result;
    }finally{pending.delete(requestKey);blocking.delete(requestKey);}
   })();
   if(mutation(action)){pending.set(requestKey,task);if(!/^(open|attach|switch)/.test(action))blocking.add(requestKey);}
   return task;
  },
  markDirty(){dirty=true;generation++;},
  confirmLeave(){
   if(blocking.size){window.alert('A save is still in progress. Wait for its result before leaving.');return false;}
   if(dirty&&!window.confirm('You have unsaved changes. Leave this screen and discard them?'))return false;
   dirty=false;return true;
  }
 };
 document.addEventListener('input',event=>{if(event.target?.closest?.('[data-edit-scope]'))api.markDirty();},true);
 document.addEventListener('change',event=>{if(event.target?.closest?.('[data-edit-scope]'))api.markDirty();},true);
 window.addEventListener('beforeunload',event=>{if(dirty||blocking.size){event.preventDefault();event.returnValue='';}});
 window.KBSafeWrites=api;
})();
