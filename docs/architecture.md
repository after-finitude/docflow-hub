# Architecture

Docflow Hub is an npm-workspaces monorepo with three applications and two shared packages.

## Services

- `apps/web`: Next.js operator console. Browser API calls use same-origin rewrites so session cookies remain httpOnly and need no CORS policy.
- `apps/api`: NestJS HTTP API for authentication, documents, review actions, schemas, exports, events, and execution history.
- `apps/worker`: NestJS standalone BullMQ processors and maintenance jobs.
- `packages/core`: database, storage, queues, ingest, validation orchestration, and export mappings.
- `packages/shared`: domain contracts and pure normalization, matching, confidence, validation, routing, and canonical-export logic.

PostgreSQL stores domain state and immutable audit events. Redis carries BullMQ jobs and queue-update pub/sub. MinIO stores originals, thumbnails, rendered pages, and JSON exports.

## Processing flow

```text
upload or source sync
  -> ingest
  -> preprocess
  -> OCR
  -> classify
  -> extract + evidence-to-bbox matching
  -> validate + route
  -> operator review when needed
  -> idempotent export
```

Each stage writes a `workflow_runs` record with correlation ID, attempts, duration, and error summary. Exhausted transient failures also write a dead-letter entry with payload, full error, and stack.

## Security and data integrity

- A global JWT guard protects API endpoints except explicit public/optional-auth routes.
- Role checks separate administrator and operator actions.
- Login is rate-limited by username and uses constant-time password verification for unknown accounts.
- The application database role cannot update or delete `audit_events`.
- Files are validated before OCR/LLM calls and served through guarded endpoints or short-lived signed URLs.
- Ingest is idempotent by source path and content; checksum duplicates link to the original.
- Schema and rule versions are stored with decisions for reproducibility.

## Providers

OCR supports deterministic mock and Google Cloud Vision providers. LLM work supports deterministic mock and OpenAI-compatible providers. Export supports canonical JSON and Google Sheets. The secondary source can be disabled, a watched folder, or Google Drive.
