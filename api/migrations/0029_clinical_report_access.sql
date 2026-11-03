-- Read grants for reporting without changing the session's working clinic.
CREATE FUNCTION clinical_report_access(hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a jsonb; s sessions%ROWTYPE; candidate record; target record; result jsonb:='[]';
BEGIN
 a:=clinical_actor(hash); IF a IS NULL OR a->>'organization_id' IS NULL THEN RETURN result; END IF;
 SELECT * INTO s FROM sessions WHERE token_hash=hash;
 FOR candidate IN
   SELECT s.clinic_id AS clinic_id,s.user_id AS user_id
   UNION SELECT g.clinic_id,g.user_id FROM org_clinical_access g
   WHERE g.principal_user_id=s.user_id AND g.principal_clinic_id=s.clinic_id
     AND g.organization_id=(a->>'organization_id')::uuid
 LOOP
   PERFORM set_config('app.clinic_id',candidate.clinic_id::text,true);
   SELECT c.id,c.name,c.timezone,u.id AS user_id INTO target FROM clinics c
   JOIN org_clinical_units b ON b.clinic_id=c.id AND b.organization_id=(a->>'organization_id')::uuid
   JOIN app_users u ON u.clinic_id=c.id AND u.id=candidate.user_id
   JOIN roles r ON r.clinic_id=c.id AND r.id=u.role_id
   WHERE c.id=candidate.clinic_id AND c.active AND u.active
     AND r.permissions @> ARRAY['reports:read','finance:read']::text[];
   IF FOUND THEN result:=result||jsonb_build_array(to_jsonb(target)); END IF;
 END LOOP;
 PERFORM set_config('app.clinic_id',a->>'clinic_id',true);
 PERFORM set_config('app.user_id',a->>'user_id',true);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION clinical_report_access(bytea) FROM PUBLIC;
