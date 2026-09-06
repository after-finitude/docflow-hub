ALTER TABLE "exports" ADD COLUMN "canonical_payload" jsonb;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "mapping_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "export_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_export_id_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."exports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exports_sheet_row_key" ON "exports" USING btree (("target"->>'spreadsheetId'),("target"->>'sheetId'),("target"->>'row'));--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_export_key" ON "workflow_runs" USING btree ("export_id");