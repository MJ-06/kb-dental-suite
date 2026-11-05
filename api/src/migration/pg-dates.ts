import pg from 'pg';
// A DATE is a calendar value, not a local-midnight instant. Keep its literal
// representation when carrying database rows through JSON during migration.
export function preservePostgresDates(){pg.types.setTypeParser(1082,value=>value);}
