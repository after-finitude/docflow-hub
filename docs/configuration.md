# Configuration

Copy `example.env` to `.env`. Startup validates all required values and fails early on invalid combinations.

## Core services

- `POSTGRES_*`: owner and application database credentials and host settings.
- `REDIS_HOST`, `REDIS_PORT`: BullMQ and event channel.
- `MINIO_*`: internal object-storage connection, browser-visible URL, bucket, and credentials.
- `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECURE`: session security.
- `SEED_ADMIN_*`, `SEED_OPERATOR_*`: demo users.

The application role name is fixed as `docflow_app`; its password is created only when the PostgreSQL volume is initialized. Changing it on an existing volume requires `ALTER ROLE`.

## Processing providers

- `OCR_PROVIDER=mock|google`. Google requires `GOOGLE_VISION_KEY_FILE`.
- `LLM_PROVIDER=mock|openai_compatible`. A real provider requires `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`.
- `EXPORT_DESTINATIONS=file_json,google_sheets`. Sheets requires its key file and spreadsheet ID.
- `SOURCE_PROVIDER=none|local_folder|google_drive`. Local folder requires `LOCAL_SOURCE_DIR`; Drive requires its key file and folder ID.

## Operations

- `WORKER_CONCURRENCY` and stage-specific overrides control BullMQ processing.
- `SOURCE_SYNC_INTERVAL_SECONDS` controls source synchronization.
- `RETENTION_DAYS` controls permanent deletion after deactivation.
- `ORPHAN_OBJECT_TTL_HOURS` controls cleanup of unreferenced storage objects.
- `SIGNED_URL_TTL_SECONDS` controls original-file link lifetime.

Never commit `.env` or provider credentials. Docker Compose passes only the variables each service needs; the web container does not receive database, storage, or JWT secrets.
