"""Loads the clinic's .xlsx exports into the new schema (phase 1).

    uv run --with openpyxl --with "psycopg[binary]" python -X utf8 migration/import_sheets.py \
        --data migration/data --clinic kb --name "K.B. Dental" [--wipe]

Covers: doctors, chairs, panels, patients (+ registration forms), appointments,
daily register, receipts (e-receipts plus manual lines), expenses.
Not yet: clinical forms, treatment cases, CRM, masters lists, documents.

Safety:
  * Connects with REHEARSAL_OWNER_DATABASE_URL from ~/.kb-pms/owner.env and
    refuses any database that is not named kb_rehearsal on localhost.
  * One transaction: a failure leaves nothing behind. Each row also runs in a
    savepoint, so a bad row lands in out/rejects.csv instead of stopping the load.
  * Nothing is merged or renumbered silently. Duplicate UHIDs, UHIDs with no
    registration, unparseable dates and the receipt matching are written to
    out/*.csv (these contain patient details: keep them out of git).
"""
import argparse, collections, csv, datetime as dt, os, re, sys, warnings
from pathlib import Path
from zoneinfo import ZoneInfo

warnings.filterwarnings("ignore")
import openpyxl
import psycopg

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--clinic", default="kb")
ap.add_argument("--name", default="K.B. Dental")
ap.add_argument("--receipt-scheme", default="fy", choices=["fy", "sequential"], help="how new receipts are numbered; fy continues the yy-yy/n numbers")
ap.add_argument("--wipe", action="store_true", help="delete this clinic's rows in the rehearsal DB first")
args = ap.parse_args()
DATA = Path(args.data)
OUT = DATA / "out"; OUT.mkdir(exist_ok=True)
TZ = ZoneInfo("Asia/Kolkata")

