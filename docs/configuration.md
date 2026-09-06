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
- `EXPORT_DEFAULT_DESTINATION=file_json|google_sheets` selects the initial export default. JSON is always available. Sheets is enabled when both `GOOGLE_SHEETS_KEY_FILE` and `GOOGLE_SHEETS_SPREADSHEET_ID` are set; partial or blank configuration is rejected. `GOOGLE_SHEETS_SHEET_NAME` defaults to `Documents`. Mount the key file read-only inside the API container.
- `SOURCE_PROVIDER=none|local_folder|google_drive`. Local folder requires `LOCAL_SOURCE_DIR`; Drive requires its key file and folder ID.

## Operations

- `QUEUE_CONCURRENCY_DEFAULT`, `QUEUE_CONCURRENCY_OCR`, and `QUEUE_CONCURRENCY_EXTRACT` control BullMQ processing.
- `SOURCE_SYNC_INTERVAL_SECONDS` controls source synchronization.
- `RETENTION_DAYS` controls permanent deletion after deactivation.
- `ORPHAN_TTL_HOURS` controls cleanup of unreferenced storage objects.
- `SIGNED_URL_TTL_SECONDS` controls original-file link lifetime.

Never commit `.env` or provider credentials. Docker Compose passes only the variables each service needs; the web container does not receive database, storage, or JWT secrets.


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
