import {it,expect} from "vitest";
import {evaluatePolicy,actionFeature} from "../src/entitlements.js";
it('keeps all features available in full demo mode regardless of proposed tier',()=>{
 expect(Object.values(evaluatePolicy({plan:'essential',mode:'full'}).features).every(Boolean)).toBe(true);
});
it('applies explicit policy only in enforced mode without changing staff permissions',()=>{
 const essential=evaluatePolicy({plan:'essential',mode:'enforced'});expect(essential.features['clinical.core']).toBe(true);expect(essential.features['organization.reports']).toBe(false);
 expect(evaluatePolicy({plan:'growth',mode:'enforced',disabled:['crm.workspace']}).features['crm.workspace']).toBe(false);
 expect(actionFeature('getOrganizationReports')).toBe('organization.reports');expect(actionFeature('getPatient')).toBeNull();
});
