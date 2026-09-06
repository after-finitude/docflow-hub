# Technical Specification v2 Completion Plan

Status: phase 1 implemented and verified offline; phases 2–8 remain planned. Full specification compliance has not been established.

Requirements source: `TZ-1-Document-Operations-Hub-v2.md`, supplied by the user. Section numbers below refer to that document. This plan covers the gaps identified during the 2026-09-06 review; phase 1 was implemented on 2026-09-06.

## Baseline and scope

- Existing foundation: authentication, ingestion, OCR/LLM providers, evidence matching, validation, review, export, source synchronization, versions, execution log, and retention.
- Phase 1 verification: 110 tests pass; mock evaluation passes on 43 documents, including 15 labeled documents. These results do not establish real-provider quality or complete acceptance.
- Live integration and browser verification remain unconfirmed because Docker was unavailable during the review.
- Keep the existing workspace structure and shared processing modules. Use `node:test` and the existing verification tools; add no test framework or general-purpose workflow abstraction.
- No settings screen, multi-tenancy, additional document types, automatic PDF splitting, or additional cross-document reconciliation is planned.
- Complete stages in order. Add focused regression checks with each fix. Run full acceptance after the functional changes are complete.

## 1. Extraction contracts and manual recovery

Specification: 6.4, 9, 10; acceptance criteria 3, 4, 8.

Primary files: `packages/shared/src/contracts/llm.ts`, `packages/shared/src/pipeline/field-builder.ts`, `apps/worker/src/llm/openai-compatible-llm.provider.ts`, `apps/worker/src/extract/extract.processor.ts`.

- [x] Accept and validate flat `line_items` objects with `description`, `quantity`, `unit_price`, and `amount`; reuse the existing line-item contract.
- [x] Validate extraction against the selected document schema: expected names, no duplicate or unknown fields, and field-appropriate value shapes. Keep verbatim scalar values and normalize them in the existing shared builder.
- [x] Apply the same response contract to mock and real providers. Make the mock extract line items from fixtures that contain them instead of always returning Missing.
- [x] Run the existing two-repair policy on schema failures as well as malformed JSON.
- [x] After exhausted repairs on initial extraction, create editable Missing fields from the schema and validate them before exposing manual review. Preserve the original and OCR data.
- [x] Replace extracted fields atomically. A failed re-extraction must not delete the previous values or their audit history.

**Done when:** an invoice with line items survives extraction and canonical export; absent items remain explicitly absent; malformed responses lead to a usable manual form whose missing required fields block approval. Focused checks cover arrays, invalid names/types, repair exhaustion, and re-extraction failure.

Verification (2026-09-06): `npm test` runs 110 passing tests, including selected-schema contracts and `scripts/extraction.test.mjs`. The latter covers fixture PDF → mock OCR → extraction → canonical export, missing items, two repairs, manual recovery with blocking required-field issues, preserved original/OCR/audit data, and replacement rollback on an injected insert failure. Mock fixture rows do not print an amount, so that cell remains `null`. Type checking, lint, and formatting checks pass; mock evaluation passes (see `evaluation/last-run.md`). Provider tests stub HTTP responses; persistence tests use a single-document Drizzle test double with the real validation runner. Docker is unavailable, so live PostgreSQL rollback, queue, browser, and real-provider acceptance remain unverified and are still required in phase 8.

## 2. Sources, validation, and document transitions

Specification: 5.2, 6.5–6.7, 9; acceptance criteria 5–8.

Primary files: `packages/shared/src/validation/routing.ts`, `packages/shared/src/confidence/score.ts`, `packages/core/src/validation/validation-runner.service.ts`, `apps/api/src/documents/documents.service.ts`, `apps/api/src/export/export.service.ts`, `apps/api/src/runs/runs.service.ts`.

