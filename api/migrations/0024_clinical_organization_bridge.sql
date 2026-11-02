-- Explicit bridge from the preserved clinical suite to organization units.
-- Only the owner/provisioner may create links or grant cross-clinic access.
CREATE TABLE org_clinical_units (
 organization_id uuid NOT NULL REFERENCES org_identity(id),
 unit_id uuid NOT NULL, clinic_id uuid NOT NULL UNIQUE REFERENCES clinics(id),
 PRIMARY KEY(organization_id,clinic_id), UNIQUE(organization_id,unit_id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id)
);
CREATE TABLE org_clinical_access (
 organization_id uuid NOT NULL,
 principal_clinic_id uuid NOT NULL, principal_user_id uuid NOT NULL,
 clinic_id uuid NOT NULL, user_id uuid NOT NULL,
 manage_organization boolean NOT NULL DEFAULT false,
 PRIMARY KEY(principal_user_id,clinic_id),
 FOREIGN KEY(organization_id,principal_clinic_id) REFERENCES org_clinical_units(organization_id,clinic_id),
 FOREIGN KEY(organization_id,clinic_id) REFERENCES org_clinical_units(organization_id,clinic_id),
 FOREIGN KEY(principal_clinic_id,principal_user_id) REFERENCES app_users(clinic_id,id),
 FOREIGN KEY(clinic_id,user_id) REFERENCES app_users(clinic_id,id)
);
CREATE TABLE org_clinical_context (
 token_hash bytea PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 clinic_id uuid NOT NULL REFERENCES clinics(id), revision integer NOT NULL DEFAULT 1,
 master_until timestamptz, master_fingerprint text
);
ALTER TABLE org_clinical_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_clinical_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_clinical_context ENABLE ROW LEVEL SECURITY;
-- No runtime policies: functions below expose only the session's authorized data.

CREATE FUNCTION clinical_actor(hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record; s sessions%ROWTYPE; ctx org_clinical_context%ROWTYPE;
 org uuid; target_user uuid; target record; management boolean;
BEGIN
 -- Serializes requests and switches for a session, including writes already in flight.
 SELECT * INTO s FROM sessions WHERE token_hash=hash AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO a FROM session_resume(hash);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT organization_id INTO org FROM org_clinical_units WHERE clinic_id=s.clinic_id;
 IF org IS NULL THEN RETURN to_jsonb(a); END IF;
 PERFORM set_config('app.organization_id',org::text,true);
 INSERT INTO org_clinical_context(token_hash,clinic_id) VALUES(hash,s.clinic_id) ON CONFLICT DO NOTHING;
 SELECT * INTO ctx FROM org_clinical_context WHERE token_hash=hash;
 SELECT g.user_id,g.manage_organization INTO target_user,management
 FROM org_clinical_access g WHERE g.principal_clinic_id=s.clinic_id
 AND g.principal_user_id=s.user_id AND g.clinic_id=ctx.clinic_id AND g.organization_id=org;
 IF target_user IS NULL THEN
   IF ctx.clinic_id<>s.clinic_id THEN RETURN NULL; END IF;
   target_user:=s.user_id; management:=false;
 END IF;
 PERFORM set_config('app.clinic_id',ctx.clinic_id::text,true);
 PERFORM set_config('app.user_id',target_user::text,true);
 SELECT u.id AS user_id,u.clinic_id,r.id AS role_id,r.name::text AS role,r.permissions,
 u.display_name,u.username::text,c.timezone,b.unit_id INTO target
 FROM app_users u JOIN roles r ON r.clinic_id=u.clinic_id AND r.id=u.role_id
 JOIN clinics c ON c.id=u.clinic_id
 JOIN org_clinical_units b ON b.clinic_id=c.id AND b.organization_id=org
 WHERE u.id=target_user AND u.active AND c.active;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(target)||jsonb_build_object('organization_id',org,'principal_id',s.user_id,
 'clinic_revision',ctx.revision,'manage_organization',coalesce(management,false));
END $$;

CREATE FUNCTION clinical_clinics(hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a jsonb; s sessions%ROWTYPE; result jsonb;
BEGIN
 a:=clinical_actor(hash); IF a IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO s FROM sessions WHERE token_hash=hash;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'name',c.name) ORDER BY c.name),'[]')
 INTO result FROM clinics c WHERE c.active AND (c.id=s.clinic_id OR EXISTS(
 SELECT 1 FROM org_clinical_access g JOIN org_clinical_units b
 ON b.clinic_id=g.clinic_id AND b.organization_id=g.organization_id
 WHERE g.principal_clinic_id=s.clinic_id AND g.principal_user_id=s.user_id
 AND g.clinic_id=c.id AND g.organization_id=(a->>'organization_id')::uuid));
 RETURN jsonb_build_object('clinic_id',a->>'clinic_id','revision',a->'clinic_revision',
 'organization_id',a->>'organization_id','clinics',result);
END $$;

CREATE FUNCTION clinical_switch(hash bytea, destination uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE available jsonb; result jsonb;
BEGIN
 available:=clinical_clinics(hash);
 IF available IS NULL OR available->>'organization_id' IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(available->'clinics') c WHERE c->>'id'=destination::text) THEN RETURN NULL; END IF;
 UPDATE org_clinical_context SET clinic_id=destination,revision=revision+1,
 master_until=NULL,master_fingerprint=NULL WHERE token_hash=hash;
 result:=clinical_actor(hash);
 IF result IS NULL THEN RAISE EXCEPTION 'Clinic access is no longer available' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION clinical_end_session(hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DELETE FROM sessions WHERE token_hash=hash
$$;

CREATE FUNCTION clinical_unlock_master(hash bytea, fingerprint text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE org_clinical_context SET master_until=now()+interval '15 minutes',master_fingerprint=fingerprint
 WHERE token_hash=hash
$$;
CREATE FUNCTION clinical_master_is_unlocked(hash bytea, fingerprint text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM org_clinical_context WHERE token_hash=hash
 AND master_until>now() AND master_fingerprint=fingerprint)
$$;
