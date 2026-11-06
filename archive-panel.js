/* Organization-wide archive settings, in the familiar clinical Master screen. */
(function(){
 const R=React,h=R.createElement;
 const box={background:'#fff',border:'1px solid #d9e1e8',borderRadius:10,padding:18,marginBottom:16};
 const input={padding:'8px 10px',border:'1px solid #cbd5df',borderRadius:6,fontSize:13,color:'#253342',background:'#fff'};
 const button={padding:'9px 16px',border:'1px solid #0078b4',borderRadius:7,background:'#0078b4',color:'#fff',cursor:'pointer',fontSize:13};
 const errors={ARCHIVE_FAILED:'Archive failed. Ask the server operator to check the private worker configuration.',REMOTE_DOCUMENT_BACKUP_NOT_CONFIGURED:'Some documents use remote storage. Configure their backup before creating a complete archive.',DOCUMENT_CHECKSUM_MISMATCH:'A document did not match its recorded size or checksum.',WORKER_INTERRUPTED:'The worker stopped before this archive completed.',RETENTION_REVIEW_REQUIRED:'An older archive could not be safely expired. It has been retained.',GOOGLE_DRIVE_CONNECTION_REQUIRED:'Enter a Google Drive folder ID and ask the server operator to connect your Google account. No archive has been uploaded.',GOOGLE_DRIVE_FOLDER_NOT_WRITABLE:'The connected Google account cannot write to this Drive folder.',DESTINATION_NOT_CONFIGURED:'Choose a folder in your personal cloud storage and save its full path.',PRIVATE_DESTINATION_FOLDER_REQUIRED:'Use a full private folder path outside the application source folder.'};
 window.KBArchivePanel=function ArchivePanel(){
  const [data,setData]=R.useState(null),[draft,setDraft]=R.useState(null),[error,setError]=R.useState(''),[notice,setNotice]=R.useState(''),[busy,setBusy]=R.useState(false);
  async function api(method,path,body){const r=await fetch('/api/v1/archives'+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const j=await r.json();if(!r.ok)throw Error(j.error?.message||'Archive settings could not load');return j;}
  async function load(reset){const r=await api('GET','/');setData(r);if(reset)setDraft(r.policy);}
  R.useEffect(()=>{let alive=true;api('GET','/').then(r=>{if(alive){setData(r);setDraft(r.policy);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
  async function save(e){e.preventDefault();setBusy(true);setError('');setNotice('');try{await api('PUT','/policy',{policy:draft,version:data.version});await load(true);setNotice('Archive settings saved.');}catch(e){setError(e.message);}finally{setBusy(false);}}
  async function run(){setBusy(true);setError('');setNotice('');try{await api('POST','/runs',{});await load(false);setNotice('Archive queued. The server worker will process it; use Refresh status to check progress.');}catch(e){setError(e.message);}finally{setBusy(false);}}
  const date=v=>v?new Date(v).toLocaleString('en-IN',{timeZone:data.timezone}):'—';
  const field=(label,props)=>h('label',{style:{display:'grid',gap:6,fontSize:13}},label,h('input',{...props,style:input}));
  if(!data||!draft)return h('section',{style:box},h('h3',null,'Data Archiving'),error?h('p',{role:'alert'},error):h('p',{role:'status'},'Loading archive settings...'));
  const active=data.runs.some(r=>r.status==='queued'||r.status==='running');
  return h('section',{'aria-label':'Organization data archiving'},
   h('h3',{style:{margin:'0 0 8px'}},'Data Archiving'),
   h('p',{style:{fontSize:13,color:'#526273',lineHeight:1.6}},'Recovery copies for this organization and all its clinics, including the database and locally stored patient files. Save to Google Drive or a folder in your personal cloud storage. Live patient records stay available.'),
   error&&h('p',{role:'alert',style:{...box,color:'#a12a21'}},error),notice&&h('p',{role:'status',style:{...box,background:'#effaf4'}},notice),
   h('div',{style:box},h('strong',null,data.worker?.online?'● Archive worker online':'○ Archive worker offline'),
    h('p',{style:{fontSize:13}},'Destination: ',data.worker?.destination||'Not configured on this server'),
    h('p',{style:{fontSize:13,fontWeight:600}},data.worker?.ready?'Destination ready':'Destination needs setup'),
    h('p',{style:{fontSize:12,color:'#526273'}},'Last worker check: '+date(data.worker?.heartbeat_at)+' · '+data.timezone),
    data.worker?.last_error&&h('p',{role:'alert'},errors[data.worker.last_error]||'Worker needs attention: '+data.worker.last_error),
    !data.worker?.online&&h('p',{style:{fontSize:13}},'The server operator must start the archive worker. Scheduled copies require this laptop to be running.')),
   h('form',{onSubmit:save,style:box},
    h('h4',{style:{marginTop:0}},'Storage destination'),
    h('label',{style:{display:'grid',gap:6,fontSize:13,marginBottom:14}},'Store archives in',h('select',{value:draft.destination,style:input,onChange:e=>setDraft({...draft,destination:e.target.value})},h('option',{value:'drive'},'Google Drive — direct upload'),h('option',{value:'folder'},'Personal storage / Google Drive for Desktop folder'))),
    draft.destination==='drive'?field('Google Drive folder ID',{value:draft.driveFolderId,placeholder:'Folder ID from your Google Drive folder link',onChange:e=>setDraft({...draft,driveFolderId:e.target.value.trim()})}):field('Full personal storage folder path on this laptop',{value:draft.folderPath,placeholder:'For example: G:\\My Drive\\Clinic Backups',onChange:e=>setDraft({...draft,folderPath:e.target.value})}),
    h('p',{style:{fontSize:12,color:'#526273',marginBottom:18}},draft.destination==='drive'?'The server operator connects your Google account once; no Google passwords are entered here. Successful uploads are checked against Drive’s file checksum.':'Select a folder managed by your cloud drive application. The archive worker verifies the copied files; your drive application handles cloud synchronization, which must be checked separately.'),
    h('label',{style:{display:'flex',gap:8,alignItems:'center',marginBottom:16}},h('input',{type:'checkbox',checked:draft.enabled,onChange:e=>setDraft({...draft,enabled:e.target.checked})}),'Enable daily archives'),
    h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:16,marginBottom:16}},
     field('Daily archive time',{type:'time',required:true,value:draft.dailyAt,onChange:e=>setDraft({...draft,dailyAt:e.target.value})}),
     field('Keep daily copies for (days)',{type:'number',required:true,min:1,max:3650,value:draft.dailyDays,onChange:e=>setDraft({...draft,dailyDays:Number(e.target.value)})}),
     field('Keep monthly copies (months)',{type:'number',required:true,min:0,max:120,value:draft.monthlyMonths,onChange:e=>setDraft({...draft,monthlyMonths:Number(e.target.value)})})),
    h('p',{style:{fontSize:12,color:'#526273',lineHeight:1.6}},'Times use '+data.timezone+'. Keep one successful copy per represented month, in addition to recent daily copies. If the laptop is off, the next worker check after the scheduled time creates today’s copy. It cannot recreate missed days. Retention removes only expired completed archive copies after a new archive succeeds; live data is never removed.'),
    h('button',{type:'submit',style:button,disabled:busy},busy?'Please wait...':'Save archive settings')),
   h('div',{style:box},h('div',{style:{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}},h('h4',{style:{margin:0,marginRight:'auto'}},'Recent archives'),h('button',{type:'button',style:button,disabled:busy||active||!data.worker?.online||!data.worker?.ready,onClick:run},active?'Archive in progress':'Archive now'),h('button',{type:'button',style:{...button,background:'#fff',color:'#0078b4'},disabled:busy,onClick:()=>load(false).catch(e=>setError(e.message))},'Refresh status')),
    h('p',{style:{fontSize:12,color:'#526273'}},'Complete means the dump catalogue and file checksums passed. Restoration is an operator task and should be rehearsed separately. Archive files are not downloadable through this public demo.'),
    data.runs.length?h('div',{style:{overflowX:'auto'}},h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:13}},
     h('thead',null,h('tr',null,['Created','Type','Status','Files','Size','Result'].map(x=>h('th',{key:x,style:{textAlign:'left',padding:8,borderBottom:'1px solid #d9e1e8'}},x)))),
     h('tbody',null,data.runs.map(r=>h('tr',{key:r.id},h('td',{style:{padding:8}},date(r.created_at)),h('td',null,r.kind==='scheduled'?'Daily':'Manual'),h('td',null,r.status),h('td',null,r.file_count??'—'),h('td',null,r.total_bytes==null?'—':(Number(r.total_bytes)/1048576).toFixed(2)+' MB'),h('td',null,r.error_code?(errors[r.error_code]||r.error_code):r.status==='succeeded'?(r.destination_kind==='drive'?'Drive upload verified':'Folder copy verified; check cloud sync'):r.status==='expired'?'Expired by retention':'—')))))):h('p',null,'No archive attempts yet.')));
 };
})();
