# Known Limitations

## Provider validation

The committed evaluation and performance reports use deterministic mock OCR and LLM providers through a real API/worker/PostgreSQL/Redis/MinIO stack. The 15 labeled cases meet the quality targets; the full 46-document corpus has 97.6% field coverage against a 98% target because the poor image scan is Unknown under mock OCR. False auto-approval is zero. Mock extraction also returns numeric taxpayer IDs against a string schema; validation sends these tax letters to review. These are reported findings, not evidence of real-provider quality.

The user deferred the real-provider run on 2026-09-07. Repeat the isolated evaluation with configured Google Vision and a real LLM, including Russian/English rotated and skewed scans; commands and denominator definitions are in `docs/runbook.md` and `evaluation/last-run.md`. Stage 6 remains open for this verification and a human review-time sample.

Performance results are small localhost samples with warm processes and mock providers. The ten-page fixture contains one invoice plus nine nonblank text attachments. It does not establish dense/scanned ten-page performance, production capacity, external-provider latency or human review speed. Review timing uses the approving user's first opening in the current processing revision; time away from the page is included, and approvals without a matching opening are counted separately.

## OCR and documents

- Orientation and deskew use one dominant reading direction from at least three confident Vision words, with at most one correction pass. Mixed orientations, too little recognized text and nonlinear page distortion may still require manual handling. Coordinate behavior is tested with controlled Vision responses; real Russian/English scan quality remains unverified.
- The mock OCR reads PDF text layers and returns empty text for images.
- Suspected multiple documents require review. Split and reupload them with an existing PDF editor; the procedure is in `docs/runbook.md`. There is no built-in splitting tool.
- Password-protected, corrupted, empty, unsupported, and oversized files are rejected before external provider calls. Oversized uploads retain a Rejected metadata record without an original; direct multipart refusals have an unknown exact size.

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
