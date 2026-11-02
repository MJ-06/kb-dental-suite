// Every action today's screens can call, gathered from the modules.
import { cases } from "./cases.js";
import { clinical } from "./clinical.js";
import { crm } from "./crm.js";
import { diary } from "./diary.js";
import { documents } from "./documents.js";
import { finance } from "./finance.js";
import { masters } from "./masters.js";
import { patients } from "./patients.js";
import { session } from "./session.js";
import { organizationActions } from "./organization.js";
import { sharedPatientActions } from "./shared-patients.js";
import { patientHistoryActions } from "./patient-history.js";
import type { ActionTable } from "./types.js";

export const actions: ActionTable = Object.assign(Object.create(null) as ActionTable, masters, patients, diary, finance, clinical, cases, documents, crm, session, organizationActions, sharedPatientActions, patientHistoryActions);
