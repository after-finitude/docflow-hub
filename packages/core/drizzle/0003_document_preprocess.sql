ALTER TABLE "documents" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "duplicate_of_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_duplicate_of_id_documents_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;