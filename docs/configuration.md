# Configuration

Copy `example.env` to `.env`. Startup validates all required values and fails early on invalid combinations.

## Core services

- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `APP_DB_PASSWORD`: runtime connection as `docflow_app`.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`: PostgreSQL initialization and migration/seed process only; excluded from API and worker.
- `REDIS_HOST`, `REDIS_PORT`: BullMQ and event channel.
- `MINIO_*`: internal object-storage connection, browser-visible URL, bucket, and credentials.
- `JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECURE`: session security.
- `SEED_ADMIN_*`, `SEED_OPERATOR_*`: migration/seed process only.

The application role name is fixed as `docflow_app`; its password is created only when the PostgreSQL volume is initialized. Changing it on an existing volume requires `ALTER ROLE`.

## Processing providers

- `OCR_PROVIDER=mock|google`. Google requires `GOOGLE_VISION_KEY_FILE`.
- `LLM_PROVIDER=mock|openai_compatible`. A real provider requires `LLM_BASE_URL`, `LLM_API_KEY_FILE`, and `LLM_MODEL`.
- `EXPORT_DEFAULT_DESTINATION=file_json|google_sheets` selects the initial export default. JSON is always available. Sheets is enabled when both `GOOGLE_SHEETS_KEY_FILE` and `GOOGLE_SHEETS_SPREADSHEET_ID` are set; partial configuration is rejected. `GOOGLE_SHEETS_SHEET_NAME` defaults to `Documents`. All integration key files are encrypted envelopes, mounted read-only inside the service that uses them.
- `SOURCE_PROVIDER=none|local_folder|google_drive`. Local folder requires `LOCAL_SOURCE_DIR`; Drive requires its key file and folder ID.

## Operations

- `QUEUE_CONCURRENCY_DEFAULT`, `QUEUE_CONCURRENCY_OCR`, and `QUEUE_CONCURRENCY_EXTRACT` control BullMQ processing.
- `SOURCE_SYNC_INTERVAL_SECONDS` controls source synchronization.
- `RETENTION_DAYS=90` controls permanent deletion after deactivation; active documents remain.
- `ORPHAN_TTL_HOURS=24` controls cleanup of unreferenced document storage objects.
- `SIGNED_URL_TTL_SECONDS=900` controls original-file link lifetime, validated from 1 to 604800 seconds. A URL already issued is a bearer capability until it expires, including after logout.

Never commit `.env` or provider credentials. Docker Compose passes only the variables each service needs; the web container does not receive database, storage, or JWT secrets.


## Encrypted integration credentials

Provider credentials are AES-256-GCM envelopes (version 1, random IV, authenticated tag). Plaintext `LLM_API_KEY` and plaintext key files are rejected. The 32-byte decryption key is supplied separately through `INTEGRATION_KEY_FILE`; plaintext is decrypted only in process memory and passed to the SDK. A bad envelope, wrong key or missing file fails closed. This protects stored envelopes; an attacker controlling the running service can still access its credentials.

Create distinct API and worker keys outside the repository. Example paths below must be provisioned by the operator; keep the key directories separate from encrypted-envelope backups:

```bash
npm run build
install -d -m 700 /secure/docflow/api-key /secure/docflow/worker-key
mkdir -p secrets/api secrets/worker
node scripts/integration-secret.mjs keygen /secure/docflow/api-key/integration.key
node scripts/integration-secret.mjs keygen /secure/docflow/worker-key/integration.key
node scripts/integration-secret.mjs encrypt /secure/docflow/api-key/integration.key secrets/api/sheets.enc < /secure/provisioning/sheets.json
node scripts/integration-secret.mjs encrypt /secure/docflow/worker-key/integration.key secrets/worker/vision.enc < /secure/provisioning/vision.json
node scripts/integration-secret.mjs encrypt /secure/docflow/worker-key/integration.key secrets/worker/drive.enc < /secure/provisioning/drive.json
node scripts/integration-secret.mjs encrypt /secure/docflow/worker-key/integration.key secrets/worker/llm.enc < /secure/provisioning/llm-token
```

Create only files for enabled integrations. The helper reads secrets from stdin, writes mode 0600, and refuses to overwrite an existing file. Securely remove provisioning plaintext after delivery according to the host's storage policy. Set `API_INTEGRATION_KEY_DIR=/secure/docflow/api-key` and `WORKER_INTEGRATION_KEY_DIR=/secure/docflow/worker-key` in `.env`; set provider paths to `/run/integrations/sheets.enc`, `vision.enc`, `drive.enc`, or `llm.enc`. Compose mounts the corresponding key directory as `/run/keys:ro` and sets `INTEGRATION_KEY_FILE=/run/keys/integration.key`. Default key directories under `secrets/runtime-*` are convenient for disposable local tests only; production keys belong outside the repository and envelope backup set.

The API receives only Sheets credentials; the worker receives only Vision, LLM and Drive credentials and has no JWT signing key. The web receives only the internal API URL. Owner and seed credentials exist only in PostgreSQL initialization and the one-shot migrate service. Read-only bind mounts still require host ownership/permissions allowing container UID 1000 to read the files and traverse the directories; grant that dedicated service identity access without making keys world-readable. `secrets/` is excluded from Git and Docker build context. Worker `/tmp` is a 256 MiB tmpfs for qpdf checks; normal processing removes temporary originals immediately and container removal clears crash leftovers.

Rotation: stop the affected service, create a new key and encrypted files at new paths, verify decryption with the intended service identity, replace both mount sources as one maintenance operation, and recreate that service. Revoke the old provider credential after the new one is verified. Keep a separately controlled recovery copy of the key; an envelope backup alone is unrecoverable. Never store the key together with its encrypted-envelope backup. Do not log or pass plaintext credentials as command arguments.

## Authentication and disclosure journal

Accepted by the user on 2026-09-07: `GET /health` remains public and returns only `{status:"ok"}`; `POST /auth/logout` accepts a missing/invalid session to clear its cookie. Login is public and throttled. All document/file/export endpoints require a valid session; operators cannot mutate administrator settings. The application has one shared tenant, so authenticated operators can access the same document pool.

`document.provider_call` records every Vision page request and every LLM request/repair with provider, run/correlation/call IDs, purpose, original page numbers, field names, attempt and optional correction rotation. An `attempted` event commits before sending; `succeeded` or `failed` follows the request. An attempt without a final event means the outcome is unknown and disclosure may have occurred. A failed call may still have disclosed its input. For LLM repairs the same source pages/fields are resent with the previous response. No image, page text, field value, prompt, provider response body or integration secret is stored in these events or provider error messages. Existing successful OCR/LLM summary events remain for compatibility; the per-call journal is authoritative for attempted disclosures. Export snapshots and export execution/audit events separately record intended destination delivery. The application role can insert/read audit events but cannot UPDATE, DELETE, TRUNCATE, or create schema objects.

## Versioned administrator API

These paths are relative to the API; add `/api` when using the web origin. Authentication uses the existing session cookie. Operators can read schemas, but every configuration mutation requires the `admin` role and records before/after values in the audit log in the same transaction.

| Endpoint | Purpose |
| --- | --- |
| `GET /schemas` | Active versions, including fields, rules, thresholds and export mappings. |
| `GET /schemas/:type/versions` | Historical versions, newest first. |
| `PUT /schemas/:type` | Create a version from `{fields, rules, thresholds, exportMapping}`. |
| `PUT /schemas/:type/thresholds` | Create a version changing only the three thresholds. |
| `GET /settings/export` | Administrator view of the default and available destinations. |
| `PUT /settings/export` | Save `{defaultDestination: "file_json"}` or `"google_sheets"`; the destination must be configured. |

For a schema edit, copy the four configuration properties from `GET /schemas`, edit them, and send them to `PUT /schemas/:type`; omit response metadata such as `id`, `version` and `isActive`. Allowed types are `invoice`, `bank_statement`, `tax_letter` and `contract`. Definitions support 1–15 uniquely named fields and at most one flat line-item array. Enum fields require `enumValues`. Rule references and operand types, regex syntax, ranges, rule IDs and mapping sources are validated before creating a version. Concurrent updates serialize per type, and PostgreSQL enforces one active version.

An export mapping is an ordered array of `{column, source}` entries. Sources are `field:<scalar-field-name>` or `meta:documentId`, `meta:documentType`, `meta:originalFilename`, `meta:checksum`, `meta:receivedAt`, `meta:approvedAt`, `meta:lineItemCount`. JSON exports retain the complete canonical document. Sheets uses the column order; a managed tab must have the same column layout for all exports sent there. A changed layout requires a separate tab and an updated `GOOGLE_SHEETS_SHEET_NAME`; mismatched headers or pending reservations fail with `sheets_mapping_mismatch` before any write.

The saved default takes precedence over the environment default, survives restarts, and applies when an export request omits `destination`. An explicit destination takes precedence. Retrying with an existing `exportKey` and no destination retains that export's destination even after the default changes. Credentials and destination addresses remain environment configuration and require an API restart; the administrator API does not accept or return secrets.

Schema definitions, rules, thresholds and mappings are immutable versions. Classification pins the extraction schema before the provider call; automatic/provider retries and Execution Log extraction retries retain it. Successful extraction replaces the fields and their result version atomically. Validation, field labels/required flags, thresholds and new canonical exports use the result version. A failed replacement with the same document type preserves previous fields and their version. Selecting a different type starts a new form; values from the previous type are cleared rather than relabeled. Full **Reprocess** or explicit type selection can adopt a newer active version, with selection and application recorded in the audit log. Existing Pending/Failed exports keep their saved payload and mapping.

Seed tracks its last applied field/rule/mapping definition. Repeating an unchanged seed preserves administrator versions and historical definitions. A changed seed definition creates a new active version while preserving the administrator's current thresholds. On upgrade, matching historical definitions establish the seed baseline without replacement. Migration `0009_versioned_configuration.sql` backfills result bindings from field versions or recorded validation decisions and copies the previously used static mappings. It cannot reconstruct definitions already overwritten by an older release.
