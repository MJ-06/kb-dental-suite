import { Type, type TSchema } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import type { AppointmentStatus } from "../db/schema.js";
import { asActor } from "../http/context.js";
import { HttpError, notFound } from "../http/errors.js";
import type { AppOptions } from "../app.js";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Uuid = Type.String({ format: "uuid" });
// An instant with its offset, e.g. 2026-11-06T10:30:00+05:30. A bare local
// time is refused: the server must never guess which timezone was meant.
const Instant = Type.String({ format: "date-time", pattern: "(Z|[+-]\\d{2}:\\d{2})$" });

const BookingFields = {
  patient_id: Nullable(Uuid),
  patient_name: Type.String({ minLength: 1, maxLength: 200 }),
  mobile: Nullable(Type.String({ pattern: "^\\+?[0-9]{10,15}$" })),
  starts_at: Instant,
  ends_at: Instant,
  reason: Type.String({ minLength: 1, maxLength: 200 }),
  sub_type: Nullable(Type.String({ maxLength: 200 })),
  doctor_id: Nullable(Uuid),
  chair_id: Nullable(Uuid),
  notes: Nullable(Type.String({ maxLength: 2000 }))
};

const CreateBody = Type.Object({
  ...BookingFields,
  patient_name: Type.Optional(BookingFields.patient_name),
  patient_id: Type.Optional(BookingFields.patient_id),
  mobile: Type.Optional(BookingFields.mobile),
  sub_type: Type.Optional(BookingFields.sub_type),
  doctor_id: Type.Optional(BookingFields.doctor_id),
  chair_id: Type.Optional(BookingFields.chair_id),
  notes: Type.Optional(BookingFields.notes)
}, { additionalProperties: false });

const PatchBody = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  changes: Type.Partial(Type.Object(BookingFields, { additionalProperties: false }), { minProperties: 1 })
}, { additionalProperties: false });

const StatusBody = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  status: Type.Union(["Checked In", "In Chair", "Completed", "Cancelled", "No Show", "Scheduled"].map((s) => Type.Literal(s))),
  cancel_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
}, { additionalProperties: false });

const IdParams = Type.Object({ id: Uuid });

// The visit's path through the day. Anything else is refused, so a
// completed visit cannot be "un-checked-in" by a stray click.
const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  "Scheduled":  ["Checked In", "Cancelled", "No Show"],
  "Checked In": ["In Chair", "Cancelled", "Scheduled"],
  "In Chair":   ["Completed"],
  "Completed":  [],
  "Cancelled":  ["Scheduled"],
  "No Show":    ["Scheduled"]
};

export const appointmentRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  app.get("/", {
    schema: { querystring: Type.Object({ date: Type.String({ format: "date" }) }) }
  }, async (req) => asActor(db, req, "appointments:read", async (tx, actor) => {
    // The clinic's day, from its midnight to the next, in its own timezone.
    const from = sql<Date>`(${req.query.date}::date)::timestamp AT TIME ZONE ${actor.timezone}`;
    const to = sql<Date>`(${req.query.date}::date + 1)::timestamp AT TIME ZONE ${actor.timezone}`;
    const appointments = await tx.selectFrom("appointments").selectAll()
      .where("starts_at", ">=", from).where("starts_at", "<", to)
      .orderBy("starts_at").execute();
    return { appointments };
  }));

  app.get("/:id", { schema: { params: IdParams } },
    async (req) => asActor(db, req, "appointments:read", async (tx) => {
      const appointment = await tx.selectFrom("appointments").selectAll().where("id", "=", req.params.id).executeTakeFirst();
      if (!appointment) throw notFound("Appointment");
      return { appointment };
    }));

  app.post("/", { schema: { body: CreateBody } },
    async (req, reply) => asActor(db, req, "appointments:write", async (tx) => {
      const b = req.body;
      let name = b.patient_name?.trim();
      let mobile = b.mobile ?? null;
      if (b.patient_id) {
        const p = await tx.selectFrom("patients").select(["full_name", "mobile"])
          .where("id", "=", b.patient_id).where("deleted_at", "is", null).executeTakeFirst();
        if (!p) throw notFound("Patient");
        name ||= p.full_name;
        mobile ??= p.mobile;
      }
      if (!name) throw new HttpError(400, "invalid_request", "Give the patient's name or choose a registered patient");
      const appointment = await tx.insertInto("appointments")
        .values({ ...b, patient_name: name, mobile })
        .returningAll().executeTakeFirstOrThrow();
      reply.status(201);
      return { appointment };
    }));

  app.patch("/:id", { schema: { params: IdParams, body: PatchBody } },
    async (req) => asActor(db, req, "appointments:write", async (tx) => {
      const updated = await tx.updateTable("appointments").set(req.body.changes)
        .where("id", "=", req.params.id).where("version", "=", req.body.version)
        .returningAll().executeTakeFirst();
      if (updated) return { appointment: updated };
      return conflictOrMissing(tx, req.params.id);
    }));

  app.post("/:id/status", { schema: { params: IdParams, body: StatusBody } },
    async (req) => asActor(db, req, "appointments:write", async (tx) => {
      const { version, status, cancel_reason } = req.body;
      const current = await tx.selectFrom("appointments").select(["status", "version"])
        .where("id", "=", req.params.id).executeTakeFirst();
      if (!current) throw notFound("Appointment");
      if (current.version !== version) return conflictOrMissing(tx, req.params.id);
      if (!NEXT[current.status].includes(status as AppointmentStatus)) {
        throw new HttpError(422, "bad_transition", `A visit that is ${current.status} cannot become ${status}`);
      }

      // The database clock stamps each step, not the browser's.
      const stamp = {
        "Checked In": { checkin_at: sql<Date>`now()` },
        "In Chair":   { engaged_at: sql<Date>`now()` },
        "Completed":  { checkout_at: sql<Date>`now()` },
        "Cancelled":  { cancel_reason: cancel_reason ?? null },
        "No Show":    {},
        // Back to the diary: the visit starts its day again.
        "Scheduled":  { checkin_at: null, engaged_at: null, checkout_at: null, cancel_reason: null }
      }[status as AppointmentStatus];

      const appointment = await tx.updateTable("appointments")
        .set({ status: status as AppointmentStatus, ...stamp })
        .where("id", "=", req.params.id).where("version", "=", version)
        .returningAll().executeTakeFirstOrThrow();
      return { appointment };
    }));
};

async function conflictOrMissing(tx: Tx, id: string): Promise<never> {
  const current = await tx.selectFrom("appointments").selectAll().where("id", "=", id).executeTakeFirst();
  if (!current) throw notFound("Appointment");
  throw new HttpError(409, "changed_elsewhere",
    "Someone else changed this appointment after you opened it. Reload to see their change, then make yours again.",
    { current });
}
