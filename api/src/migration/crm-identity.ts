// CRM saves replace storage rows. Existing data.id remains the passive entity key.
export interface CrmStorageRow {id:string;collection:string;position:number;data:Record<string,unknown>;[key:string]:unknown}
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export function alignCrmStorageRows(source:CrmStorageRow[],target:CrmStorageRow[]){
 const remaining=new Map(target.map(r=>[r.id,r])),rows:CrmStorageRow[]=[];let regenerated=0;
 for(const original of source){
  let current=remaining.get(original.id);
  if(!current){
   const candidates=Array.from(remaining.values()).filter(r=>r.collection===original.collection&&
    (original.data.id!==undefined&&original.data.id!==null&&original.data.id!==''?r.data.id===original.data.id:stable(r.data)===stable(original.data)));
   current=candidates.find(r=>r.position===original.position&&stable(r.data)===stable(original.data))
    ??candidates.find(r=>stable(r.data)===stable(original.data))
    ??(candidates.length===1?candidates[0]:undefined);
  }
  if(!current)throw Error('Missing or ambiguous CRM entity');
  remaining.delete(current.id);if(current.id!==original.id)regenerated++;
  // Restore only the comparison key, not the stored data. Fingerprints still
  // validate every original field/position and approved review transformation.
  rows.push({...current,id:original.id});
 }
 return {rows,additionalRows:remaining.size,regenerated};
}
