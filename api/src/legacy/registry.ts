// Every action today's screens can call, gathered from the modules.
import { masters } from "./masters.js";
import type { ActionTable } from "./types.js";

export const actions: ActionTable = Object.assign(Object.create(null) as ActionTable, masters);
