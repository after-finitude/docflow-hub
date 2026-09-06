ALTER TABLE "documents" ADD COLUMN "processing_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "processing_step" "workflow_step" DEFAULT 'preprocess';--> statement-breakpoint
-- Preserve the expected stage for jobs already queued during the upgrade.
UPDATE "documents" d SET "processing_step" = CASE
  WHEN d.status = 'received' THEN 'preprocess'::workflow_step
  WHEN d.status = 'processing' THEN COALESCE((
    SELECT CASE WHEN r.state = 'succeeded' THEN CASE r.step
      WHEN 'preprocess' THEN 'ocr'::workflow_step
      WHEN 'ocr' THEN 'classification'::workflow_step
      WHEN 'classification' THEN 'extraction'::workflow_step
      WHEN 'extraction' THEN 'validation'::workflow_step
      ELSE r.step END ELSE r.step END
    FROM workflow_runs r
    WHERE r.document_id = d.id AND r.step IN ('preprocess', 'ocr', 'classification', 'extraction', 'validation')
    ORDER BY r.started_at DESC NULLS LAST LIMIT 1
  ), 'preprocess'::workflow_step)
  ELSE NULL END;
