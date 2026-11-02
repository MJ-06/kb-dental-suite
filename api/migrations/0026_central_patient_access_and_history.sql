-- Opening a central identity needs no second registration. The local row is
-- a compatibility reference for existing clinic foreign keys, not another identity.
CREATE FUNCTION clinical_open_patient(canonical uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org uuid; existing uuid; p org_patients%ROWTYPE; local_id uuid:=uuidv7(); local_uhid text;
BEGIN
 SELECT organization_id INTO org FROM org_clinical_units WHERE clinic_id=app_clinic_id();
 IF org IS NULL OR org IS DISTINCT FROM org_id() THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_users u JOIN roles r ON r.id=u.role_id AND r.clinic_id=u.clinic_id
 WHERE u.id=app_user_id() AND u.active AND r.permissions @> ARRAY['patients:read']::text[]) THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,2500));
 SELECT * INTO p FROM org_patients WHERE id=canonical AND organization_id=org;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT patient_id INTO existing FROM org_clinical_patient_links WHERE clinic_id=app_clinic_id() AND organization_patient_id=canonical;
 IF existing IS NOT NULL THEN
   SELECT uhid INTO local_uhid FROM patients WHERE id=existing AND deleted_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'An archived patient reference exists at this clinic' USING ERRCODE='23514'; END IF;
   RETURN jsonb_build_object('id',existing,'uhid',local_uhid);
 END IF;
 local_uhid:=p.uhid;
 IF EXISTS(SELECT 1 FROM patients WHERE uhid=local_uhid) THEN local_uhid:=next_uhid(); END IF;
 INSERT INTO org_clinical_patient_links(clinic_id,patient_id,organization_patient_id) VALUES(app_clinic_id(),local_id,p.id);
 INSERT INTO patients(id,uhid,full_name,mobile,gender,date_of_birth,registration_status)
 VALUES(local_id,local_uhid,p.name,nullif(p.phone,''),p.gender,p.dob,'Quick');
 INSERT INTO org_audit(actor_id,action,subject_id) VALUES(app_user_id(),'clinical.patient_opened_at_clinic',p.id);
 RETURN jsonb_build_object('id',local_id,'uhid',local_uhid);
END $$;

-- Only the session principal's explicit, currently valid clinical grants.
CREATE FUNCTION clinical_history_access(hash bytea) RETURNS jsonb
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
     AND r.permissions @> ARRAY['patients:read','clinical:read']::text[];
   IF FOUND THEN result:=result||jsonb_build_array(to_jsonb(target)); END IF;
 END LOOP;
 PERFORM set_config('app.clinic_id',a->>'clinic_id',true);
 PERFORM set_config('app.user_id',a->>'user_id',true);
 RETURN result;
END $$;
