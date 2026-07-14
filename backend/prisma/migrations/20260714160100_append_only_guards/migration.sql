-- Spec §4 invariant 2: routing_history and audit_log are APPEND-ONLY.
-- Enforced at the database level so no code path — present or future — can
-- update or delete rows, not even through raw SQL from the app role.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER routing_history_append_only
  BEFORE UPDATE OR DELETE ON routing_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
