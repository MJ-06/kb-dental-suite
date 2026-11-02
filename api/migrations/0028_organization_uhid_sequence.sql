-- Keep the existing visible UHID format, allocate one sequence per linked
-- organization, and never truncate sequences when they outgrow their padding.
CREATE FUNCTION clinical_allocate_uhid(reserve boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE original uuid:=app_clinic_id(); org uuid; primary_clinic uuid; scope uuid;
 u record; n bigint:=0; seen bigint:=0; candidate bigint; counter_key text;
BEGIN
 IF original IS NULL THEN RAISE EXCEPTION 'No clinic is set' USING ERRCODE='42501'; END IF;
 SELECT organization_id INTO org FROM org_clinical_units WHERE clinic_id=original;
 IF org IS NOT NULL THEN
   PERFORM set_config('app.organization_id',org::text,true);
   IF reserve THEN PERFORM pg_advisory_xact_lock(hashtextextended(org::text,2500)); END IF;
   SELECT b.clinic_id INTO primary_clinic FROM org_clinical_units b JOIN org_units x ON x.id=b.unit_id
     WHERE b.organization_id=org ORDER BY x.code,b.clinic_id LIMIT 1;
 ELSE primary_clinic:=original; END IF;
 PERFORM set_config('app.clinic_id',primary_clinic::text,true);
 SELECT * INTO u FROM uhid_period();
 FOR scope IN SELECT original WHERE org IS NULL UNION SELECT clinic_id FROM org_clinical_units WHERE organization_id=org LOOP
   PERFORM set_config('app.clinic_id',scope::text,true);
   SELECT greatest(coalesce((SELECT last_value FROM uhid_counters WHERE period=u.period),0),
     coalesce((SELECT max(substring(uhid FROM length(u.prefix)+1)::bigint) FROM patients
       WHERE uhid ~ ('^'||u.prefix||'[0-9]+$') AND length(uhid)<=length(u.prefix)+10),0)) INTO candidate;
   seen:=greatest(seen,candidate);
 END LOOP;
 PERFORM set_config('app.clinic_id',original::text,true);
 IF org IS NULL THEN
   IF reserve THEN
     INSERT INTO uhid_counters(period,last_value) VALUES(u.period,0) ON CONFLICT DO NOTHING;
     UPDATE uhid_counters SET last_value=greatest(last_value,seen)+1 WHERE period=u.period RETURNING last_value INTO n;
   ELSE n:=seen+1; END IF;
 ELSE
   SELECT coalesce(max(substring(uhid FROM length(u.prefix)+1)::bigint),0) INTO candidate FROM org_patients
     WHERE uhid ~ ('^'||u.prefix||'[0-9]+$') AND length(uhid)<=length(u.prefix)+10;
   seen:=greatest(seen,candidate);
   counter_key:='clinical_uhid:'||u.prefix||':'||u.period;
   IF reserve THEN
     INSERT INTO org_counters(key,value) VALUES(counter_key,seen+1)
      ON CONFLICT(organization_id,key) DO UPDATE SET value=greatest(org_counters.value,seen)+1 RETURNING value INTO n;
   ELSE SELECT greatest(coalesce((SELECT value FROM org_counters WHERE key=counter_key),0),seen)+1 INTO n; END IF;
 END IF;
 RETURN u.prefix||lpad(n::text,greatest(u.width,length(n::text)),'0');
END $$;
CREATE OR REPLACE FUNCTION next_uhid() RETURNS text LANGUAGE sql AS $$SELECT clinical_allocate_uhid(true)$$;
CREATE OR REPLACE FUNCTION peek_uhid() RETURNS text LANGUAGE sql AS $$SELECT clinical_allocate_uhid(false)$$;
