# Runbook

## Start and stop

```bash
docker compose up -d --build --wait
docker compose ps
docker compose down
```

Use `docker compose logs -f api worker web` for live logs. Run `npm run verify` after the stack is healthy.

## Common failures

- Docker daemon unavailable: on macOS with Colima, run `colima start`.
- API unavailable: inspect `api`, PostgreSQL, Redis, and migration-container logs.
- Login returns 200 but no session: `COOKIE_SECURE=true` requires HTTPS.
- Storage link fails: `MINIO_PUBLIC_URL` must be reachable from the browser and match the signed Host.
- OCR/LLM configuration failure: confirm the selected provider's required key and endpoint variables.
- Document remains processing: inspect the Execution Log and worker logs; exhausted transient errors appear in the dead-letter queue.
- Source file not ingested: verify source configuration, mount permissions, size/type limits, and worker logs.

## Recovery actions

- Retry eligible failed stages from Execution Log after correcting the external cause.
- Reprocess a document to restart its automatic pipeline with the active schema. Failed extraction retries retain their pinned version; revalidation and edits retain the version of existing results. See `docs/configuration.md` for schema and export-setting endpoints.
- Replace a UI-uploaded original to create a new version; source-backed files must be changed at the source.
- Retry failed or interrupted Pending exports from their **Retry export** button on the document page. Each button sends that record's original export key. Exports never retry automatically.
- The first attempt saves the approved canonical JSON and mapping, then commits the destination address before writing. Later attempts reuse that snapshot, including its timestamps and target, even if configuration changes. A failed delivery keeps the document Approved; edits, rejection, type changes, and reprocessing stay disabled until delivery finishes.
- Execution Log has one export entry per export record, with attempts, the latest correlation ID, completion time, and any failure code. A process interruption can leave it Running and the export Pending; the next manual retry resumes the saved export.
- JSON exports use the export record UUID for their object key. Successful exports from older releases keep their existing download paths. Historical failed exports without a saved snapshot cannot be retried safely: reconcile the old destination write first, then explicitly use a new export key if another write is needed.

### Google Sheets row ownership

Use a dedicated tab whose data rows are managed by Docflow. All exports in that tab must use the same ordered column headers. For `sheets_mapping_mismatch`, configure a compatible tab before retrying the saved export; changing schema configuration does not rewrite its saved mapping. Do not manually insert, delete, move, or sort its managed rows, or edit their cells; use a separate tab for reports and sorting. A renamed tab is supported because Docflow persists its numeric sheet ID. Replacing/deleting the tab or copying the database without the corresponding destination invalidates these addresses.

Each new export reserves a unique row in PostgreSQL, accounting for rows already present in the tab and reservations not yet sent. Retries use the saved spreadsheet ID, sheet ID, row, and mapping. Writes use a numeric GridRange through [Sheets batchUpdateByDataFilter](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdateByDataFilter), so a lost response overwrites the same row on retry. Changing configuration redirects only newly reserved exports; credentials must still have access to targets awaiting a retry.

The regression suite exercises the real adapter with a mocked Google API, including a lost response after a successful row write. A configured Google Sheets run remains a separate check; mocks were explicitly accepted for this implementation stage.

## Maintenance

Source synchronization and retention are serialized maintenance jobs stored in Redis. Restarting workers updates schedules and triggers an immediate pass. Retention permanently deletes inactive documents after `RETENTION_DAYS`; audit events remain immutable.

Before destructive database or volume operations, take a backup and confirm the exact target. Do not remove persistent volumes merely to restart services.

## OCR and file refusal

Google Vision receives an EXIF-oriented copy of each nonblank image/PDF page. Low-contrast pages are normalized. At least three confident words with a consistent reading direction can trigger one rotation/deskew correction and one additional OCR request; each page therefore makes at most two provider calls per attempt. The original file stays unchanged. Returned polygons are mapped back to its displayed coordinates before evidence matching. `document.ocr_external` records successful pages, correction angles and call counts. Ambiguous directions are left unchanged; inspect the original when the text remains difficult to read.

PDF pages are rasterized one at a time, with a 25-megapixel raster budget per page. Blank pages retain their original numbers and are not sent to Vision. A confirmed blank page does not create a low-OCR-quality warning; an unrecognized nonblank page still does. The viewer applies EXIF orientation consistently for JPEG and PNG, and rotates the image and its source overlays together.

Inspection opens and renders every PDF page before OCR, including pages after the first. Password protection, unreadable data, repaired PDF structure and page-render errors reject the document before external OCR/LLM calls. Upload an unprotected, valid replacement; retrying the same damaged file cannot repair it.

Files larger than 25 MiB create a **Rejected** queue entry and a failed **Ingest** entry with `file_too_large`. Browser uploads send only metadata to `POST /api/documents/oversized`; the reported size is identified as client metadata in the audit. Direct multipart uploads still receive HTTP 413, now with `documentId`; their exact size remains unknown because only the limit was observed. No original, checksum, thumbnail or processing job is created. Reprocess and original download are unavailable for these records. A refused replacement does not supersede the existing document. Return to the queue and upload a smaller file. Files exactly at the limit are accepted for inspection.

