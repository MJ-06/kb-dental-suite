"""Lists UHIDs that appear in the loaded data with no registration, and proposes the registered
patient each one probably is (same name, and the same mobile when both rows have one).
Writes migration/data/out/orphan-uhids-proposed-fixes.csv. Read only. Proposals are for a person
to check; nothing is changed.

    uv run --with "psycopg[binary]" python -X utf8 migration/orphan_uhid_report.py
"""
import collections, csv, re, sys
from pathlib import Path
import psycopg

env = {}
for line in (Path.home() / ".kb-pms" / "owner.env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); env[k.strip()] = v.strip()
url = env["REHEARSAL_OWNER_DATABASE_URL"]
if not re.search(r"@(localhost|127\.0\.0\.1)(:\d+)?/kb_rehearsal$", url): sys.exit("rehearsal database only")
norm = lambda t: re.sub(r"[^a-z]", "", re.sub(r"\b(dr|mr|mrs|ms|master|baby|smt|shri)\b\.?", "", (t or "").lower()))
digits = lambda t: (re.sub(r"\D", "", t or "")[-10:] if t else "")
OK = re.compile(r"^A[A-L](0[1-9]|1[0-2])\d{2,3}$")

with psycopg.connect(url) as c:
    cur = c.cursor()
    cur.execute("select set_config('app.clinic_id',(select id::text from clinics where code='kb'),false)")
    cur.execute("select uhid, full_name, mobile from patients")
    by_name = collections.defaultdict(list); by_mobile = collections.defaultdict(list)
    for u, n, m in cur.fetchall():
        by_name[norm(n)].append(u)
        if digits(m): by_mobile[digits(m)].append((u, norm(n)))
    seen = collections.defaultdict(lambda: {"tables": collections.Counter(), "names": set(), "mobiles": set()})
    def add(u, table, name=None, mobile=None):
        if not u: return
        d = seen[u.upper()]; d["tables"][table] += 1
        if name and name.strip(): d["names"].add(name.strip())
        if digits(mobile): d["mobiles"].add(digits(mobile))
    cur.execute("select uhid, patient_name, phone_no from daily_register where patient_id is null and uhid is not null")
    for r in cur.fetchall(): add(r[0], "daily_register", r[1], r[2])
    cur.execute("select uhid, patient_name, null from receipts where patient_id is null and uhid is not null")
    for r in cur.fetchall(): add(r[0], "receipts", r[1])
    cur.execute("select uhid, fields from clinical_records where patient_id is null")
    for u, f in cur.fetchall():
        nm = next((v for k, v in f.items() if re.match(r"(?i)^(full )?name|patient name|name of patient", k) and v), None)
        add(u, "clinical: " + "", nm)
    cur.execute("select substring(notes from 'UHID as typed in the sheet: ([^\]]+)'), patient_name, mobile from appointments where patient_id is null and notes like '[UHID as typed%'")
    for r in cur.fetchall(): add(r[0], "appointments", r[1], r[2])

rows = []
for u, d in seen.items():
    names = sorted(d["names"]); mobiles = sorted(d["mobiles"])
    cand = collections.Counter(); basis = {}
    for n in names:
        for cu in by_name.get(norm(n), []):
            cand[cu] += 1; basis[cu] = "name"
    for m in mobiles:
        for cu, cn in by_mobile.get(m, []):
            if cn in {norm(n) for n in names} or not names:
                cand[cu] += 2; basis[cu] = "name + mobile" if cn in {norm(n) for n in names} else "mobile only"
    if not cand: prop, why = "", "no match"
    else:
        top = cand.most_common(2)
        if len(top) > 1 and top[0][1] == top[1][1]: prop, why = "", "ambiguous: " + ", ".join(x for x, _ in top)
        else: prop, why = top[0][0], basis[top[0][0]]
    rows.append({"uhid_as_typed": u, "well_formed": "yes" if OK.match(u) else "NO", "rows": "; ".join(f"{t} {n}" for t, n in sorted(d["tables"].items())),
                 "names_seen": " | ".join(names), "mobiles_seen": " | ".join(mobiles), "proposed_uhid": prop, "basis": why, "reviewer_decision": ""})
rows.sort(key=lambda r: (r["well_formed"] == "yes", r["uhid_as_typed"]))
out = Path("migration/data/out/orphan-uhids-proposed-fixes.csv")
with open(out, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
bad = [r for r in rows if r["well_formed"] == "NO"]
print(f"orphan UHIDs {len(rows)}: malformed {len(bad)} (proposed {sum(1 for r in bad if r['proposed_uhid'])}), well-formed {len(rows) - len(bad)} (a name matches a registered patient for {sum(1 for r in rows if r['well_formed']=='yes' and r['proposed_uhid'])})")
print("basis (malformed):", dict(collections.Counter(r["basis"].split(":")[0] for r in bad)))