- [x] Block automatic approval whenever a critical field has no source, regardless of the configured threshold.
- [x] Preserve the source-free confidence cap after edits. Use the existing operator-edit marker separately from extraction confidence; an operator correction must not claim unsupported source evidence.
- [x] Validate the complete expected field set, including fields missing from storage, rather than only the rows that exist.
- [x] Check current document validity before Approve and Export using shared validation logic. Keep manual confirmation possible for low-confidence values after required and blocking checks pass.
- [x] Protect edit, approval, rejection, reprocess, type change, manual handling, and export transitions against conflicting requests and stale worker results. Use database transactions and conditional updates where sufficient.
- [x] Use the appropriate critical/noncritical thresholds consistently for review sorting, filtering, and indicators.

**Done when:** a source-free critical value never auto-approves even with a threshold below 0.6; an empty extraction cannot be approved; an edit returns current issues synchronously; concurrent actions cannot export an invalid or partially updated document. Regression checks exercise the API boundary as well as pure routing.

Verification (2026-09-06): 124 checks pass with `TEST_DATABASE_URL=postgres://… npm test`, including `scripts/validation-api.test.mjs` against PostgreSQL 18. The HTTP tests cover empty extraction, required noncritical fields, synchronous edit validation and source-confidence caps, fresh approval/export checks, concurrent export/edit/reject/reprocess/type/manual/retry requests, queue failure rollback, stale queued and in-flight worker results, and all five processors completing a pipeline. The suite creates, migrates, and drops its own randomly named database; `TEST_DATABASE_URL` must allow database creation. Run only these checks with `TEST_DATABASE_URL=postgres://… npm run test:integration`; without the variable, ordinary `npm test` explicitly skips the database suite. Migration `0007_processing_revision.sql` adds the revision and expected stage used to discard obsolete jobs. Type checking, lint, formatting, web production build, and mock evaluation pass. Queue, storage, and provider boundaries in these tests are controlled doubles; live BullMQ, real-provider and browser acceptance remain in phase 8. Export holds a document row lock during the destination call; interrupted external-write recovery and cross-document export-key binding remain in phase 3.

## 3. Export idempotency and execution history

Specification: 5.3, 6.8, 6.10, 9; acceptance criteria 10, 11.

Primary files: `apps/api/src/export/export.service.ts`, `apps/api/src/export/google-sheets.adapter.ts`, `apps/api/src/export/file-json.adapter.ts`, `packages/core/src/db/schema.ts`, `packages/core/src/db/workflow.ts`.

- [x] Bind each export key to its document and destination; reject conflicting reuse. Prevent two requests from sending the same pending export concurrently.
- [x] Persist the canonical payload and destination mapping used for an export so retries reuse the same result.
- [x] For Sheets, reserve and persist a unique target row before sending, then update that row on every retry instead of appending. Persist spreadsheet/sheet identity as part of the destination reference. Document the restriction on manually moving or deleting managed rows.
- [x] Give JSON exports collision-free object keys: different valid export keys must not collapse to the same sanitized filename.
- [x] Preserve Approved on destination failure and keep retries manual. Recover a pending export after process interruption without producing another destination object.
- [x] Record export success, failure, attempts, and correlation ID in Execution Log, not only in the export table and audit events.

**Done when:** sequential retries, concurrent requests, a lost destination response, and a failure after destination write all produce one JSON object or one Sheets row for a key. Failed exports remain visible and retryable. Integration checks cover these boundaries with a controllable destination; a configured Sheets run confirms the real adapter.

Verification (2026-09-06): 131 checks pass with `TEST_DATABASE_URL=postgres://… npm test`. The PostgreSQL/API suite exercises competing document/destination bindings, punctuation/Unicode JSON keys, identical payload and mapping replay, destination unavailability, lost responses after JSON/Sheets writes, and a terminated PostgreSQL session after the object write. Pending snapshots recover through a manual retry; each export has its own Execution Log entry. Concurrent Sheets reservations use distinct rows, and retries retain spreadsheet/sheet identity after configuration changes or a tab rename. Sheets tests run the real adapter against a controlled Google API mock; using mocks for this stage was explicitly accepted by the user. Browser checks cover custom-key Failed and Pending retries, a simulated HTTP 500, frozen edits, and completion. Type checks, lint, formatting, and the web production build pass. Migration `0008_durable_exports.sql` adds payload/mapping/target snapshots and links execution entries to exports. Operational restrictions and legacy-export reconciliation are documented in `docs/runbook.md`.

