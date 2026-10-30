"""Loads the rest of the clinic's .xlsx exports (phase 2), after import_sheets.py.

    uv run --with openpyxl --with "psycopg[binary]" python -X utf8 migration/import_sheets_2.py \
        --data migration/data --clinic kb [--wipe]

Covers: master lists and settings, procedure library, treatment cases and plans,
clinical forms (from "KB Dental — Clinical Records.xlsx"), clinical sheets, CRM,
patient documents (files copied from the Drive zip into a rehearsal folder).
Same safety rules as phase 1: rehearsal database only, one transaction, a savepoint
per row, and a rejects file instead of silent drops.
"""
import argparse, collections, csv, datetime as dt, json, re, secrets, sys, warnings, zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

warnings.filterwarnings("ignore")
import openpyxl
import psycopg

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--clinic", default="kb")
ap.add_argument("--wipe", action="store_true")
args = ap.parse_args()
DATA = Path(args.data); OUT = DATA / "out"; OUT.mkdir(exist_ok=True)
TZ = ZoneInfo("Asia/Kolkata")

env = {}
for line in (Path.home() / ".kb-pms" / "owner.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
url = env.get("REHEARSAL_OWNER_DATABASE_URL")
if not url or not re.search(r"@(localhost|127\.0\.0\.1)(:\d+)?/kb_rehearsal$", url):
    sys.exit("Refusing: need REHEARSAL_OWNER_DATABASE_URL pointing at kb_rehearsal on localhost")
DOC_ROOT = Path.home() / ".kb-pms" / "documents-rehearsal"

def load(book, tab):
    wb = openpyxl.load_workbook(DATA / book, read_only=True, data_only=True)
    if tab not in wb.sheetnames: return [], []
    rows = list(wb[tab].iter_rows(values_only=True))
    if not rows: return [], []
    hdr = [str(c or "").strip() for c in rows[0]]
    body = [tuple(r) + (None,) * max(40 - len(r), len(hdr) - len(r), 0) for r in rows[1:] if any(c not in (None, "") for c in r)]
    return hdr, body
def s(v):
    if v is None: return ""
    if isinstance(v, dt.datetime): return v.strftime("%Y-%m-%d %H:%M:%S") if (v.hour or v.minute or v.second) else v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v == int(v): return str(int(v))
    return str(v).strip()
def uhid(v): return s(v).upper().replace(" ", "")
def num(v):
    try: return float(v) if v not in (None, "") else None
    except (TypeError, ValueError): return None
def when(v):
    if isinstance(v, dt.datetime): return v.replace(tzinfo=TZ) if v.tzinfo is None else v
    t = s(v)
    try: return dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError: return None
def maybe_json(v):
    t = s(v)
    if t[:1] in "[{":
        try: return json.loads(t)
        except ValueError: pass
    return s(v) if not isinstance(v, (int, float)) else v

rejects = []; counts = {}
def reject(table, key, reason): rejects.append({"table": table, "row": key, "reason": reason})

PMS, CLIN = "K. B. DENTAL SUITE - PMS.xlsx", "KB Dental — Clinical Records.xlsx"
with psycopg.connect(url, autocommit=False) as conn:
    cur = conn.cursor()
    cur.execute("SELECT id FROM clinics WHERE code = %s", (args.clinic,))
    cid = cur.fetchone()[0]
    cur.execute("SELECT set_config('app.clinic_id', %s, false)", (str(cid),))
    if args.wipe:
        for t in ("crm_records", "crm_lead_inbox", "patient_documents", "clinical_records", "clinical_sheets", "treatment_cases", "treatment_plans",
                  "procedure_library", "pick_lists", "treatments", "medicines", "implant_brands", "appointment_reasons", "panel_rates", "holidays", "staff"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("DELETE FROM clinic_settings WHERE key IN ('clinic_profile','week_off')")
    cur.execute("SELECT upper(uhid), id FROM patients"); pid = dict(cur.fetchall())
    cur.execute("SELECT upper(name), id FROM panels"); panels = dict(cur.fetchall())

    def one(sql, params, table, key):
        cur.execute("SAVEPOINT r")
        try:
            cur.execute(sql, params); cur.execute("RELEASE SAVEPOINT r"); return True
        except psycopg.Error as e:
            cur.execute("ROLLBACK TO SAVEPOINT r"); reject(table, key, str(e).splitlines()[0][:160]); return False
    def tally(name, total, ok): counts[name] = (total, ok)

    # ── pick lists ──
    for tab, lst in (("Expense Categories", "expense_category"), ("Expense Payers", None), ("Document Categories", "document_category"),
                     ("Medicine Dosages", "medicine_dosage"), ("Medicine Frequencies", "medicine_frequency"),
                     ("Medicine Durations", "medicine_duration"), ("Medicine Notes", "medicine_note"), ("Payment Modes", "payment_mode")):
        if not lst: continue
        _, rows = load(PMS, tab); ok = 0
        for i, r in enumerate(rows): ok += one("INSERT INTO pick_lists (list_name, value, sort_order) VALUES (%s,%s,%s)", (lst, s(r[0]), i), tab, s(r[0]))
        tally(tab, len(rows), ok)
    for tab, lst in (("Medicine Instructions", "medicine_instruction"), ("Clinical Note Templates", "clinical_note_template")):
        _, rows = load(PMS, tab); ok = 0
        for i, r in enumerate(rows):
            ok += one("INSERT INTO pick_lists (list_name, value, data, sort_order) VALUES (%s,%s,%s::jsonb,%s)",
                      (lst, s(r[0]), json.dumps({"text": s(r[1]), "category": s(r[2])}), i), tab, s(r[0])[:40])
        tally(tab, len(rows), ok)

    # ── named masters ──
    _, rows = load(PMS, "Treatments Master"); ok = 0
    for i, r in enumerate(rows): ok += one("INSERT INTO treatments (name, fee, department, sort_order) VALUES (%s,%s,%s,%s)", (s(r[0]), num(r[1]), s(r[2]) or None, i), "treatments", s(r[0]))
    tally("Treatments Master", len(rows), ok)
    _, rows = load(PMS, "Medicines Master"); ok = 0
    for i, r in enumerate(rows): ok += one("INSERT INTO medicines (name, default_dosage, default_frequency, sort_order) VALUES (%s,%s,%s,%s)", (s(r[0]), s(r[1]) or None, s(r[2]) or None, i), "medicines", s(r[0]))
    tally("Medicines Master", len(rows), ok)
    _, rows = load(PMS, "Implant Brands"); ok = 0
    for i, r in enumerate(rows): ok += one("INSERT INTO implant_brands (name, sizes, sort_order) VALUES (%s,%s,%s)", (s(r[0]), [x.strip() for x in s(r[1]).split(",") if x.strip()], i), "implant_brands", s(r[0]))
    tally("Implant Brands", len(rows), ok)
    _, rows = load(PMS, "Appointment Reasons"); ok = 0
    for i, r in enumerate(rows): ok += one("INSERT INTO appointment_reasons (name, sort_order) VALUES (%s,%s)", (s(r[0]), i), "appointment_reasons", s(r[0]))
    tally("Appointment Reasons", len(rows), ok)
    _, rows = load(PMS, "Employees"); ok = 0
    for r in rows: ok += one("INSERT INTO staff (name, phone, email, role) VALUES (%s,%s,%s,%s)", (s(r[0]), s(r[1]) or None, s(r[2]) or None, s(r[3]) or None), "staff", s(r[0]))
    tally("Employees", len(rows), ok)
    _, rows = load(PMS, "Doctor Details")
    for r in rows:
        cur.execute("SAVEPOINT r")
        try: cur.execute("UPDATE doctors SET role = %s WHERE lower(name) = lower(%s)", (s(r[3]) or None, s(r[0]))); cur.execute("RELEASE SAVEPOINT r")
        except psycopg.Error: cur.execute("ROLLBACK TO SAVEPOINT r")
    _, rows = load(PMS, "Panel Rates"); ok = 0
    for i, r in enumerate(rows):
        pn = s(r[0]).upper()
        if pn not in panels:
            cur.execute("INSERT INTO panels (name) VALUES (%s) RETURNING id", (s(r[0]),)); panels[pn] = cur.fetchone()[0]
        ok += one("INSERT INTO panel_rates (panel_id, code, procedure, rate, classification, sort_order) VALUES (%s,%s,%s,%s,%s,%s)",
                  (panels[pn], s(r[1]), s(r[2]) or None, num(r[3]), s(r[4]), i), "panel_rates", f"{pn} {s(r[1])}")
    tally("Panel Rates", len(rows), ok)
    _, rows = load(PMS, "Procedure Library"); ok = 0
    for i, r in enumerate(rows):
        ok += one("""INSERT INTO procedure_library (ord, procedure_code, procedure_name, family_code, visits_min, visits_max, sequence_no, stage_type, stage_code, stage_name, completes_treatment)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (i, s(r[0]), s(r[1]), s(r[2]), int(num(r[3]) or 0), int(num(r[4]) or 0), int(num(r[5]) or 0), s(r[6]), s(r[7]), s(r[8]), s(r[9]).lower() in ("yes", "true", "1", "y")), "procedure_library", f"{s(r[0])}/{s(r[7])}")
    tally("Procedure Library", len(rows), ok)

    # ── settings ──
    _, rows = load(PMS, "Clinic Profile")
    prof = {s(r[0]): s(r[1]) for r in rows if s(r[0])}
    if prof: cur.execute("INSERT INTO clinic_settings (key, value) VALUES ('clinic_profile', %s::jsonb) ON CONFLICT (clinic_id, key) DO UPDATE SET value = EXCLUDED.value", (json.dumps(prof),))
    _, rows = load(PMS, "Working Days"); off = []; ok = 0
    for r in rows:
        if s(r[0]).lower().startswith("week"):
            n = num(r[1]);
            if n is not None: off.append(int(n))
        elif s(r[0]).lower().startswith("holiday"):
            d = when(r[1])
            if d: ok += one("INSERT INTO holidays (holiday_date, name) VALUES (%s,%s) ON CONFLICT DO NOTHING", (d.date(), s(r[2])), "holidays", s(r[1]))
    cur.execute("INSERT INTO clinic_settings (key, value) VALUES ('week_off', %s::jsonb) ON CONFLICT (clinic_id, key) DO UPDATE SET value = EXCLUDED.value", (json.dumps(sorted(set(off))),))
    tally("Working days (holidays)", len(rows), ok)

    # ── treatment cases and plans ──
    _, rows = load(PMS, "Treatment Cases"); ok = 0
    for r in rows:
        stages = maybe_json(r[11]); stages = stages if isinstance(stages, list) else []
        status = "completed" if s(r[7]).lower().startswith("complet") else "in_progress"
        u = uhid(r[1])
        ok += one("""INSERT INTO treatment_cases (case_ref, uhid, patient_id, patient_name, procedure_code, procedure_name, family_code, tooth_ref, case_status, opened_at, closed_at, visit_counter, stages)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                  (s(r[0]), u, pid.get(u), s(r[2]) or None, s(r[3]), s(r[4]), s(r[5]), s(r[6]) or None, status, when(r[8]) or dt.datetime.now(TZ), when(r[9]),
                   int(num(r[10]) or 0), json.dumps(stages)), "treatment_cases", s(r[0]))
    tally("Treatment Cases", len(rows), ok)
    _, rows = load(PMS, "Treatment Plans"); ok = 0
    for r in rows:
        u = uhid(r[0]); ok += one("INSERT INTO treatment_plans (uhid, patient_id, patient_name, plan_date, plan_rows, estimate) VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb)",
                                  (u, pid.get(u), s(r[1]) or None, s(r[2]) or None, json.dumps(maybe_json(r[3])), json.dumps(maybe_json(r[4]))), "treatment_plans", u)
    tally("Treatment Plans", len(rows), ok)

    # ── plan amounts the old balances were built from (Finance sheet) ──
    # The old "Balance Sheet" measured receipts against "Plan (Amount)", which the
    # Finance book keeps on its own "Working for Balance" tab. The new balances read
    # a treatment plan's estimate total, so those amounts become estimates here.
    # A patient who already has a real plan above keeps it.
    FIN = "K. B. Dental - Finance Sheet.xlsx"
    _, rows = load(FIN, "Working for Balance")
    plans = collections.OrderedDict()
    for r in rows:
        u = uhid(r[0]); amt = num(r[3])
        if u and amt is not None: plans.setdefault(u, []).append({"treatment": s(r[2]), "amount": amt})
    cur.execute("SELECT uhid FROM treatment_plans"); have = {x[0].upper() for x in cur.fetchall()}
    ok = 0
    for u, items in plans.items():
        if u in have: continue
        est = {"total": sum(i["amount"] for i in items), "items": items, "source": "Finance sheet, Working for Balance"}
        ok += one("INSERT INTO treatment_plans (uhid, patient_id, patient_name, estimate) VALUES (%s,%s,%s,%s::jsonb)", (u, pid.get(u), None, json.dumps(est)), "treatment_plans", u)
    tally("Plan amounts (Working for Balance)", len(plans), ok)
    _, bal = load(FIN, "Balance Sheet")
    sheet_plan = {uhid(r[0]): num(r[3]) or 0 for r in bal if uhid(r[0])}
    mismatch = [u for u in sheet_plan if abs(sheet_plan[u] - sum(i["amount"] for i in plans.get(u, []))) > 0.5]
    counts["Balance Sheet plan vs imported plan: patients that differ"] = (len(sheet_plan), len(mismatch))
    with open(OUT / "review-plan-mismatch.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["uhid", "balance_sheet_plan", "working_for_balance_total"])
        [w.writerow([u, sheet_plan[u], sum(i["amount"] for i in plans.get(u, []))]) for u in mismatch]

    # ── clinical forms ──
    wb = openpyxl.load_workbook(DATA / CLIN, read_only=True, data_only=True)
    unreg = collections.Counter()
    for tab in wb.sheetnames:
        if tab.startswith("Clinical Sheets") or tab == "Sheet1": continue
        hdr, rows = load(CLIN, tab)
        if not rows: continue
        ui = next((i for i, h in enumerate(hdr) if h.upper().startswith("UHID")), None)
        if ui is None: reject("clinical_records", tab, "tab has no UHID column"); continue
        ok = 0
        for i, r in enumerate(rows, 2):
            u = uhid(r[ui])
            if not u: reject("clinical_records", f"{tab} row {i}", "no UHID"); continue
            if u not in pid: unreg[(tab, u)] += 1
            fields = {h: s(r[j]) for j, h in enumerate(hdr) if h}
            ok += one("INSERT INTO clinical_records (tab_name, uhid, patient_id, fields, recorded_at) VALUES (%s,%s,%s,%s::jsonb,%s)",
                      (tab, u, pid.get(u), json.dumps(fields), when(r[0]) or dt.datetime.now(TZ)), "clinical_records", f"{tab} row {i}")
        tally(f"Clinical: {tab}", len(rows), ok)
    for tab in [t for t in wb.sheetnames if t.startswith("Clinical Sheets")]:
        hdr, rows = load(CLIN, tab); ok = 0
        for r in rows:
            u = uhid(r[0]); data = maybe_json(r[3])
            ok += one("""INSERT INTO clinical_sheets (uhid, patient_id, patient_name, sheet_type, all_teeth) VALUES (%s,%s,%s,%s,%s::jsonb)
                         ON CONFLICT (clinic_id, uhid, sheet_type) DO UPDATE SET all_teeth = EXCLUDED.all_teeth""",
                      (u, pid.get(u), s(r[1]) or None, s(r[2]), json.dumps(data)), "clinical_sheets", f"{tab} {u}")
        if rows: tally(f"Clinical sheets: {tab}", len(rows), ok)

    # ── registration day: first appearance of the patient's data ──
    # A patient whose sheets carry no timestamp was dated to the first of their UHID's month. If
    # their earliest daily-register visit, appointment, receipt or clinical record falls in that
    # month (or earlier), that day is the better registration day. Data that first appears in a
    # later month says nothing about when they registered, so the UHID month stays.
    cur.execute("""
        WITH first AS (
          SELECT p.id,
                 least((SELECT min(visit_date) FROM daily_register d WHERE d.patient_id = p.id),
                       (SELECT min((starts_at AT TIME ZONE 'Asia/Kolkata')::date) FROM appointments a WHERE a.patient_id = p.id),
                       (SELECT min(receipt_date) FROM receipts r WHERE r.patient_id = p.id),
                       (SELECT min((recorded_at AT TIME ZONE 'Asia/Kolkata')::date) FROM clinical_records c WHERE c.patient_id = p.id)) AS d
            FROM patients p JOIN patient_registrations pr ON pr.patient_id = p.id
           WHERE pr.form->>'reg_date_source' = 'uhid_month'
        ), moved AS (
          UPDATE patients SET registered_on = (f.d + time '10:00') AT TIME ZONE 'Asia/Kolkata'
            FROM first f
           WHERE patients.id = f.id AND f.d IS NOT NULL
             AND date_trunc('month', f.d) <= date_trunc('month', patients.registered_on AT TIME ZONE 'Asia/Kolkata')
          RETURNING patients.id)
        UPDATE patient_registrations SET form = form || '{"reg_date_source":"first_data"}'::jsonb
         WHERE patient_id IN (SELECT id FROM moved)""")
    cur.execute("SELECT count(*) FILTER (WHERE form->>'reg_date_source' = 'first_data'), count(*) FILTER (WHERE form->>'reg_date_source' = 'uhid_month'), count(*) FILTER (WHERE form->>'reg_date_source' = 'timestamp') FROM patient_registrations")
    a, b, c = cur.fetchone(); counts["Registration day (first data / UHID month / recorded)"] = (a, f"{b} / {c}")

    # ── CRM ──
    pos = 0
    for coll in ("pipelines", "leads", "contacts", "companies", "followups", "products", "activities", "payments", "sources"):
        hdr, rows = load(PMS, "CRM " + coll.capitalize()); ok = 0
        for i, r in enumerate(rows):
            data = {h: maybe_json(r[j]) for j, h in enumerate(hdr) if h and s(r[j]) != ""}
            if not data: continue
            ok += one("INSERT INTO crm_records (collection, position, data) VALUES (%s,%s,%s::jsonb)", (coll, i, json.dumps(data, default=str)), "crm_records", f"{coll} {i}")
        if rows: tally(f"CRM {coll}", len(rows), ok)
    hdr, rows = load(PMS, "CRM Lead Inbox"); ok = 0
    for r in rows:
        ok += one("""INSERT INTO crm_lead_inbox (inbox_ref, uhid, name, mobile, panel, panel_category, card_id, referred_by, referred_by_type, taken_at)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (s(r[0]), s(r[1]) or None, s(r[2]) or None, s(r[3]) or None, s(r[4]) or None, s(r[5]) or None, s(r[6]) or None, s(r[7]) or None, s(r[8]) or None, when(r[10])), "crm_lead_inbox", s(r[0]))
    tally("CRM lead inbox", len(rows), ok)

    # ── patient documents: copy files from the Drive zip ──
    hdr, rows = load(PMS, "Patient Documents"); ok = 0
    zips = list(DATA.glob("KB Dental - Patient Documents*.zip"))
    names = {}
    for z in zips:
        zf = zipfile.ZipFile(z)
        for info in zf.infolist():
            if not info.is_dir(): names[Path(info.filename).name.lower()] = (zf, info)
    missing = 0
    for r in rows:
        fname = s(r[2]); u = uhid(r[1]); hit = names.get(Path(fname).name.lower())
        if not hit:
            missing += 1; reject("patient_documents", fname[:40], "file is not in the Drive zip"); continue
        key = f"{cid}/{secrets.token_hex(16)[:8]}-{secrets.token_hex(16)[:4]}-{secrets.token_hex(16)[:4]}-{secrets.token_hex(16)[:4]}-{secrets.token_hex(16)[:12]}"
        data = hit[0].read(hit[1])
        # key must be "<clinic uuid>/<document uuid>"
        import uuid
        key = f"{cid}/{uuid.uuid4()}"
        path = DOC_ROOT / key; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        ok += one("INSERT INTO patient_documents (uhid, patient_id, file_name, mime_type, category, storage_key, size_bytes, uploaded_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                  (u, pid.get(u), fname, s(r[3]) or "application/octet-stream", s(r[4]) or "Other", key, len(data), when(r[7]) or dt.datetime.now(TZ)), "patient_documents", fname[:40])
    tally("Patient documents", len(rows), ok)
    conn.commit()

with open(OUT / "rejects-phase2.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["table", "row", "reason"]); w.writeheader(); w.writerows(rejects)
with open(OUT / "review-unregistered-clinical.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["tab", "uhid", "rows"]); [w.writerow([t, u, n]) for (t, u), n in sorted(unreg.items())]
print("loaded (sheet rows, loaded):")
for k, v in counts.items(): print(f"  {k}: {v[0]} -> {v[1]}")
print("rejects:", len(rejects), dict(collections.Counter(r["table"] for r in rejects)), "| clinical rows for unregistered UHIDs:", sum(unreg.values()), f"({len({u for _, u in unreg})} patients)")