### Multiple documents in one file

1. Open every page and identify which pages belong to each document. A `multi_document_suspected` warning always routes to **Needs review**, even when extracted fields are otherwise valid and confident.
2. Use the original upload, or download it through the short-lived link returned by `GET /api/documents/:id/file`. In your existing PDF editor or system print dialog, save each document's page range as a separate PDF. Check that all required pages and their order are preserved.
3. Reject the combined upload with a note that it was split, then upload the separate files from the queue. Review their classification, values and source highlights independently. Docflow does not split files automatically.

`npm test` includes controlled Google Vision responses over real raster operations, rotated/skewed image and scanned-PDF fixtures, all eight JPEG/PNG EXIF orientations, blank pages, malformed later PDF pages, protected files and upload refusal. These checks validate processing and coordinate behavior; they do not establish Google Vision recognition accuracy on real Russian/English scans. That check requires configured Vision credentials and belongs with the real-provider evaluation.

## Quality and performance evaluation

Use a disposable stack with its own database, Redis and object storage, migrated and seeded normally. Disable source ingestion (`SOURCE_PROVIDER=none`). Never point these commands at production: they upload synthetic documents. Quality evaluation refuses a nonempty document database because duplicate and uniqueness rules depend on previous documents. Use a separate Compose project and unused port overrides if another stack is running; do not remove existing volumes to make it empty.

API and worker must share OCR/LLM, model and queue-concurrency configuration. Start both after building the backend. Select `OCR_PROVIDER=mock` and `LLM_PROVIDER=mock` for the initial run; rerun on a fresh isolated stack with real providers when credentials are available. `npm run eval` does not start or reconfigure services. The administrator metrics response records API configuration; verify the worker's startup log agrees. Authentication cookies stay in process memory and are not written into reports.

```bash
npm run dataset
export EVAL_BASE_URL=http://127.0.0.1:3001
export EVAL_LOGIN=admin
# Set EVAL_PASSWORD to the disposable stack's seed administrator password.
npm run eval
```

Set the URL to the API's actual address, without a trailing slash, or the web proxy URL ending in `/api`. The harness uploads all 46 files and waits for production workers, writing `evaluation/last-run.json` and `evaluation/last-run.md`. It reports the 15 labeled cases separately, with expected values, schema/rule versions, thresholds, manifest hash, date, provider/model identity and each outcome. Ground truth comes from generator inputs and includes explicit Missing and invalid cases. Rejected valid files, failures and Unknown remain in applicable denominators. A missed target produces exit code 1 **after saving the report**; the current mock corpus run intentionally reports 97.6% coverage below 98%. `EVAL_TIMEOUT_MS` defaults to 180000 per document and counts unfinished work as a failure without cancelling it.

For latency and load, keep that stack running and start a production web build with its `API_INTERNAL_URL` pointing at the same API (this value is needed during both build and runtime). Use the installed system Chrome; optionally set `EVAL_CHROME_PATH` to another Chromium executable. No browser download is required.

```bash
export EVAL_WEB_URL=http://127.0.0.1:3000
export EVAL_REDIS_URL=redis://127.0.0.1:6379
export EVAL_ENVIRONMENT='Describe process/container mode, VM resources and worker count'
npm run eval:performance
```

Use the actual reachable Redis address of this disposable stack. The benchmark uploads three one-page and three ten-page files, then 20 files simultaneously. It records direct BullMQ active/waiting/delayed/failed counts, per-document decisions and timings, and six fresh browser navigations to the real Review Workspace. The page's `docflow-review-ready` performance mark follows hydration and first-page image loading. Browser checks require visible source controls and a loaded image, and verify the review-opening request succeeds. Results go to `evaluation/performance.json` and `evaluation/performance.md`. Existing documents are counted and normal duplicate checks remain active. The ten-page fixture uses nonblank text attachments; it is not a scanned-document benchmark.

Opening a Needs review page sends `POST /documents/:id/review-opened` and appends `document.review_opened` once per user and processing revision. Approval appends server-side opening/approval timestamps and elapsed milliseconds to `document.approved`. No mouse, keyboard, focus or activity tracking is collected. `GET /documents/review-metrics?since=<ISO timestamp>` is administrator-only and returns manual-approval count, measured count, median milliseconds and missing-opening count. Reprocessing or changing type starts a new revision; another user's opening cannot be paired with approval. Time away is included; missing openings are excluded from the median and reported separately. The unattended benchmark does not supply a human review-time sample.

`npm test` checks metric denominators and false approvals without a live stack. Set `TEST_DATABASE_URL` to a PostgreSQL role that can create databases for the review timing/permissions regression; it creates, migrates and drops its own random test database. Real-provider quality and a timed human review sample remain separate, unverified checks.