- [ ] Deferred verification: repeat the recovery checks against a configured Google Sheets spreadsheet when service-account credentials become available. This is not claimed as verified by the mock run.

## 4. Schema versions and administrator configuration

Specification: 3, 4, 6.4, 6.6–6.8, 8.

Primary files: `packages/core/src/db/seed.ts`, `packages/core/src/db/schemas.ts`, `packages/core/src/validation/validation-runner.service.ts`, `apps/api/src/schemas/schemas.controller.ts`, `packages/core/src/export/mappings.ts`.

- [ ] Make seeding idempotent without overwriting historical schema/rule versions. A changed definition creates a new version.
- [ ] Bind extraction, validation decisions, displayed field metadata, and canonical export to the versions actually used. Explicit reprocessing may adopt a newer version and must record that decision.
- [ ] Serialize concurrent schema-version changes so there is one active version per document type.
- [ ] Provide administrator-only API/configuration support for schema/rule changes and export mappings/settings within the specified scope. Reuse existing Zod validation and audit logging; do not add a settings screen.
- [ ] Validate destination configuration and honor the configured default destination consistently.

**Done when:** running seed again leaves historical definitions unchanged; a new configuration affects subsequent processing without relabeling old results; operator requests to configuration mutations receive 403; changes have an audit trail.

## 5. OCR preprocessing and file scenarios

Specification: 5.1, 6.1–6.3, 10; acceptance criteria 1, 2, 5, 9.

Primary files: `apps/worker/src/ocr/page-raster.ts`, `apps/worker/src/ocr/google-vision-ocr.provider.ts`, `apps/worker/src/preprocess/document-inspector.ts`, `apps/api/src/documents/documents.controller.ts`, `apps/api/src/documents/page-render.service.ts`.

- [ ] Implement orientation/deskew correction for image and scanned-PDF input; apply contrast correction where needed. First check whether existing dependencies suffice.
- [ ] Preserve the coordinate transformation back to the original so corrected OCR still highlights the correct source region.
- [ ] Verify blank-page exclusion without breaking original page numbering or evidence navigation.
- [ ] Cover corrupt and protected PDFs, including defects after page one, before any LLM call.
- [ ] Reconcile oversized-upload behavior with the specification: retain the resource limit while recording a rejected document and readable reason instead of only returning HTTP 413.
- [ ] Verify multi-document warnings force review and provide a documented manual split/reupload procedure; do not build automatic splitting.

**Done when:** Russian/English scans, rotated and skewed pages, blank pages, multi-document files, and invalid files have the specified outcomes. Source overlays align after preprocessing, zoom, rotation, and page navigation. Invalid files never invoke the LLM.

## 6. Evaluation and performance evidence

Specification: 6.10, 12, 13; acceptance criterion 12.

Primary files: `scripts/eval.mjs`, `scripts/generate-dataset.mjs`, `evaluation/dataset/ground-truth.json`, `apps/web/app/documents/[id]/review-workspace.tsx`, review API/contracts.

- [ ] Report the 15 labeled documents separately from the general corpus, with explicit denominators and schema/rule versions.
- [ ] Count rejected valid documents and failed/Unknown extraction in the relevant quality denominators. Count correct Missing according to ground truth, not merely non-null values.
- [ ] Define false auto-approval against expected correctness, including classification and known invalid-document cases. Add labeled negative cases while keeping the required dataset size.
- [ ] Use the same confidence, validation, and routing behavior as production. Clearly identify checks that require the database or a live stack and report them separately.
- [ ] Record review opening and approval timestamps; report median elapsed time without activity tracking.
- [ ] Measure upload-to-decision for documents up to ten pages, first-page-and-fields display time, and queue behavior with 20 documents at documented concurrency.
- [ ] Run mock evaluation first, then the labeled and general datasets with configured Google Vision and a real LLM. Store provider/model identity, date, sample sizes, failures, and measured metrics.

