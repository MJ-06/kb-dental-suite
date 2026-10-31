// Fictional workflow fixtures only. No source-data access and no external services.
import pg from "pg";

export async function seedDemoWork(ownerUrl: string, code: string) {
  if (code !== "org-a" && code !== "org-b") throw new Error("Dedicated demo organization required.");
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const organization = (await client.query("SELECT id,code FROM org_identity WHERE singleton")).rows[0];
    if (organization?.code !== code) throw new Error("Demo organization identity differs.");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [organization.id]);
    const already = (await client.query("SELECT 1 FROM org_audit WHERE action='demo.fixture.v1' LIMIT 1")).rowCount;
    if (already) { await client.query("COMMIT"); return; }
    const units = (await client.query<{ id: string; code: string }>("SELECT id,code FROM org_units ORDER BY code")).rows;
    if (units.length !== (code === "org-a" ? 2 : 1)) throw new Error("Unexpected demo clinic count.");
    const doctor = (await client.query("SELECT id FROM org_users WHERE username='doctor'")).rows[0];
    if (!doctor) throw new Error("Seed doctor missing.");
    await client.query("SELECT set_config('app.user_id',$1,true)", [doctor.id]);
    const first = units[0]!;
    const second = units[1] ?? first;
    const patients: { id: string; snapshot: Record<string, string> }[] = [];
    // Deliberately fictional identities and non-contactable demo numbers. Two
    // family members share a phone; organization A's first patient visits both units.
    for (const [index, name] of ["Noor Example", "Ishan Example", "Leela Example"].entries()) {
      const uhid = `DEMO-${code === "org-a" ? "A" : "B"}-${String(index + 1).padStart(3, "0")}`;
      const phone = index < 2 ? "0000000001" : "0000000002";
      const unit = index === 2 ? second : first;
      const patient = (await client.query(
        "INSERT INTO org_patients(uhid,name,phone,registration_unit_id) VALUES($1,$2,$3,$4) RETURNING id",
        [uhid, name, phone, unit.id]
      )).rows[0];
      patients.push({ id: patient.id, snapshot: { name, uhid, phone } });
    }
    const shared = patients[0]!;
    const note = (await client.query(
      "INSERT INTO org_notes(unit_id,patient_id,author_id,text,patient_snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [first.id, shared.id, doctor.id, "Fictional demo visit: presenting concern and review recorded for workflow testing only.", shared.snapshot]
    )).rows[0];
    await client.query(
      "INSERT INTO org_notes(unit_id,patient_id,author_id,text,parent_id,patient_snapshot) VALUES($1,$2,$3,$4,$5,$6)",
      [first.id, shared.id, doctor.id, "Fictional addendum: demonstration follow-up details appended; original note retained.", note.id, shared.snapshot]
    );
    if (units.length > 1) {
      await client.query(
        "INSERT INTO org_notes(unit_id,patient_id,author_id,text,patient_snapshot) VALUES($1,$2,$3,$4,$5)",
        [second.id, shared.id, doctor.id, "Fictional second-clinic visit: shared identity with separately scoped clinic history.", shared.snapshot]
      );
    }
    for (let index = 0; index < units.length; index++) {
      await client.query(`INSERT INTO org_appointments(unit_id,patient_id,doctor_id,starts_at,ends_at,chair)
        VALUES($1,$2,$3,
          (((now() AT TIME ZONE 'Asia/Kolkata')::date + time '10:00') AT TIME ZONE 'Asia/Kolkata') + ($4 * interval '1 hour'),
          (((now() AT TIME ZONE 'Asia/Kolkata')::date + time '10:30') AT TIME ZONE 'Asia/Kolkata') + ($4 * interval '1 hour'),'Demo Chair 1')`,
      [units[index]!.id, shared.id, doctor.id, index]);
    }
    const form = (await client.query(`SELECT f.id,f.fields FROM org_forms f
      JOIN org_form_assignments a ON a.form_id=f.id AND a.organization_id=f.organization_id
      WHERE a.unit_id=$1 ORDER BY f.key,f.form_version DESC LIMIT 1`, [first.id])).rows[0];
    if (!form || !Array.isArray(form.fields)) throw new Error("Assigned demo form missing.");
    const answers = Object.fromEntries(form.fields.map((field: { key: string }) => [field.key, "Fictional demonstration response"]));
    await client.query(
      "INSERT INTO org_submissions(unit_id,patient_id,form_id,author_id,answers,patient_snapshot) VALUES($1,$2,$3,$4,$5,$6)",
      [first.id, shared.id, form.id, doctor.id, answers, shared.snapshot]
    );
    for (const [index, unit] of units.entries()) {
      const charge = index === 0 ? 1200 : 900;
      const paid = index === 0 ? 800 : 900;
      await client.query(`INSERT INTO org_receipts(unit_id,patient_id,number,charge,paid,description,patient_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [unit.id, shared.id, `${unit.code.toUpperCase()}/DEMO/001`, charge, paid,
        "Fictional examination and review — synthetic workflow example", shared.snapshot]);
    }
    await client.query(`INSERT INTO org_receipts(unit_id,patient_id,number,charge,paid,description,patient_snapshot)
      VALUES($1,$2,$3,300,300,$4,$5)`,
    [first.id, patients[1]!.id, `${first.code.toUpperCase()}/DEMO/002`, "Fictional service — synthetic workflow example", patients[1]!.snapshot]);
    await client.query("INSERT INTO org_audit(actor_id,action) VALUES($1,'demo.fixture.v1')", [doctor.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
}
