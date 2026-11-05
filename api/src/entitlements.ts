import {sql} from "kysely";
import type {Tx,Actor} from "./db/index.js";
export const FEATURES=["clinical.core","finance.core","organization.reports","forms.custom","crm.workspace","integration.storage","integration.ai","integration.enterprise"] as const;
export type Feature=typeof FEATURES[number];
export const PLANS={essential:["clinical.core","finance.core"],growth:["clinical.core","finance.core","organization.reports","forms.custom","crm.workspace","integration.storage"],enterprise:[...FEATURES]} as const;
export function evaluatePolicy(policy:{plan?:string;mode?:string;disabled?:string[]}={}){
 const plan=Object.prototype.hasOwnProperty.call(PLANS,policy.plan??"")?policy.plan as keyof typeof PLANS:"enterprise";
 const mode=policy.mode==="enforced"?"enforced":"full";
 const allowed:readonly string[]=mode==="full"?FEATURES:PLANS[plan];
 return {plan,mode,features:Object.fromEntries(FEATURES.map(f=>[f,allowed.includes(f)&&!(mode==="enforced"&&(policy.disabled??[]).includes(f))])) as Record<Feature,boolean>};
}
export async function capabilities(tx:Tx,actor:Actor){
 let policy={};if(actor.organizationId)policy=(await sql<{value:any}>`SELECT value FROM org_settings WHERE unit_id IS NULL AND key='subscription_policy'`.execute(tx)).rows[0]?.value??{};
 return {...evaluatePolicy(policy),permissions:[...actor.permissions]};
}
export function actionFeature(action:string):Feature|null{
 if(action==="getOrganizationReports")return "organization.reports";
 if(/Crm/.test(action))return "crm.workspace";
 if(["chatbotReply","generateSOAPNotes"].includes(action))return "integration.ai";
 return null;
}
