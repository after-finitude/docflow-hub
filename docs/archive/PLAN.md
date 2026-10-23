# Technical Specification v2 Completion Plan

Status: implementation for phases 1–5 and 7 is complete; phase 6 still needs real-provider measurements and a human review sample, and phase 8 final acceptance remains open. Google Drive and Google Sheets are temporarily disabled at the user's request on 2026-09-07; their live acceptance is deferred until re-enablement. Full specification compliance has not been established.

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

- [ ] Deferred verification: Google Drive and Google Sheets are temporarily disabled at the user's request on 2026-09-07. Repeat recovery checks against configured Google Sheets after explicit re-enablement; the mock run does not verify live integration.

## 4. Schema versions and administrator configuration

Specification: 3, 4, 6.4, 6.6–6.8, 8.

Primary files: `packages/core/src/db/seed.ts`, `packages/core/src/db/schemas.ts`, `packages/core/src/validation/validation-runner.service.ts`, `apps/api/src/schemas/schemas.controller.ts`, `packages/core/src/export/mappings.ts`.

- [x] Make seeding idempotent without overwriting historical schema/rule versions. A changed definition creates a new version.
- [x] Bind extraction, validation decisions, displayed field metadata, and canonical export to the versions actually used. Explicit reprocessing may adopt a newer version and must record that decision.
- [x] Serialize concurrent schema-version changes so there is one active version per document type.
- [x] Provide administrator-only API/configuration support for schema/rule changes and export mappings/settings within the specified scope. Reuse existing Zod validation and audit logging; do not add a settings screen.
- [x] Validate destination configuration and honor the configured default destination consistently.

**Done when:** running seed again leaves historical definitions unchanged; a new configuration affects subsequent processing without relabeling old results; operator requests to configuration mutations receive 403; changes have an audit trail.

Verification (2026-09-06): 141 checks pass with `TEST_DATABASE_URL=postgres://… npm test`. The real PostgreSQL/API suite verifies operator 403 responses, invalid configuration rejection, immutable historical labels/rules/thresholds/mappings, schema changes during an in-flight LLM call, pinned retries, failed replacement recovery, concurrent version creation, audit-transaction rollback, environment and persisted export defaults, and unchanged/changed/concurrent seed runs. A separate migration check upgrades pre-0009 records, preserving historical definitions and recovering bindings from fields or decision audit records. Enum choices are enforced during validation. Sheets column-layout checks cover existing headers and reservations whose header write has not completed, using the agreed Google API mock. Type checks, lint, formatting and the web production build pass. Migration `0009_versioned_configuration.sql` adds document bindings, versioned mappings, the seed fingerprint and export settings; a partial unique index enforces one active schema per type. API usage, reprocessing/version behavior and tab-layout restrictions are documented in `docs/configuration.md` and `docs/runbook.md`.

## 5. OCR preprocessing and file scenarios

Specification: 5.1, 6.1–6.3, 10; acceptance criteria 1, 2, 5, 9.

Primary files: `apps/worker/src/ocr/page-raster.ts`, `apps/worker/src/ocr/google-vision-ocr.provider.ts`, `apps/worker/src/preprocess/document-inspector.ts`, `apps/api/src/documents/documents.controller.ts`, `apps/api/src/documents/page-render.service.ts`.

- [x] Implement orientation/deskew correction for image and scanned-PDF input; apply contrast correction where needed. First check whether existing dependencies suffice.
- [x] Preserve the coordinate transformation back to the original so corrected OCR still highlights the correct source region.
- [x] Verify blank-page exclusion without breaking original page numbering or evidence navigation.
- [x] Cover corrupt and protected PDFs, including defects after page one, before any LLM call.
- [x] Reconcile oversized-upload behavior with the specification: retain the resource limit while recording a rejected document and readable reason instead of only returning HTTP 413.
- [x] Verify multi-document warnings force review and provide a documented manual split/reupload procedure; do not build automatic splitting.

**Done when:** Russian/English scans, rotated and skewed pages, blank pages, multi-document files, and invalid files have the specified outcomes. Source overlays align after preprocessing, zoom, rotation, and page navigation. Invalid files never invoke the LLM.

