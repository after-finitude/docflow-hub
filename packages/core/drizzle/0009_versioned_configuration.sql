CREATE TABLE "export_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"default_destination" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_schemas" ADD COLUMN "export_mapping" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_schemas" ADD COLUMN "seed_fingerprint" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "schema_version_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extraction_schema_version_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_schema_version_id_document_schemas_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."document_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_extraction_schema_version_id_document_schemas_id_fk" FOREIGN KEY ("extraction_schema_version_id") REFERENCES "public"."document_schemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Resolve multiple active rows left by old concurrent threshold updates.
UPDATE document_schemas older SET is_active = false
WHERE older.is_active AND EXISTS (
  SELECT 1 FROM document_schemas newer
  WHERE newer.document_type = older.document_type AND newer.is_active AND newer.version > older.version
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_schemas_active_type_key" ON "document_schemas" USING btree ("document_type") WHERE "document_schemas"."is_active";
--> statement-breakpoint
UPDATE document_schemas SET export_mapping = '[{"column":"Document","source":"meta:documentId"},{"column":"File","source":"meta:originalFilename"},{"column":"Supplier","source":"field:supplier_name"},{"column":"Number","source":"field:invoice_number"},{"column":"Date","source":"field:invoice_date"},{"column":"Due date","source":"field:due_date"},{"column":"Currency","source":"field:currency"},{"column":"Subtotal","source":"field:subtotal"},{"column":"Tax","source":"field:tax_total"},{"column":"Total","source":"field:grand_total"},{"column":"Line items","source":"meta:lineItemCount"},{"column":"Approved at","source":"meta:approvedAt"}]'::jsonb WHERE document_type = 'invoice';

--> statement-breakpoint
UPDATE document_schemas SET export_mapping = '[{"column":"Document","source":"meta:documentId"},{"column":"File","source":"meta:originalFilename"},{"column":"Bank","source":"field:bank_name"},{"column":"Account","source":"field:account_number"},{"column":"Period start","source":"field:period_start"},{"column":"Period end","source":"field:period_end"},{"column":"Opening balance","source":"field:opening_balance"},{"column":"Closing balance","source":"field:closing_balance"},{"column":"Currency","source":"field:currency"},{"column":"Approved at","source":"meta:approvedAt"}]'::jsonb WHERE document_type = 'bank_statement';

--> statement-breakpoint
UPDATE document_schemas SET export_mapping = '[{"column":"Document","source":"meta:documentId"},{"column":"File","source":"meta:originalFilename"},{"column":"Authority","source":"field:authority_name"},{"column":"Letter number","source":"field:letter_number"},{"column":"Letter date","source":"field:letter_date"},{"column":"Taxpayer","source":"field:taxpayer_name"},{"column":"Taxpayer ID","source":"field:taxpayer_id"},{"column":"Subject","source":"field:subject"},{"column":"Amount due","source":"field:amount_due"},{"column":"Due date","source":"field:due_date"},{"column":"Approved at","source":"meta:approvedAt"}]'::jsonb WHERE document_type = 'tax_letter';

--> statement-breakpoint
UPDATE document_schemas SET export_mapping = '[{"column":"Document","source":"meta:documentId"},{"column":"File","source":"meta:originalFilename"},{"column":"Contract number","source":"field:contract_number"},{"column":"Contract date","source":"field:contract_date"},{"column":"Party A","source":"field:party_a"},{"column":"Party B","source":"field:party_b"},{"column":"Subject","source":"field:subject"},{"column":"Value","source":"field:contract_value"},{"column":"Currency","source":"field:currency"},{"column":"Start date","source":"field:start_date"},{"column":"End date","source":"field:end_date"},{"column":"Approved at","source":"meta:approvedAt"}]'::jsonb WHERE document_type = 'contract';

--> statement-breakpoint
-- Existing field rows carry the actual extraction version; do not use the active one.
UPDATE documents d SET schema_version_id = bound.schema_id
FROM (
  SELECT document_id, min(schema_version_id::text)::uuid AS schema_id
  FROM fields WHERE schema_version_id IS NOT NULL
  GROUP BY document_id HAVING count(DISTINCT schema_version_id) = 1
) bound WHERE d.id = bound.document_id;
--> statement-breakpoint
-- Empty results can still have a recorded validation decision.
UPDATE documents d SET schema_version_id = bound.schema_id
FROM (
  SELECT DISTINCT ON (a.object_id) a.object_id, s.id AS schema_id
  FROM audit_events a JOIN document_schemas s ON s.id::text = a.after->>'schemaId'
  WHERE a.object_type = 'document' AND a.action IN ('document.routed', 'document.validated')
  ORDER BY a.object_id, a.created_at DESC, a.event_id DESC
) bound WHERE d.id::text = bound.object_id AND d.schema_version_id IS NULL;
