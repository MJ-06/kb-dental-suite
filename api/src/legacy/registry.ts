// Every action today's screens can call, gathered from the modules.
import { diary } from "./diary.js";
import { finance } from "./finance.js";
import { masters } from "./masters.js";
import { patients } from "./patients.js";
import type { ActionTable } from "./types.js";

export const actions: ActionTable = Object.assign(Object.create(null) as ActionTable, masters, patients, diary, finance);