Verification (2026-09-06): 160 checks pass with the isolated PostgreSQL database and `npm test`, including real Nest HTTP upload limits, metadata-only rejections, safe retention, corrupt later pages and protected PDFs never reaching providers, and multi-document routing. Controlled Vision responses exercise real Sharp/MuPDF raster operations for Russian/English fixtures, quarter-turns, skewed images and scanned PDFs, all eight JPEG/PNG EXIF orientations, sparse/faint text, blank middle pages and CropBox/page rotation. Browser verification covers source navigation through a blank page, portrait/landscape images, rotations and zoom through 300%, including images loaded before hydration; the image and scroll frame agree within 0.01 CSS pixels in the checked 270°/300% case. Refusal pages show the absent original and disable reprocessing. No new image library was added; the API declares the already-installed Sharp dependency. Migration `0010_rejected_upload_metadata.sql` permits missing file metadata only for rejected, idle records. The split/reupload and refusal procedures are documented in `docs/runbook.md`.

- [ ] Run configured Google Vision against real Russian/English rotated and skewed scans. Controlled responses prove transformation and routing behavior, not live recognition quality; carry this check into stage 6 provider evaluation.

## 6. Evaluation and performance evidence

Specification: 6.10, 12, 13; acceptance criterion 12.

Primary files: `scripts/eval.mjs`, `scripts/generate-dataset.mjs`, `evaluation/dataset/ground-truth.json`, `apps/web/app/documents/[id]/review-workspace.tsx`, review API/contracts.

- [x] Report the 15 labeled documents separately from the general corpus, with explicit denominators and schema/rule versions.
- [x] Count rejected valid documents and failed/Unknown extraction in the relevant quality denominators. Count correct Missing according to ground truth, not merely non-null values.
- [x] Define false auto-approval against expected correctness, including classification and known invalid-document cases. Add labeled negative cases while keeping the required dataset size.
- [x] Use the same confidence, validation, and routing behavior as production. Clearly identify checks that require the database or a live stack and report them separately.
- [x] Record review opening and approval timestamps; expose the median elapsed time without activity tracking, excluding and reporting approvals without a matching opening.
- [x] Measure upload-to-decision for one- and ten-page text fixtures, first-page-and-fields display time, and queue behavior with 20 documents at documented concurrency on the mock stack.
- [x] Run the labeled and general datasets with mock providers and store provider/model identity, date, sample sizes, failures, and measured metrics.
- [ ] Deferred by the user on 2026-09-07: repeat quality and performance with configured Google Vision and a real LLM, including dense/scanned ten-page files and real Russian/English rotation/deskew quality.
- [ ] Collect a human review-time sample; an unattended browser check or artificial delay does not measure operator speed.

**Done when:** classification is at least 95%, critical exact match at least 90%, field coverage at least 98%, and false auto-approval is zero on the labeled set, or the report explicitly marks unmet targets. Source coverage and straight-through rate are published. Review and performance measurements are present; a mock-only result cannot close this stage.

Verification (2026-09-07): `evaluation/last-run.md` and JSON record 46 synthetic uploads through authenticated Nest HTTP, production BullMQ workers, PostgreSQL 18, Redis 7 and MinIO on an isolated stack. The 15 labeled cases cover all four types plus corrupt, multi-document, required-Missing and invalid-sum cases. Classification is 14/14, critical exact match 72/72, field coverage 117/117 and false auto-approval 0/8; source coverage is 116/116 and straight-through rate 8/15. The full corpus has 97.6% field coverage below the 98% target, explicitly reported with exit code 1; the poor image scan is Unknown under mock OCR. Numeric taxpayer IDs returned by the mock violate the string schema and route tax letters to review. Ground truth is taken from generator inputs, not predictions.

`evaluation/performance.md` and JSON record three one-page uploads (median 141 ms), three ten-page uploads with nonblank text attachments (136 ms), 20 simultaneous uploads completed in 817 ms, and six fresh Chrome navigations with first-page/fields median 146.5 ms. Native API/worker and a production Next build used a local Colima data-services VM with 2 CPUs/4 GiB; worker concurrency was default 4, OCR 2, extraction 2. Sampled queue peaks respected these limits and all queues drained without failures. These are small localhost/mock samples, not production or external-provider latency measurements.

All 164 checks pass with the isolated PostgreSQL role and `npm test`, including ground-truth denominators, correct Missing, false approvals, concurrent/idempotent opening records, actor/revision pairing, missing-opening counts, median calculation and administrator-only metrics. Browser checks verify the real review-opening endpoint and loaded first page/fields. Type checks, lint, formatting and the web production build pass. Timing reuses immutable audit events; no new table, dependency or activity tracking was added. No human reviews were performed. Stage 6 remains open for the deferred real-provider run and human sample.

## 7. Security, configuration, and delivery

Specification: 2, 3.1, 11, 16.

Primary files: `docker-compose.yml`, `example.env`, `packages/core/src/config/env.ts`, `docs/configuration.md`, `docs/runbook.md`, `README.md`, `docs/known-limitations.md`.

