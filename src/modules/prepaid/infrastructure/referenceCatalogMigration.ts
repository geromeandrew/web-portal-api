import { prepaidReferencePolicyMigrationSql } from "./referencePolicyMigration.js";

/** 013: append-only reference versions. No master table overwrite or historic run changes. */
export function prepaidReferenceCatalogMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error("Invalid schema");
  const s = `"${schema}"`;
  const policy = prepaidReferencePolicyMigrationSql(schema).replace(
    "AND config->'referenceExport'->>'approved'='true' THEN",
    `AND (config->'referenceExport'->>'approved'='true' OR
      (config->'referenceVersion'->>'approved'='true' AND EXISTS(
        SELECT 1 FROM ${s}.prepaid_reference_versions v
        WHERE v.sha256=config->'referenceVersion'->>'sha256' AND v.sealed
          AND v.row_count=(config->'referenceVersion'->>'rowCount')::integer))) THEN`,
  );
  return `
CREATE TABLE ${s}.prepaid_reference_versions (
 sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 250000),
 source_bytes bytea NOT NULL CHECK(octet_length(source_bytes) BETWEEN 1 AND 20971520),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 validated_period text NOT NULL CHECK(validated_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 approval_scope text NOT NULL CHECK(approval_scope IN('development-testing','accounting-accepted')),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
 approved_by uuid NOT NULL REFERENCES ${s}.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 sealed boolean NOT NULL DEFAULT false,
 CHECK(encode(pg_catalog.sha256(source_bytes),'hex')=sha256)
);
CREATE TABLE ${s}.prepaid_reference_version_rows (
 version_sha256 text NOT NULL REFERENCES ${s}.prepaid_reference_versions(sha256),
 row_number integer NOT NULL CHECK(row_number>0),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
 PRIMARY KEY(version_sha256,row_number)
);
CREATE FUNCTION ${s}.prepaid_guard_reference_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ready boolean; actual integer;
BEGIN
 IF TG_TABLE_NAME='prepaid_reference_versions' THEN
   IF TG_OP='INSERT' THEN
     IF NEW.sealed THEN RAISE EXCEPTION 'PREPAID_REFERENCE_VERSION_MUST_BE_SEALED_AFTER_ROWS'; END IF;
     RETURN NEW;
   END IF;
   IF TG_OP='UPDATE' AND NOT OLD.sealed AND NEW.sealed
     AND (to_jsonb(OLD)-'sealed')=(to_jsonb(NEW)-'sealed') THEN
     SELECT count(*) INTO actual FROM ${s}.prepaid_reference_version_rows WHERE version_sha256=OLD.sha256;
     IF actual<>NEW.row_count THEN RAISE EXCEPTION 'PREPAID_REFERENCE_ROW_COUNT_MISMATCH'; END IF;
     RETURN NEW;
   END IF;
   RAISE EXCEPTION 'PREPAID_REFERENCE_VERSION_IMMUTABLE';
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PREPAID_REFERENCE_VERSION_IMMUTABLE'; END IF;
 SELECT sealed INTO ready FROM ${s}.prepaid_reference_versions WHERE sha256=NEW.version_sha256 FOR UPDATE;
 IF ready IS DISTINCT FROM false THEN RAISE EXCEPTION 'PREPAID_REFERENCE_VERSION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepaid_reference_version_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.prepaid_reference_versions
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_reference_version();
CREATE TRIGGER prepaid_reference_version_row_guard BEFORE INSERT OR UPDATE OR DELETE ON ${s}.prepaid_reference_version_rows
 FOR EACH ROW EXECUTE FUNCTION ${s}.prepaid_guard_reference_version();
CREATE TRIGGER prepaid_reference_version_truncate_guard BEFORE TRUNCATE ON ${s}.prepaid_reference_versions
 FOR EACH STATEMENT EXECUTE FUNCTION ${s}.prepaid_guard_reference_version();
CREATE TRIGGER prepaid_reference_version_rows_truncate_guard BEFORE TRUNCATE ON ${s}.prepaid_reference_version_rows
 FOR EACH STATEMENT EXECUTE FUNCTION ${s}.prepaid_guard_reference_version();
${policy}`;
}
