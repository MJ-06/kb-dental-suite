export interface ArchivePolicy {enabled:boolean; dailyAt:string; dailyDays:number; monthlyMonths:number;destination:'drive'|'folder';driveFolderId:string;folderPath:string}
export const DEFAULT_POLICY:ArchivePolicy={enabled:false,dailyAt:'23:00',dailyDays:30,monthlyMonths:12,destination:'drive',driveFolderId:'',folderPath:''};
export function validatePolicy(value:unknown):ArchivePolicy {
 const p=value as ArchivePolicy;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['enabled','dailyAt','dailyDays','monthlyMonths','destination','driveFolderId','folderPath'].includes(k))||
  typeof p.enabled!=='boolean'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(p.dailyAt)||
  !Number.isInteger(p.dailyDays)||p.dailyDays<1||p.dailyDays>3650||
  !Number.isInteger(p.monthlyMonths)||p.monthlyMonths<0||p.monthlyMonths>120||!['drive','folder'].includes(p.destination)||
  typeof p.driveFolderId!=='string'||(p.driveFolderId!==''&&!/^[a-zA-Z0-9_-]{10,200}$/.test(p.driveFolderId))||
  typeof p.folderPath!=='string'||p.folderPath.length>400||/[\u0000-\u001f]/.test(p.folderPath))throw Error('Enter valid archive schedule, retention and destination settings.');
 return {...p};
}
export function archiveClock(now:Date,timezone:string){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const get=(k:string)=>parts.find(p=>p.type===k)!.value;
 return {day:`${get('year')}-${get('month')}-${get('day')}`,month:`${get('year')}-${get('month')}`,time:`${get('hour')}:${get('minute')}`};
}
export function scheduledDay(policy:ArchivePolicy,now:Date,timezone:string,alreadyQueued:string[]){
 const clock=archiveClock(now,timezone);
 return policy.enabled&&clock.time>=policy.dailyAt&&!alreadyQueued.includes(clock.day)?clock.day:null;
}
export interface RetainedArchive {id:string;day:string;status:string}
/** Daily retention is calendar days. Monthly retention keeps the first available
 * successful snapshot in each of the latest N represented months, not N copies
 * from the current month. Failed/in-progress runs are never deletion candidates. */
export function expiredArchives(runs:RetainedArchive[],today:string,policy:ArchivePolicy):string[]{
 const good=runs.filter(r=>r.status==='succeeded').sort((a,b)=>a.day.localeCompare(b.day)||a.id.localeCompare(b.id));
 const monthly=new Map<string,string>();
 for(const r of good)if(!monthly.has(r.day.slice(0,7)))monthly.set(r.day.slice(0,7),r.id);
 const keepMonthly=new Set([...monthly.keys()].sort().reverse().slice(0,policy.monthlyMonths).map(m=>monthly.get(m)!));
 const cutoff=new Date(today+'T00:00:00Z');cutoff.setUTCDate(cutoff.getUTCDate()-policy.dailyDays+1);
 const firstDay=cutoff.toISOString().slice(0,10),latest=good.at(-1)?.id;
 return runs.filter(r=>r.status==='succeeded'&&r.id!==latest&&r.day<firstDay&&!keepMonthly.has(r.id)).map(r=>r.id);
}
