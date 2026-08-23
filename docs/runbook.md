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
- Retry failed exports from the document page. Exports never retry automatically.

## Maintenance

Source synchronization and retention are serialized maintenance jobs stored in Redis. Restarting workers updates schedules and triggers an immediate pass. Retention permanently deletes inactive documents after `RETENTION_DAYS`; audit events remain immutable.

Before destructive database or volume operations, take a backup and confirm the exact target. Do not remove persistent volumes merely to restart services.
