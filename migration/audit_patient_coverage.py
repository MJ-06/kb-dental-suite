"""Read-only workbook coverage. Patient values remain in memory; only aggregate audit counts are persisted."""
import json,re,datetime as dt,warnings,sys
from pathlib import Path
import openpyxl
warnings.filterwarnings('ignore')
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'api/.organization-demo-runtime/realdata-review'
keys={r['uhid'].replace(' ','').upper() for r in json.loads(sys.stdin.read())}
def norm(v):return re.sub('[^a-z0-9]','',str(v or '').lower())
def text(v):
 if v is None:return ''
 if isinstance(v,dt.datetime):return v.isoformat()
 if isinstance(v,dt.date):return v.isoformat()
 return str(int(v)) if isinstance(v,float) and v.is_integer() else str(v).strip()
ledger={};missing_id=0;scanned=0;tabs=0
for book in sorted((ROOT/'migration/data').glob('*.xlsx')):
 wb=openpyxl.load_workbook(book,read_only=True,data_only=True)
 for sheet in wb.worksheets:
  rows=sheet.iter_rows(values_only=True)
  try:header=next(rows)
  except StopIteration:continue
  hdr=[norm(v) for v in header]
  uid=next((i for i,k in enumerate(hdr) if k in {'uhid','registrationid','uhidregistrationid','registrationno','regid','uhidno'}),None)
  if uid is None:continue
  tabs+=1
  def index(choices):return next((i for i,k in enumerate(hdr) if k in choices),None)
  name=index({'fullname','patientname','patient'});first=index({'firstname'});last=index({'lastname'})
  if name is None and re.search('registra|patient',sheet.title,re.I):name=index({'name'})
  phone=index({'mobile','mobileno','mobilenumber','phone','phoneno','phonenumber','contactno'})
  dob=index({'dob','dateofbirth'});gender=index({'gender','sex'})
  for line,row in enumerate(rows,2):
   def at(i):return text(row[i]) if i is not None and i<len(row) else ''
   u=at(uid).replace(' ','').upper();n=at(name) or (' '.join(v for v in [at(first),at(last)] if v))
   if not any(text(v) for v in row):continue
   scanned+=1
   if not u:
    if n:missing_id+=1
    continue
   record=ledger.setdefault(u,{'uhid':u,'names':set(),'phones':set(),'dobs':set(),'genders':set(),'sources':[]})
   for field,value in [('names',n),('phones',at(phone)),('dobs',at(dob)),('genders',at(gender))]:
    if value:record[field].add(value)
   record['sources'].append({'book':book.name,'sheet':sheet.title,'row':line})
 wb.close()
private=[]
for u,entry in ledger.items():
 if u in keys:continue
 record={k:sorted(v) if isinstance(v,set) else v for k,v in entry.items()}
 record['valid_uhid']=bool(re.fullmatch('[A-Z]{2}(0[1-9]|1[0-2])[0-9]{2,4}',u))
 record['normalized_names']=sorted({re.sub(r'\s+',' ',v).strip().casefold() for v in entry['names']})
 private.append(record)
summary={'existingPatients':len(keys),'workbookTabsScanned':tabs,'sourceRowsScanned':scanned,'extraIdentifiers':len(private),'extraValidIdentifiers':sum(r['valid_uhid'] for r in private),'extraWithOneRecordedName':sum(r['valid_uhid'] and len(r['normalized_names'])==1 for r in private),'extraWithConflictingRecordedNames':sum(r['valid_uhid'] and len(r['normalized_names'])>1 for r in private),'extraWithoutRecordedName':sum(r['valid_uhid'] and not r['names'] for r in private),'namedRowsWithoutIdentifier':missing_id}
summary['extraNonstandardWithOneRecordedName']=sum(not r['valid_uhid'] and len(r['normalized_names'])==1 for r in private)
summary['extraNonstandardWithConflictingNames']=sum(not r['valid_uhid'] and len(r['normalized_names'])>1 for r in private)
summary['extraNonstandardWithoutName']=sum(not r['valid_uhid'] and not r['names'] for r in private)
summary['extraNonstandardNumericOnly']=sum(not r['valid_uhid'] and bool(re.fullmatch('[0-9]+',r['uhid'])) for r in private)
def code_like(u):
 return bool(re.fullmatch('[A-Z]{2}[A-Z0-9 ./_-]{2,30}',u) and re.search('[0-9]',u) and len(re.findall('[A-Z]{2}[0-9]{3,}',u))<=1)
summary['extraNonstandardNamedCodeLike']=sum(not r['valid_uhid'] and len(r['normalized_names'])==1 and code_like(r['uhid']) for r in private)
# Do not persist identifiers or demographic candidate values in audit files.
(OUT/'patient-coverage-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
if '--migration-payload' in sys.argv:
 # This mode is consumed in memory by the private database importer. Never
 # run it directly in a terminal or persist its patient-bearing output.
 def source_date(values):
  if len(values)!=1:return None
  value=values[0]
  for fmt in ('%Y-%m-%d','%Y-%m-%dT%H:%M:%S','%d/%m/%Y'):
   try:return dt.datetime.strptime(value,fmt).date().isoformat()
   except ValueError:pass
  return None
 recovered=[]
 for r in private:
  if len(r['normalized_names'])!=1 or not (r['valid_uhid'] or code_like(r['uhid'])):continue
  g=r['genders'][0].strip().lower() if len(r['genders'])==1 else ''
  recovered.append({'uhid':r['uhid'],'name':r['names'][0],'mobile':r['phones'][0] if len(r['phones'])==1 else None,'dob':source_date(r['dobs']),'gender':{'male':'Male','m':'Male','female':'Female','f':'Female','other':'Other'}.get(g),'provenance':{'review_required':True,'identity_source':'historical_record_only','registration_date_source':'import_timestamp_not_registration','source_refs':r['sources'],'recorded_names':r['names'],'recorded_phones':r['phones'],'recorded_dobs':r['dobs'],'recorded_genders':r['genders'],'identifier_format':'standard' if r['valid_uhid'] else 'legacy_needs_review'}})
 print(json.dumps({'summary':summary,'patients':recovered},ensure_ascii=False))
else:print(json.dumps(summary))
