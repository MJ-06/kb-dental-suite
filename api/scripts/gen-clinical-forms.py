import re, json, sys
src = open('apps-script/out/Code.gs', encoding='utf-8').read()
forms = re.findall(r'function (save\w+)\(p\) \{\s*return saveClinicalRecord\(\{\s*tabName: "([^"]+)",\s*fields: \{(.*?)\n    \}\n  \}\);\n\}', src, re.S)
out = []
for name, tab, body in forms:
    lines = [l.strip().rstrip(',') for l in body.strip().splitlines()]
    pairs = []
    for l in lines:
        m = re.fullmatch(r'"([^"]+)": p\.(\w+) \|\| ""', l)
        if not m:
            sys.exit(f"unmapped line in {name}: {l}")
        pairs.append((m.group(1), m.group(2)))
    out.append((name, tab, pairs))
# canonical column order from setupClinicalRecordTabs
setup = {}
blk = src[src.index('function setupClinicalRecordTabs'):src.index('var ss = SpreadsheetApp.openById(CLINICAL_SHEET_ID);')]
for m in re.finditer(r'\{ tabName: "([^"]+)", fields: \[(.*?)\] \}', blk, re.S):
    setup[m.group(1)] = re.findall(r'"([^"]*)"', m.group(2))
print(len(out), len(setup), file=sys.stderr)
def q(s): return json.dumps(s, ensure_ascii=False)
ts = ['// GENERATED from the live Apps Script (apps-script/out/Code.gs): the clinic\'s flat record',
      '// forms. Each save action stores one row on a tab; "fields" maps the sheet\'s own',
      '// column heading to the parameter the screen sends. Do not edit by hand.',
      '', 'export interface RecordForm {', '  tab: string;', '  fields: ReadonlyArray<readonly [heading: string, param: string]>;', '}', '',
      'export const RECORD_FORMS: Readonly<Record<string, RecordForm>> = {']
for name, tab, pairs in out:
    ts.append(f'  {name}: {{ tab: {q(tab)}, fields: [')
    for h, p in pairs: ts.append(f'    [{q(h)}, {q(p)}],')
    ts.append('  ] },')
ts.append('};'); ts.append('')
ts.append('/** The column headings each tab has had since the sheet was set up, in order. */')
ts.append('export const RECORD_HEADINGS: Readonly<Record<string, readonly string[]>> = {')
for tab, hs in setup.items():
    ts.append(f'  {q(tab)}: [' + ', '.join(q(h) for h in hs) + '],')
ts.append('};'); ts.append('')
ts.append('/** Every tab getClinicalRecords will read: the forms above plus the four historical flat tabs and the prescriptions. */')
ts.append('export const RECORD_TABS: ReadonlySet<string> = new Set([')
tabs = []
for _, tab, _p in out: tabs.append(tab)
for t in ["RCT","Implant Surgery","Implant Prosthetic","Crown & Bridge","Prescriptions"]:
    if t not in tabs: tabs.append(t)
ts.append('  ' + ', '.join(q(t) for t in tabs))
ts.append(']);'); ts.append('')
open('api/src/legacy/clinical-forms.ts','w',encoding='utf-8',newline='\n').write('\n'.join(ts))
