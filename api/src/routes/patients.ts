import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import { asActor } from "../http/context.js";
import { HttpError, notFound } from "../http/errors.js";
import type { AppOptions } from "../app.js";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Mobile = Type.String({ pattern: "^\\+?[0-9]{10,15}$" });

// Everything a desk may set on a patient. UHID, clinic, version and the
// timestamps are the server's, and are not accepted from the browser.
const PatientFields = Type.Object({
  full_name: Type.String({ minLength: 1, maxLength: 200 }),
  gender: Nullable(Type.Union([Type.Literal("Male"), Type.Literal("Female"), Type.Literal("Other")])),
  date_of_birth: Nullable(Type.String({ format: "date" })),
  blood_group: Nullable(Type.String({ maxLength: 10 })),
  occupation: Nullable(Type.String({ maxLength: 100 })),
  marital_status: Nullable(Type.String({ maxLength: 30 })),
  address: Nullable(Type.String({ maxLength: 500 })),
  mobile: Nullable(Mobile),
  mobile_2: Nullable(Mobile),
  whatsapp: Nullable(Mobile),
  email: Nullable(Type.String({ format: "email", maxLength: 200 })),
  emergency_name: Nullable(Type.String({ maxLength: 200 })),
  emergency_contact: Nullable(Type.String({ maxLength: 30 })),
  emergency_relation: Nullable(Type.String({ maxLength: 50 })),
  patient_type: Type.Union([Type.Literal("Normal"), Type.Literal("Panel")]),
  panel_id: Nullable(Type.String({ format: "uuid" })),
  panel_category: Nullable(Type.Union([Type.Literal("Serving"), Type.Literal("Pensioner")])),
  card_id: Nullable(Type.String({ maxLength: 50 })),
  referred_by: Nullable(Type.String({ maxLength: 200 })),
  referred_by_type: Nullable(Type.String({ maxLength: 30 }))
}, { additionalProperties: false });

const CreatePatient = Type.Partial(PatientFields, { additionalProperties: false });
const CreatePatientBody = Type.Intersect([CreatePatient, Type.Object({ full_name: PatientFields.properties.full_name })]);

// A change sends the version it was based on and only the fields it changed.
const PatchPatientBody = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  changes: Type.Partial(PatientFields, { additionalProperties: false, minProperties: 1 })
}, { additionalProperties: false });

const IdParams = Type.Object({ id: Type.String({ format: "uuid" }) });

export const patientRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  app.get("/", {
    schema: {
      querystring: Type.Object({
        q: Type.Optional(Type.String({ maxLength: 100 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 }))
      })
    }
  }, async (req) => asActor(db, req, "patients:read", async (tx) => {
    const q = req.query.q?.trim();
    let query = tx.selectFrom("patients")
      .select(["id", "uhid", "full_name", "mobile", "date_of_birth", "patient_type", "version"])
      .where("deleted_at", "is", null)
      .orderBy("full_name")
      .limit(req.query.limit ?? 25);
    if (q) {
      const digits = q.replace(/\D/g, "");
      const name = `%${q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`;
      query = query.where((eb) => eb.or([
        eb("uhid", "ilike", q),
        eb(sql<string>`lower(full_name)`, "like", name),
        ...(digits.length >= 4 ? [eb("mobile", "like", `%${digits}%`)] : [])
      ]));
    }
    return { patients: await query.execute() };
  }));

  app.get("/:id", { schema: { params: IdParams } },
    async (req) => asActor(db, req, "patients:read", async (tx) => {
      const patient = await tx.selectFrom("patients").selectAll()
        .where("id", "=", req.params.id).where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!patient) throw notFound("Patient");
      return { patient };
    }));

  app.post("/", { schema: { body: CreatePatientBody } },
    async (req, reply) => asActor(db, req, "patients:write", async (tx) => {
      // The UHID is taken inside this transaction. If the insert fails the
      // number is rolled back with it; two desks never share one.
      const { uhid } = (await sql<{ uhid: string }>`SELECT next_uhid() AS uhid`.execute(tx)).rows[0]!;
      const patient = await tx.insertInto("patients")
        .values({ ...(req.body as Static<typeof CreatePatient>), full_name: req.body.full_name!.trim(), uhid })
        .returningAll()
        .executeTakeFirstOrThrow();
      reply.status(201);
      return { patient };
    }));

  app.patch("/:id", { schema: { params: IdParams, body: PatchPatientBody } },
    async (req) => asActor(db, req, "patients:write", async (tx) => {
      const { version, changes } = req.body;
      const updated = await tx.updateTable("patients")
        .set(changes as never)
        .where("id", "=", req.params.id)
        .where("version", "=", version)
        .where("deleted_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (updated) return { patient: updated };

      // Nothing matched: either it does not exist, or someone saved first.
      const current = await tx.selectFrom("patients").selectAll()
        .where("id", "=", req.params.id).where("deleted_at", "is", null).executeTakeFirst();
      if (!current) throw notFound("Patient");
      throw new HttpError(409, "changed_elsewhere",
        "Someone else changed this patient after you opened it. Reload to see their change, then make yours again.",
        { current });
    }));
};
