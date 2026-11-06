import {Type} from '@sinclair/typebox';import type {FastifyPluginAsyncTypebox} from '@fastify/type-provider-typebox';
import {asActor} from '../http/context.js';import type {AppOptions} from '../app.js';import {emitUsage,usageConfig,USAGE_SCREENS} from '../usage.js';
export const usageRoutes:FastifyPluginAsyncTypebox<AppOptions>=async(app,{db})=>{
 app.post('/screen',{schema:{body:Type.Object({screen:Type.Union(USAGE_SCREENS.map(s=>Type.Literal(s)))},{additionalProperties:false})}},async req=>asActor(db,req,null,async(_tx,actor)=>{emitUsage(actor,'screen',req.body.screen,0,true,new Set());return {ok:true};}));
 app.get('/status',async req=>asActor(db,req,'roles:manage',async()=>({enabled:!!usageConfig(),localDashboard:usageConfig()?.url??null,sessionReplay:false,patientData:false})));
};