- [x] Implement and document encrypted storage of integration secrets with runtime access limited to the services that need them. Mounting a plaintext file alone does not satisfy encrypted storage.
- [x] Keep owner/migration credentials out of API and worker configuration. Verify audit-table UPDATE, DELETE, and TRUNCATE denial under the actual application role.
- [x] Record external-provider page/field disclosures for failed calls and repairs as well as successful calls. Keep document contents out of logs and error messages.
- [x] Verify signed-link expiration, file authorization, temporary-object TTL, and retention defaults.
- [x] Document and resolve the explicit authentication exceptions for health and logout against the specification.
- [x] Resolve stack deviations: obtain an explicit accepted deviation for MuPDF and the sharp version, or implement the specified stack. A note in known limitations is not acceptance by itself.
- [x] Correct runnable commands and environment names in documentation; ensure demo-document generation and seed steps are reproducible.
- [x] Generate current screenshots of Review Workspace, failed-stage retry, and evaluation; record the required 60–90 second video.

**Done when:** a fresh environment starts from documented commands and example configuration, secure real-provider credential delivery is documented and exercised, and all required delivery artifacts exist. Any accepted deviations are recorded with their scope and rationale.

Verification (2026-09-07): 170 tests pass without skips against an isolated PostgreSQL instance. Actual `docflow_app` password authentication (including an apostrophe in the password) permits audit INSERT/SELECT and denies UPDATE, DELETE, TRUNCATE and schema creation. Per-call intent/outcome records persist on failure and repair. Synthetic AES-GCM credentials exercise the CLI, tamper/wrong-key/plaintext rejection, real Google SDK constructors and separate read-only API/worker mounts under container UID 1000. Runtime container environments exclude owner/seed credentials; worker also excludes JWT and Sheets secrets. A fresh `docflow-phase7-check` Compose project builds, migrates, seeds, starts healthy and processes an uploaded PDF through approval using PDF.js/qpdf; no existing project data was reset.

Live checks in `evaluation/security.json` cover authenticated/anonymous/invalid-cookie file access, cross-document export download rejection, private bucket access, the default 900-second signature, real 5-second signature expiration, operator configuration denial and the exact 24-hour orphan boundary. PostgreSQL tests cover the exact 90-day retention boundary and active-document preservation. `document.provider_call` records every Vision page/correction and LLM request/repair before sending and after success/failure; errors omit provider-controlled content. Native temporary-file failures retry and Docker uses a bounded tmpfs.

Accepted decisions on 2026-09-07: retain public status-only health and optional-auth logout so invalid cookies can be cleared; replace MuPDF with PDF.js and retain Sharp. Sharp is updated to 0.35.4, Next to 16.3.4 and compatible transitive security fixes are applied. No high/critical npm audit findings remain; eight affected packages from three moderate transitive advisories are explicitly documented in `docs/known-limitations.md` and `evaluation/dependencies.json`. No forced major downgrades were applied.

`npm run dataset` reproduces all 46 generated files byte-for-byte on repeated execution. Evaluation and performance reports were rerun after the PDF engine change. Current screenshots and `docs/demo.webm` show a blocking total, operator correction, approval, JSON export and a real failed queue stage followed by successful manual retry; `evaluation/delivery.json` records the checks. The video is a paced demonstration, not a human review-time sample. Lint, formatting, backend tests and web production builds pass. Runnable setup, verification, encryption, rotation and artifact commands are documented. Real Google/LLM connectivity and quality remain deferred by the user's earlier decision and are still open in stages 3, 5, 6 and 8; synthetic delivery does not claim that verification.

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

## September 15 follow-up: blank pages and statement dataset

Classification now skips empty/whitespace OCR text before selecting two pages, retaining original numbering and OCR-quality warnings. Regression cases cover leading and middle blanks, the two-page limit, all-empty input, original source pages and multi-document review routing.

The v3 generator defines 47 documents with 15 labeled cases, updates all nine bank statements with transactions and adds an invoice after two blank pages. Bank cases cover a wrapped description across pages, a missing amount, explicit no activity and Russian text. The deterministic mock supports the synthetic table; a PDF → OCR → extraction → validation regression compares results with generator input values. Evaluation refuses the obsolete v2 dataset.

Backend build and dataset generation completed after the user authorized deployment and browser verification on the public demo. The generator produced 47 documents, 15 labeled. Regression tests and evaluation have not been run; the September 7 reports remain historical evidence for v2. Deployment and browser outcomes will be recorded separately.