**Done when:** classification is at least 95%, critical exact match at least 90%, field coverage at least 98%, and false auto-approval is zero on the labeled set, or the report explicitly marks unmet targets. Source coverage and straight-through rate are published. Review and performance measurements are present; a mock-only result cannot close this stage.

## 7. Security, configuration, and delivery

Specification: 2, 3.1, 11, 16.

Primary files: `docker-compose.yml`, `example.env`, `packages/core/src/config/env.ts`, `docs/configuration.md`, `docs/runbook.md`, `README.md`, `known-limitations.md`.

- [ ] Implement and document encrypted storage of integration secrets with runtime access limited to the services that need them. Mounting a plaintext file alone does not satisfy encrypted storage.
- [ ] Keep owner/migration credentials out of API and worker configuration. Verify audit-table UPDATE, DELETE, and TRUNCATE denial under the actual application role.
- [ ] Record external-provider page/field disclosures for failed calls and repairs as well as successful calls. Keep document contents out of logs and error messages.
- [ ] Verify signed-link expiration, file authorization, temporary-object TTL, and retention defaults.
- [ ] Document and resolve the explicit authentication exceptions for health and logout against the specification.
- [ ] Resolve stack deviations: obtain an explicit accepted deviation for MuPDF and the sharp version, or implement the specified stack. A note in known limitations is not acceptance by itself.
- [ ] Correct runnable commands and environment names in documentation; ensure demo-document generation and seed steps are reproducible.
- [ ] Generate current screenshots of Review Workspace, failed-stage retry, and evaluation; record the required 60–90 second video.

**Done when:** a fresh environment starts from documented commands and example configuration, secure real-provider credential delivery is documented and exercised, and all required delivery artifacts exist. Any accepted deviations are recorded with their scope and rationale.

## 8. Final acceptance

Run against a separate test Compose project and disposable volumes; do not reset the user's existing data. Extend the existing verification script and use the existing browser tooling for review interactions.

| Criterion | Required evidence |
| --- | --- |
| 1. Upload and identity | File appears in Inbox with a unique ID, metadata, and thumbnail. |
| 2. Scanned PDF OCR | Real-provider run exposes per-page text and coordinate blocks. |
| 3. Four types | Each type uses its own schema; Unknown requires manual selection. |
| 4. Invoice fields and items | Values and at least one present line item, or ground-truth-confirmed absence, survive export. |
| 5. Confidence and source | Browser interaction highlights the correct source; missing source is explicit. |
| 6. Blocking totals | Mismatch blocks both UI and API approval/export until corrected. |
| 7. Low-confidence routing | Critical low-confidence and source-free cases require review. |
| 8. Operator correction | Before/after audit, immediate revalidation, and final JSON agree. |
| 9. Invalid file | Rejected with a readable reason and zero LLM calls. |
| 10. One export | Repeats, concurrency, and interrupted writes produce one destination object. |
| 11. Destination unavailable | Approved is preserved; a manual retry succeeds without duplication. |
| 12. Evaluation | Runnable command produces a committed report with the required metrics. |
| 13. Authentication and roles | Protected endpoints reject anonymous requests; operator cannot mutate admin configuration. |

- [ ] Run targeted regression tests, type checks, lint/format checks, and the web build.
- [ ] Run live queue/retry, export, audit, and authentication integration checks.
- [ ] Run browser E2E: upload → OCR → extraction → review edit → approve → export.
- [ ] Verify stage-two source add/change/delete, duplicate linkage, version retention, DLQ, and manual retry.
- [ ] Attach real-provider evaluation and performance results; update this plan and known limitations to reflect actual evidence.

**Release condition:** all 13 acceptance criteria have passing evidence, required delivery items are present, and remaining specification deviations are explicitly accepted. Do not mark completion from unit tests or mock evaluation alone.
