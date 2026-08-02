CREATE TYPE "public"."actor_type" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('received', 'processing', 'needs_review', 'approved', 'exported', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('invoice', 'bank_statement', 'tax_letter', 'contract', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('info', 'warning', 'blocking');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('upload', 'email', 'drive');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('operator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."value_type" AS ENUM('string', 'number', 'date', 'currency', 'enum', 'boolean', 'array');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workflow_step" AS ENUM('ingestion', 'preprocess', 'ocr', 'classification', 'extraction', 'validation', 'export');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"correlation_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"before" jsonb,
	"after" jsonb,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"export_key" text NOT NULL,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"payload_ref" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"exported_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_schemas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_type" "document_type" NOT NULL,
	"version" integer NOT NULL,
	"json_schema" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_path" text,
	"source_message_id" text,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"document_type" "document_type",
	"type_confidence" real,
	"status" "document_status" DEFAULT 'received' NOT NULL,
	"status_reason" text,
	"version_number" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"schema_version_id" uuid,
	"name" text NOT NULL,
	"raw_value" text,
	"normalized_value" jsonb,
	"value_type" "value_type" NOT NULL,
	"confidence" real,
	"confidence_reason" text,
	"source_page" integer,
	"source_bbox" jsonb,
	"source_found" boolean DEFAULT false NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"ocr_text" text,
	"ocr_confidence" real,
	"width" integer,
	"height" integer,
	"blocks" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"login" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_issues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"field_name" text,
	"rule_id" text NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"message" text NOT NULL,
	"expected" text,
	"actual" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"step" "workflow_step" NOT NULL,
	"state" "workflow_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correlation_id" uuid NOT NULL,
	"error_code" text,
	"error_detail" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_schema_version_id_document_schemas_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."document_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_issues" ADD CONSTRAINT "validation_issues_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_export_key_key" ON "exports" USING btree ("export_key");--> statement-breakpoint
CREATE INDEX "exports_document_idx" ON "exports" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_schemas_type_version_key" ON "document_schemas" USING btree ("document_type","version");--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_checksum_idx" ON "documents" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "documents_received_at_idx" ON "documents" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_document_name_key" ON "fields" USING btree ("document_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_document_page_key" ON "pages" USING btree ("document_id","page_number");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_key" ON "users" USING btree ("login");--> statement-breakpoint
CREATE INDEX "validation_issues_document_idx" ON "validation_issues" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "validation_issues_severity_idx" ON "validation_issues" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "workflow_runs_document_idx" ON "workflow_runs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_correlation_idx" ON "workflow_runs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_state_idx" ON "workflow_runs" USING btree ("state");