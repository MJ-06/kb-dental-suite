-- Share identity, never clinic notes/payments. Legacy references remain intact.
CREATE TABLE org_clinical_patient_links (
 organization_id uuid NOT NULL DEFAULT org_id(), clinic_id uuid NOT NULL,
 patient_id uuid NOT NULL, organization_patient_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid,
 PRIMARY KEY(clinic_id,patient_id), UNIQUE(organization_id,clinic_id,organization_patient_id),
 FOREIGN KEY(organization_id,clinic_id) REFERENCES org_clinical_units(organization_id,clinic_id),
 FOREIGN KEY(clinic_id,patient_id) REFERENCES patients(clinic_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,organization_patient_id) REFERENCES org_patients(organization_id,id)
);
ALTER TABLE org_clinical_patient_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_clinical_patient_links FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON org_clinical_patient_links USING(organization_id=org_id()) WITH CHECK(organization_id=org_id());
CREATE TRIGGER touch BEFORE INSERT OR UPDATE ON org_clinical_patient_links FOR EACH ROW EXECUTE FUNCTION org_touch();
CREATE INDEX org_patients_identity_name ON org_patients(organization_id,lower(name));

CREATE FUNCTION clinical_publish_patient(patient uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p patients%ROWTYPE; org uuid; unit uuid; canonical uuid; candidate text; n bigint;
BEGIN
 SELECT * INTO p FROM patients WHERE id=patient AND clinic_id=app_clinic_id() AND deleted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT organization_id,unit_id INTO org,unit FROM org_clinical_units WHERE clinic_id=p.clinic_id;
 IF org IS NULL THEN RETURN NULL; END IF;
 PERFORM set_config('app.organization_id',org::text,true);
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,2500));
 SELECT organization_patient_id INTO canonical FROM org_clinical_patient_links WHERE clinic_id=p.clinic_id AND patient_id=p.id;
 IF canonical IS NOT NULL THEN RETURN canonical; END IF;
 candidate:=p.uhid;
 -- Same name, phone or UHID is NEVER proof that two old patients are one person.
 WHILE EXISTS(SELECT 1 FROM org_patients WHERE uhid=candidate) LOOP
   INSERT INTO org_counters(key,value) VALUES('clinical_identity_alias',1)
    ON CONFLICT(organization_id,key) DO UPDATE SET value=org_counters.value+1 RETURNING value INTO n;
   candidate:='OP'||lpad(n::text,8,'0');
 END LOOP;
 INSERT INTO org_patients(uhid,name,phone,gender,dob,registration_unit_id)
 VALUES(candidate,p.full_name,coalesce(p.mobile,''),p.gender,p.date_of_birth,unit) RETURNING id INTO canonical;
 INSERT INTO org_clinical_patient_links(clinic_id,patient_id,organization_patient_id) VALUES(p.clinic_id,p.id,canonical);
 INSERT INTO org_audit(actor_id,unit_id,action,subject_id) VALUES(app_user_id(),unit,'clinical.identity_published',canonical);
 RETURN canonical;
END $$;

CREATE FUNCTION clinical_patient_identity_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE canonical uuid;
BEGIN
 canonical:=clinical_publish_patient(NEW.id);
 IF canonical IS NULL OR TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF (NEW.full_name,NEW.mobile,NEW.gender,NEW.date_of_birth) IS DISTINCT FROM (OLD.full_name,OLD.mobile,OLD.gender,OLD.date_of_birth) THEN
   UPDATE org_patients SET
    name=CASE WHEN NEW.full_name IS DISTINCT FROM OLD.full_name THEN NEW.full_name ELSE name END,
    phone=CASE WHEN NEW.mobile IS DISTINCT FROM OLD.mobile THEN coalesce(NEW.mobile,'') ELSE phone END,
    gender=CASE WHEN NEW.gender IS DISTINCT FROM OLD.gender THEN NEW.gender ELSE gender END,
    dob=CASE WHEN NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth THEN NEW.date_of_birth ELSE dob END
   WHERE id=canonical;
   INSERT INTO org_audit(actor_id,action,subject_id) VALUES(app_user_id(),'clinical.identity_updated',canonical);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER organization_patient_identity AFTER INSERT OR UPDATE ON patients
 FOR EACH ROW EXECUTE FUNCTION clinical_patient_identity_changed();

CREATE FUNCTION clinical_attach_patient(canonical uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE org uuid; existing uuid; p org_patients%ROWTYPE; local_id uuid:=uuidv7(); local_uhid text;
BEGIN
 SELECT organization_id INTO org FROM org_clinical_units WHERE clinic_id=app_clinic_id();
 IF org IS NULL OR org IS DISTINCT FROM org_id() THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_users u JOIN roles r ON r.id=u.role_id AND r.clinic_id=u.clinic_id
 WHERE u.id=app_user_id() AND u.active AND r.permissions @> ARRAY['patients:write']::text[]) THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text,2500));
 SELECT * INTO p FROM org_patients WHERE id=canonical AND organization_id=org;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT patient_id INTO existing FROM org_clinical_patient_links WHERE clinic_id=app_clinic_id() AND organization_patient_id=canonical;
 IF existing IS NOT NULL THEN
   SELECT uhid INTO local_uhid FROM patients WHERE id=existing AND deleted_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'An archived patient record already exists at this clinic' USING ERRCODE='23514'; END IF;
   RETURN jsonb_build_object('id',existing,'uhid',local_uhid);
 END IF;
 local_uhid:=p.uhid;
 IF EXISTS(SELECT 1 FROM patients WHERE uhid=local_uhid) THEN local_uhid:=next_uhid(); END IF;
 -- Deferred FK lets the insert trigger see the explicit identity link first.
 INSERT INTO org_clinical_patient_links(clinic_id,patient_id,organization_patient_id) VALUES(app_clinic_id(),local_id,p.id);
 INSERT INTO patients(id,uhid,full_name,mobile,gender,date_of_birth,registration_status)
 VALUES(local_id,local_uhid,p.name,nullif(p.phone,''),p.gender,p.dob,'Quick');
 INSERT INTO org_audit(actor_id,action,subject_id) VALUES(app_user_id(),'clinical.patient_added_to_clinic',p.id);
 RETURN jsonb_build_object('id',local_id,'uhid',local_uhid);
END $$;