# ── connection ──────────────────────────────────────────────
env = {}
for line in (Path.home() / ".kb-pms" / "owner.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
url = env.get("REHEARSAL_OWNER_DATABASE_URL")
if not url or not re.search(r"@(localhost|127\.0\.0\.1)(:\d+)?/kb_rehearsal$", url):
    sys.exit("Refusing: need REHEARSAL_OWNER_DATABASE_URL pointing at kb_rehearsal on localhost")

# ── helpers ─────────────────────────────────────────────────
def load(book, tab):
    wb = openpyxl.load_workbook(DATA / book, read_only=True, data_only=True)
    rows = list(wb[tab].iter_rows(values_only=True))
    return [tuple(r) + (None,) * (40 - len(r)) for r in rows[1:] if any(c not in (None, "") for c in r)]
def s(v):
    if v is None: return ""
    if isinstance(v, float) and v == int(v): return str(int(v))
    return str(v).strip()
def uhid(v): return s(v).upper().replace(" ", "")
def mobile(v):
    """Strip spaces, +, -; drop a leading 91 or 0 when 10 digits remain; else keep what the sheet had."""
    raw = s(v)
    d = re.sub(r"[\s+\-().]", "", raw)
    if re.fullmatch(r"\d+", d):
        if len(d) == 12 and d.startswith("91"): d = d[2:]
        elif len(d) == 11 and d.startswith("0"): d = d[1:]
        if len(d) == 10: return d
    return raw
def num(v):
    try: return round(float(v), 2) if v not in (None, "") else 0.0
    except (TypeError, ValueError): return 0.0
def day(v):
    if isinstance(v, dt.datetime): return v.date()
    if isinstance(v, dt.date): return v
    return parse_date(s(v))
def parse_date(t):
    t = t.strip()
    if re.match(r"^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$", t): return None   # two-digit year: never guess the century
    for f in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%d-%b-%Y"):
        try: return dt.datetime.strptime(t[:len(t)], f).date()
        except ValueError: pass
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", t)
    return dt.date(int(m[1]), int(m[2]), int(m[3])) if m else None
def parse_time(v):
    if isinstance(v, dt.datetime): return v.time()
    if isinstance(v, dt.time): return v
    t = s(v).upper()
    m = re.match(r"^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(AM|PM)?$", t)
    if not m: return None
    h, mi = int(m[1]), int(m[2])
    if m[3] == "PM" and h < 12: h += 12
    if m[3] == "AM" and h == 12: h = 0
    return dt.time(h, mi) if h < 24 and mi < 60 else None
def at(d, t): return dt.datetime.combine(d, t, tzinfo=TZ)
def yes(v): return s(v).lower() in ("yes", "y", "true", "1")
def split(v): return [x.strip() for x in re.split(r"[,;\n]", s(v)) if x.strip() and x.strip().lower() not in ("none", "no", "nil", "na", "n/a")]

rejects, dup_rows, orphans, date_issues, notes, overlaps, bad_uhids = [], [], [], [], [], [], []
def reject(table, key, reason): rejects.append({"table": table, "row": key, "reason": reason})
counts = {}

with psycopg.connect(url, autocommit=False) as conn:
    cur = conn.cursor()
    cur.execute("SELECT current_database()")
    assert cur.fetchone()[0] == "kb_rehearsal"
    cur.execute("SELECT id FROM clinics WHERE code = %s", (args.clinic,))
    row = cur.fetchone()
    if row: cid = row[0]
    else:
        cur.execute("INSERT INTO clinics (code, name, uhid_scheme, timezone) VALUES (%s, %s, 'year-month', 'Asia/Kolkata') RETURNING id", (args.clinic, args.name))
        cid = cur.fetchone()[0]
    cur.execute("UPDATE clinics SET receipt_scheme = %s WHERE id = %s", (args.receipt_scheme, cid))
    cur.execute("SELECT set_config('app.clinic_id', %s, false)", (str(cid),))
    if args.wipe:
        for t in ("clinical_records", "clinical_sheets", "treatment_plans", "treatment_cases", "patient_documents", "consents", "care_plans", "receipts", "expenses", "daily_register", "appointments", "patient_registrations", "uhid_reservations", "patients", "panel_rates", "panels", "doctors", "chairs"):
            cur.execute(f"DELETE FROM {t}")
        cur.execute("DELETE FROM receipt_counters"); cur.execute("DELETE FROM uhid_counters")

    def one(sql, params, table, key):
        """Run an insert in a savepoint; a failing row is rejected, not fatal."""
        cur.execute("SAVEPOINT r")
        try:
            cur.execute(sql, params)
            res = cur.fetchone() if cur.description else None
            cur.execute("RELEASE SAVEPOINT r")
            return res
        except psycopg.Error as e:
            cur.execute("ROLLBACK TO SAVEPOINT r")
            reject(table, key, str(e).splitlines()[0][:160])
            return None

    PMS, FIN, EMP = "K. B. DENTAL SUITE - PMS.xlsx", "K. B. Dental - Finance Sheet.xlsx", "KB Dental — PMS Empaneled.xlsx"

    # ── masters this load needs ──
    doctors, chairs, panels = {}, {}, {}
    def doctor(name):
        name = s(name)
        if not name: return None
        if name.lower() not in doctors:
            r = one("INSERT INTO doctors (name) VALUES (%s) RETURNING id", (name,), "doctors", name)
            doctors[name.lower()] = r[0] if r else None
        return doctors[name.lower()]
    def chair(name):
        name = s(name)
        if not name: return None
        if name.lower() not in chairs:
            r = one("INSERT INTO chairs (name) VALUES (%s) RETURNING id", (name,), "chairs", name)
            chairs[name.lower()] = r[0] if r else None
        return chairs[name.lower()]
    def panel(name):
        name = s(name)
        if not name: return None
        if name.lower() not in panels:
            r = one("INSERT INTO panels (name) VALUES (%s) RETURNING id", (name,), "panels", name)
            panels[name.lower()] = r[0] if r else None
        return panels[name.lower()]
    for r in load(PMS, "Doctor Details"):
        d = doctor(r[0])
        if d: cur.execute("UPDATE doctors SET phone = %s, email = %s WHERE id = %s", (s(r[1]) or None, s(r[2]) or None, d))
    for r in load(PMS, "Chairs"): chair(r[0])
    for r in load(PMS, "Panels"): panel(r[0])

    # ── patients ──
    reg_rows = [("main", r) for r in load(PMS, "Registrations")] + [("panel-book", r) for r in load(EMP, "Registrations")]
    groups = collections.OrderedDict()
    for src, r in reg_rows:
        u = uhid(r[1])
        if not u: reject("patients", f"{src}: {s(r[2])}", "no UHID"); continue
        groups.setdefault(u, []).append((src, r))
    FIELDS = {"name": 2, "gender": 3, "dob": 4, "mobile": 9}
    def norm(v): return re.sub(r"[^a-z0-9]", "", (str(day(v)) if isinstance(v, (dt.datetime, dt.date)) else s(v)).lower())
    pid = {}
    for u, items in groups.items():
        items.sort(key=lambda x: (x[1][0] is None, x[1][0] if isinstance(x[1][0], dt.datetime) else dt.datetime.max))
        src, r = items[-1]          # a repeat UHID is a deliberate re-registration: the latest row is current
        if len(items) > 1:
            diff = [k for k in ("name", "gender", "dob") if len({norm(x[1][FIELDS[k]]) for x in items}) > 1]
            if diff:                # only a different name, gender or date of birth needs a person
                dup_rows.append({"uhid": u, "copies": len(items), "differs_in": ",".join(diff), "kept": "latest",
                                 "names": " || ".join(s(x[1][2]) for x in items), "genders": " || ".join(s(x[1][3]) for x in items),
                                 "dobs": " || ".join(s(x[1][4]) for x in items)})
        if not re.match(r"^A[A-L](0[1-9]|1[0-2])\d{2,3}$", u): bad_uhids.append({"uhid": u, "why": "not year letters AA-AL + month 01-12 + 2-3 digit count"})
        dob_raw = r[4]; dob = day(dob_raw) if dob_raw not in (None, "") else None
        if s(dob_raw).lower() in ("not known", "unknown", "na", "n/a", "-"): dob = None
        elif dob_raw not in (None, "") and (dob is None or dob < dt.date(1900, 1, 2) or dob > dt.date.today()):
            date_issues.append({"uhid": u, "field": "date_of_birth", "value": s(dob_raw)}); dob = None
        ptype = "Panel" if s(r[33]).lower() == "panel" else "Normal"
        pn = panel(r[34]) if ptype == "Panel" else None
        if ptype == "Panel" and not pn: ptype = "Normal"; notes.append(f"{u}: Panel patient with no panel name, imported as Normal")
        cat = s(r[35]) if s(r[35]) in ("Serving", "Pensioner") else None
        ts = r[0] if isinstance(r[0], dt.datetime) else None
        status = "Quick" if s(r[31]).lower() == "quick" else "Complete"
        res = one("""INSERT INTO patients (uhid, full_name, gender, date_of_birth, blood_group, occupation, marital_status, address,
                       mobile, whatsapp, email, emergency_name, emergency_contact, emergency_relation, patient_type, panel_id,
                       panel_category, card_id, referred_by_type, registration_status, registered_on)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                  (u, s(r[2]) or "(no name)", s(r[3]) or None, dob, s(r[5]) or None, s(r[6]) or None, s(r[7]) or None, s(r[8]) or None,
                   mobile(r[9]) or None, mobile(r[10]) or None, s(r[11]) or None, s(r[12]) or None, mobile(r[13]) or None, s(r[27]) or None, ptype, pn,
                   cat if ptype == "Panel" else None, (s(r[36]) or None) if ptype == "Panel" else None, s(r[37]) or None, status,
                   (ts.replace(tzinfo=TZ) if ts else dt.datetime.now(TZ))), "patients", u)
        if not res: continue
        pid[u] = res[0]
        habits = ", ".join(n for n, c in (("Smoking", 18), ("Pan masala", 19), ("Tobacco", 20), ("Alcohol", 21)) if yes(r[c]))
        one("""INSERT INTO patient_registrations (patient_id, collected_at, status, conditions, allergies, medicines, habits, pregnant,
                 feeding_mother, chief_complaint, pain_level, how_known, consent_given, form)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
            (res[0], ts.replace(tzinfo=TZ) if ts else dt.datetime.now(TZ), status, split(r[14]), split(r[22]), s(r[15]) or None, habits or None,
             yes(r[16]) if s(r[16]) else None, yes(r[17]) if s(r[17]) else None, s(r[24]) or None, s(r[26]) or None, s(r[23]) or None,
             yes(r[32]), '{"imported_from":"%s","in_pain":"%s","dob_text":"%s"}' % (src, s(r[25]).replace('"', ""), s(dob_raw).replace('"', "") if dob is None else "")),
            "patient_registrations", u)
    counts["patients"] = (len(groups), len(pid))

    def known(u, table):
        if not u: return None
        if u in pid: return pid[u]
        orphans.append({"table": table, "uhid": u}); return None

    # ── appointments ──
    ok = 0; rows = load(PMS, "Appointments")
    for i, r in enumerate(rows, 2):
        d = day(r[0]); t = parse_time(r[3])
        if not d or not t: reject("appointments", f"row {i}", f"unreadable date/time ({s(r[0])[:20]} {s(r[3])[:10]})"); continue
        u = uhid(r[1]); p = known(u, "appointments")
        starts = at(d, t); ends = starts + dt.timedelta(minutes=30)
        status = s(r[8]) if s(r[8]) in ("Scheduled", "Checked In", "In Chair", "Completed", "Cancelled", "No Show") else "Scheduled"
        if d < dt.date.today():
            if status == "Scheduled": status = "No Show"
            elif status in ("In Chair", "Checked In"): status = "Completed"
        stamps = []
        for c in (12, 13, 14):
            tt = parse_time(r[c]); stamps.append(at(d, tt) if tt else None)
        ci, en, co = stamps
        if en and (not ci or en < ci): en = None
        if co and (not en or co < en): co = None
        res = one("""INSERT INTO appointments (patient_id, patient_name, mobile, starts_at, ends_at, reason, sub_type, doctor_id, chair_id, notes,
                       status, checkin_at, engaged_at, checkout_at, cancel_reason)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                  (p, s(r[2]) or "(no name)", s(r[6]) or None, starts, ends, s(r[4]) or "Consultation", s(r[29]) or None,
                   doctor(r[5]), chair(r[11]), s(r[7]) or None, status, ci, en, co,
                   (s(r[15]) or "Not recorded in the sheet") if status == "Cancelled" else None), "appointments", f"row {i}")
        if not res and rejects and rejects[-1]["row"] == f"row {i}" and "one_patient_per_chair" in rejects[-1]["reason"]:
            rejects.pop()
            res = one("""INSERT INTO appointments (patient_id, patient_name, mobile, starts_at, ends_at, reason, sub_type, doctor_id, notes,
                           status, checkin_at, engaged_at, checkout_at, cancel_reason)
                         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                      (p, s(r[2]) or "(no name)", s(r[6]) or None, starts, ends, s(r[4]) or "Consultation", s(r[29]) or None,
                       doctor(r[5]), s(r[7]) or None, status, ci, en, co,
                       (s(r[15]) or "Not recorded in the sheet") if status == "Cancelled" else None), "appointments", f"row {i}")
            overlaps.append({"row": i, "date": str(d), "time": s(r[3]), "chair": s(r[11]), "note": "chair clashed with another booking at the assumed 30 minutes; imported without a chair"})
        ok += bool(res)
    counts["appointments"] = (len(rows), ok)

    # ── daily register ──
    ok = 0; rows = load(PMS, "Daily Register")
    for i, r in enumerate(rows, 2):
        d = day(r[1]) or None
        if not d: reject("daily_register", f"row {i}", "no readable date"); continue
        u = uhid(r[2])
        res = one("""INSERT INTO daily_register (visit_date, month, uhid, patient_id, patient_name, phone_no, age, time_walk_in, consultation_time, tat,
                       initial_assessment, care_plan_documented, procedure_done, tooth_no, work_done, operating_doctor, delay_reason, mode_of_payment)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                  (d, s(r[0]) or None, u or None, known(u, "daily_register"), s(r[3]) or None, s(r[4]) or None, s(r[5]) or None, s(r[6]) or None,
                   s(r[7]) or None, s(r[8]) or None, s(r[9]) or None, s(r[10]) or None, s(r[11]) or None, s(r[12]) or None, s(r[13]) or None,
                   s(r[14]) or None, s(r[15]) or None, s(r[16]) or None), "daily_register", f"row {i}")
        ok += bool(res)
    counts["daily_register"] = (len(rows), ok)

    # ── receipts ──
    # Patient Fee Receipt is the book the desk types into (by Timestamp, with the second
    # payment in "Amount (Payment mode is more than one)"). Receipt No. carries the printed
    # e-receipt number; each entry takes its number from the matching row (same patient,
    # day and total). Receipt No. rows with no entry are kept too. FY-tab lines that match
    # neither are the manual receipts.
    rn_pool = collections.defaultdict(list)
    for r in load(FIN, "Receipt No."):
        d = day(r[0]); u = uhid(r[1]); fee = num(r[5])
        if not d and not u and not fee: continue          # a formula row with nothing in it
        rn_pool[(u, d, fee)].append(r)
    receipts = []
    for r in load(FIN, "Patient Fee Receipt"):
        d = day(r[0]); u = uhid(r[1]); tot = round(num(r[5]) + num(r[7]), 2)
        if not d and not u and not tot: continue
        pool = rn_pool.get((u, d, tot)); rn = pool.pop(0) if pool else None
        receipts.append({"date": d, "uhid": u, "name": s(r[2]), "service": s(r[3]), "mode1": s(r[4]), "amt1": num(r[5]),
                         "mode2": s(r[6]), "amt2": num(r[7]), "remarks": s(r[8]), "legacy": s(rn[6]) if rn else None, "matched": bool(rn)})
    only_rn = 0
    for lst in rn_pool.values():
        for r in lst:
            only_rn += 1
            receipts.append({"date": day(r[0]), "uhid": uhid(r[1]), "name": s(r[2]), "service": s(r[3]), "mode1": s(r[4]), "amt1": num(r[5]),
                             "mode2": "", "amt2": 0.0, "remarks": "", "legacy": s(r[6]) or None, "matched": False})
    e_keys = collections.Counter((x["uhid"], x["date"], round(x["amt1"] + x["amt2"], 2)) for x in receipts)
    manual_max = collections.Counter(); manual_row = {}
    for fy in ("FY 2024-25", "FY 2025-26", "FY 2026-27"):
        tabn = collections.Counter(); first = {}
        for r in load(FIN, fy):
            d = day(r[1]); k = (uhid(r[3]), d, num(r[7]))
            if not d: continue
            tabn[k] += 1; first.setdefault(k, []).append(r)
        for k, n in tabn.items():
            extra = max(0, n - e_keys.get(k, 0))
            if extra > manual_max[k]: manual_max[k] = extra; manual_row[k] = first[k][:extra]
    manual = []
    for k, n in manual_max.items():
        for r in manual_row[k][:n]:
            manual.append({"date": k[1], "uhid": k[0], "name": s(r[4]), "service": s(r[5]), "mode1": s(r[6]), "amt1": k[2],
                           "mode2": "", "amt2": 0.0, "remarks": s(r[21]), "legacy": None, "matched": None})
    allr = [(x, "e") for x in receipts] + [(x, "m") for x in manual]
    allr.sort(key=lambda t: (t[0]["date"] or dt.date.min, 0 if t[1] == "e" else 1))
    ok = 0; mn = 0; no = 0
    for x, kind in allr:
        if not x["date"]: reject("receipts", x["legacy"] or "manual", "no readable date"); continue
        if kind == "m": mn += 1; legacy = f"MANUAL-{mn}"
        else: legacy = x["legacy"]
        no += 1
        res = one("""INSERT INTO receipts (receipt_no, receipt_date, patient_id, uhid, patient_name, service, mode1, amount1, mode2, amount2, remarks, legacy_receipt_no)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                  (no, x["date"], known(x["uhid"], "receipts"), x["uhid"] or None, x["name"] or None, x["service"] or None, x["mode1"] or None,
                   x["amt1"], x["mode2"] or None, x["amt2"], x["remarks"] or None, legacy), "receipts", legacy or f"{x['date']} {x['uhid']}")
        ok += bool(res)
    cur.execute("INSERT INTO receipt_counters (last_value) VALUES (%s) ON CONFLICT (clinic_id) DO UPDATE SET last_value = EXCLUDED.last_value", (no,))
    counts["receipts"] = (len(allr), ok)
    notes.append(f"receipts: {len(receipts) - only_rn} entries from Patient Fee Receipt ({sum(1 for x in receipts if x['matched'])} took an e-receipt number), {only_rn} Receipt No. rows with no entry, {len(manual)} manual lines from FY tabs")

    # ── expenses ──
    ok = 0; rows = load(FIN, "Expense")
    for i, r in enumerate(rows, 2):
        d = day(r[1]) or day(r[0])
        if not d: reject("expenses", f"row {i}", "no readable date"); continue
        res = one("""INSERT INTO expenses (expense_date, paid_by, expense_name, amount, mode, remarks, legacy_id, category)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                  (d, s(r[2]) or None, s(r[3]) or None, num(r[5]), s(r[6]) or None, s(r[8]) or None, f"XLS-{i}", s(r[4]) or None), "expenses", f"row {i}")
        ok += bool(res)
    counts["expenses"] = (len(rows), ok)

    # ── verification inside the same transaction ──
    cur.execute("SELECT count(*), coalesce(sum(amount1 + amount2), 0) FROM receipts")
    rc, rsum = cur.fetchone()
    cur.execute("SELECT count(*), coalesce(sum(amount), 0) FROM expenses")
    ec, esum = cur.fetchone()
    exp_sheet_sum = round(sum(num(r[5]) for r in rows), 2)
    sheet_e = round(sum(x["amt1"] + x["amt2"] for x in receipts), 2)
    notes.append(f"check: entries + e-receipt-only rows {sheet_e:,.2f}; all receipts loaded {float(rsum):,.2f} (includes {sum(x['amt1'] for x in manual):,.2f} manual)")
    notes.append(f"check: expenses in sheet {exp_sheet_sum:,.2f}; loaded {float(esum):,.2f}")
    conn.commit()

def write(name, rows):
    if not rows: (OUT / name).write_text("", encoding="utf-8"); return
    with open(OUT / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
write("rejects.csv", rejects); write("review-duplicate-uhids.csv", dup_rows); write("date-issues.csv", date_issues)
oc = collections.Counter((o["table"], o["uhid"]) for o in orphans)
write("review-unregistered-uhids.csv", [{"table": t, "uhid": u, "rows": n} for (t, u), n in sorted(oc.items())])
write("review-appointment-chair-clashes.csv", overlaps); write("review-invalid-uhids.csv", bad_uhids); write("notes.csv", [{"note": n} for n in notes])
print("loaded (sheet rows, loaded):", counts)
print("rejects:", len(rejects), dict(collections.Counter(r["table"] for r in rejects)), "| duplicate-UHID groups:", len(dup_rows),
      "| unregistered UHID refs:", len(orphans), "| date issues:", len(date_issues))
for n in notes: print(" -", n)
