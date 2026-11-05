import {it,expect} from 'vitest';import pg from 'pg';import {preservePostgresDates} from '../src/migration/pg-dates.js';
it('keeps birthday, leap-day and receipt dates unchanged through migration JSON',()=>{
 const original=pg.types.getTypeParser(1082);try{preservePostgresDates();for(const day of ['1990-01-15','2024-02-29','2026-11-05']){
  const decoded=pg.types.getTypeParser(1082)(day);expect(JSON.parse(JSON.stringify({day:decoded})).day).toBe(day);
 }}finally{pg.types.setTypeParser(1082,original);}
});
