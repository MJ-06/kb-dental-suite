// Errors the desk can read. A database constraint becomes a plain sentence
// and a status code; anything unexpected is logged in full and reported as
// a generic failure, so internals never reach the browser.
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "../auth/tokens.js";
import { recordFailure } from "../syslog.js";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);

const PG_ERRORS: Record<string, [number, string, string]> = {
  "23505": [409, "duplicate", "That record already exists"],
  "23503": [422, "missing_reference", "That refers to something that does not exist"],
  "23514": [422, "rule_broken", "That would break one of the clinic's rules"],
  "23P01": [409, "slot_taken", "That chair is already booked for part of that time"],
  "22P02": [400, "bad_value", "One of the values is not in the right format"],
  "22007": [400, "bad_date", "One of the dates is not valid"],
  "42501": [403, "forbidden", "Not allowed"]
};

export async function errorHandler(err: FastifyError & { code?: string; constraint?: string }, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.validation) {
    return reply.status(400).send({ error: { code: "invalid_request", message: err.message } });
  }
  if (err.statusCode === 429) {
    return reply.status(429).send({ error: { code: "too_many_requests", message: "Too many attempts. Wait a minute and try again." } });
  }
  const mapped = err.code ? PG_ERRORS[err.code] : undefined;
  if (mapped) {
    const [status, code, message] = mapped;
    req.log.warn({ pg: err.code, constraint: err.constraint }, message);
    return reply.status(status).send({ error: { code, message, details: err.constraint ? { rule: err.constraint } : undefined } });
  }
  const ref = await recordFailure(req.cookies?.[SESSION_COOKIE], { kind: "rest", action: `${req.method} ${req.routeOptions?.url ?? req.url.split("?")[0]}`, error: err }, req.log);
  return reply.status(500).send({ error: { code: "internal", message: `Something went wrong. Reference ${ref}.`, ref } });
}
