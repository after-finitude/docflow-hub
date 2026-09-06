# Known Limitations

## Provider validation

The committed evaluation report uses deterministic mock OCR and LLM providers. It validates pipeline behavior, not real-provider model quality. Run `npm run eval` with configured Google Vision and OpenAI-compatible providers before production use.

## OCR and documents

- Image deskewing is not implemented; preprocessing applies EXIF rotation and contrast normalization only.
- The mock OCR reads PDF text layers and returns empty text for images.
- Suspected multiple documents create a warning and require review, but manual PDF page-range splitting is not implemented.
- Password-protected, corrupted, empty, unsupported, and oversized files are rejected before external provider calls.

## Configuration

- Schema fields, rules, thresholds, mappings and the default export destination are managed through the administrator API; there is no settings screen. Credentials and destination addresses stay in environment configuration. Historical definitions overwritten by releases before immutable versioning cannot be reconstructed.
- The required scope uses one fixed tenant ID and does not implement tenant isolation.
- Login throttling is keyed by username because same-origin Next.js rewrites do not provide a trustworthy client IP.

## Export and sources

- Google Sheets and Google Drive require service-account credentials and have not been demonstrated by the mock evaluation. Sheets allocation/retry behavior is covered against PostgreSQL with a mocked Google API; a real Sheets verification is deferred at the user's request.
- Export failures require an operator retry; there are intentionally no automatic export retries. The approved payload is frozen until delivery finishes.
- A Sheets tab requires a consistent column layout across document types and schema versions. Changing the layout requires another tab; mismatches fail before writing.
- Sheets row identity assumes managed rows are not inserted, deleted, moved, sorted, or edited manually; see `docs/runbook.md`.
- Historical failed exports from before durable snapshots were introduced require destination reconciliation before a new export key is used; their unknown original writes cannot be safely guessed.
- Local-folder synchronization uses full snapshots; Google Drive uses the changes cursor API.

## Delivery

- A 60–90 second demonstration video is not stored in this repository.
- Generated documents and fixtures are synthetic. They are suitable for a demo, not for measuring production document diversity.
