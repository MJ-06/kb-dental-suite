import {describe,expect,it} from 'vitest';
import {archiveClock,DEFAULT_POLICY,expiredArchives,scheduledDay,validatePolicy} from '../src/archive/policy.js';

describe('organization archive scheduling and retention',()=>{
 it('uses the organization timezone and catches up once after the scheduled time',()=>{
  const now=new Date('2026-11-06T18:00:00Z');
  expect(archiveClock(now,'Asia/Kolkata')).toEqual({day:'2026-11-06',month:'2026-11',time:'23:30'});
  expect(scheduledDay({...DEFAULT_POLICY,enabled:true},now,'Asia/Kolkata',[])).toBe('2026-11-06');
  expect(scheduledDay({...DEFAULT_POLICY,enabled:true},now,'Asia/Kolkata',['2026-11-06'])).toBeNull();
  expect(scheduledDay(DEFAULT_POLICY,now,'Asia/Kolkata',[])).toBeNull();
  expect(scheduledDay({...DEFAULT_POLICY,enabled:true},new Date('2026-11-06T16:00:00Z'),'Asia/Kolkata',[])).toBeNull();
 });
 it('keeps recent daily copies plus one successful copy in each retained month',()=>{
  const runs=[
   {id:'new',day:'2026-11-06',status:'succeeded'},
   {id:'nov-first',day:'2026-11-01',status:'succeeded'},
   {id:'oct-first',day:'2026-10-01',status:'succeeded'},
   {id:'oct-extra',day:'2026-10-05',status:'succeeded'},
   {id:'sep',day:'2026-09-01',status:'succeeded'},
   {id:'failed',day:'2026-08-01',status:'failed'}
  ];
  expect(expiredArchives(runs,'2026-11-06',{...DEFAULT_POLICY,dailyDays:3,monthlyMonths:2})).toEqual(['oct-extra','sep']);
  expect(expiredArchives(runs,'2026-11-06',{...DEFAULT_POLICY,dailyDays:3,monthlyMonths:0})).toEqual(['nov-first','oct-first','oct-extra','sep']);
 });
 it('rejects malformed policy rather than disabling retention by coercion',()=>{
  expect(()=>validatePolicy({...DEFAULT_POLICY,dailyDays:0})).toThrow();
  expect(()=>validatePolicy({...DEFAULT_POLICY,dailyAt:'25:00'})).toThrow();
  expect(()=>validatePolicy({...DEFAULT_POLICY,enabled:'false'})).toThrow();
  expect(()=>validatePolicy({...DEFAULT_POLICY,folder:'../../'})).toThrow();
 });
});
