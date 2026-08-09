CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"run_id" uuid,
	"step" "workflow_step" NOT NULL,
	"queue" text NOT NULL,
	"job_id" text,
	"payload" jsonb,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"stack" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retried_at" timestamp with time zone,
	"retried_by" text
);
--> statement-breakpoint
CREATE TABLE "source_cursors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"cursor" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dead_letters_document_idx" ON "dead_letters" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "dead_letters_run_idx" ON "dead_letters" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "dead_letters_failed_at_idx" ON "dead_letters" USING btree ("failed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_cursors_source_key" ON "source_cursors" USING btree ("source");--> statement-breakpoint
CREATE INDEX "documents_source_path_idx" ON "documents" USING btree ("source_type","source_path");