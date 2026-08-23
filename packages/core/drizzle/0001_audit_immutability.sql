-- Application role permissions (spec §11).
--
-- docflow_app has no UPDATE or DELETE on audit_events; the log is append/read
-- only. The owner role runs DDL and migrations.
--
-- Keep this role name in sync with docker/postgres/init/01-app-role.sh and DATABASE_URL.

GRANT USAGE ON SCHEMA public TO docflow_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO docflow_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO docflow_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM docflow_app;--> statement-breakpoint
-- The owner creates later tables and grants default privileges; the audit_events
-- revocation above remains in effect.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docflow_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO docflow_app;
