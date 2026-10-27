// Calls /exec the way today's screens do.
import { expect } from "vitest";
import { PASSWORD, type World } from "./setup.js";

export async function execLogin(world: World, clinic: string, username: string): Promise<string> {
  const res = await world.app.inject({ url: "/exec", query: { action: "staffLogin", clinic, username, password: PASSWORD } });
  expect(res.json()).toMatchObject({ success: true });
  const c = res.cookies.find((x) => x.name === "kb_session")!;
  return `kb_session=${c.value}`;
}

export async function exec(world: World, cookie: string, action: string, params: Record<string, unknown> = {}) {
  const query: Record<string, string> = { action };
  for (const [k, v] of Object.entries(params)) query[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  const res = await world.app.inject({ url: "/exec", query, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

