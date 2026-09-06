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
- Reprocess a document to restart its automatic pipeline.
- Replace a UI-uploaded original to create a new version; source-backed files must be changed at the source.
- Retry failed or interrupted Pending exports from their **Retry export** button on the document page. Each button sends that record's original export key. Exports never retry automatically.
- The first attempt saves the approved canonical JSON and mapping, then commits the destination address before writing. Later attempts reuse that snapshot, including its timestamps and target, even if configuration changes. A failed delivery keeps the document Approved; edits, rejection, type changes, and reprocessing stay disabled until delivery finishes.
- Execution Log has one export entry per export record, with attempts, the latest correlation ID, completion time, and any failure code. A process interruption can leave it Running and the export Pending; the next manual retry resumes the saved export.
- JSON exports use the export record UUID for their object key. Successful exports from older releases keep their existing download paths. Historical failed exports without a saved snapshot cannot be retried safely: reconcile the old destination write first, then explicitly use a new export key if another write is needed.

### Google Sheets row ownership

Use a dedicated tab whose data rows are managed by Docflow. Do not manually insert, delete, move, or sort its managed rows, or edit their cells; use a separate tab for reports and sorting. A renamed tab is supported because Docflow persists its numeric sheet ID. Replacing/deleting the tab or copying the database without the corresponding destination invalidates these addresses.

Each new export reserves a unique row in PostgreSQL, accounting for rows already present in the tab and reservations not yet sent. Retries use the saved spreadsheet ID, sheet ID, row, and mapping. Writes use a numeric GridRange through [Sheets batchUpdateByDataFilter](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdateByDataFilter), so a lost response overwrites the same row on retry. Changing configuration redirects only newly reserved exports; credentials must still have access to targets awaiting a retry.

The regression suite exercises the real adapter with a mocked Google API, including a lost response after a successful row write. A configured Google Sheets run remains a separate check; mocks were explicitly accepted for this implementation stage.

## Maintenance

Source synchronization and retention are serialized maintenance jobs stored in Redis. Restarting workers updates schedules and triggers an immediate pass. Retention permanently deletes inactive documents after `RETENTION_DAYS`; audit events remain immutable.

Before destructive database or volume operations, take a backup and confirm the exact target. Do not remove persistent volumes merely to restart services.
