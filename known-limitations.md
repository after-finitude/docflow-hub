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

Google Drive and Google Sheets are temporarily disabled at the user's request on 2026-09-07, including when credentials exist. The shared `GOOGLE_WORKSPACE_ENABLED=false` gate prevents adapter registration and disables Sheets export/retry buttons. JSON export and local-folder ingestion remain available; historical source/export records are retained. Real Google acceptance is deferred until these integrations are re-enabled.

- Google Sheets and Google Drive require service-account credentials and have not been demonstrated by the mock evaluation. Sheets allocation/retry behavior is covered against PostgreSQL with a mocked Google API; a real Sheets verification is deferred at the user's request.
- Export failures require an operator retry; there are intentionally no automatic export retries. The approved payload is frozen until delivery finishes.
- A Sheets tab requires a consistent column layout across document types and schema versions. Changing the layout requires another tab; mismatches fail before writing.
- Sheets row identity assumes managed rows are not inserted, deleted, moved, sorted, or edited manually; see `docs/runbook.md`.
- Historical failed exports from before durable snapshots were introduced require destination reconciliation before a new export key is used; their unknown original writes cannot be safely guessed.
- Local-folder synchronization uses full snapshots; Google Drive uses the changes cursor API.

## Delivery

- `docs/demo.webm` and `docs/screenshots/` demonstrate the mock stack with real review, export and retry actions. The paced recording is not an operator-speed measurement.
- Generated documents and fixtures are synthetic. They are suitable for a demo, not for measuring production document diversity.

## Security and stack decisions

- Accepted by the user on 2026-09-07: public status-only health and optional-auth logout are retained; see `docs/configuration.md`. PDF processing now uses PDF.js with native canvas; Sharp remains for image preprocessing (explicitly accepted), updated to 0.35.4. qpdf validates compressed streams that PDF.js can silently recover. It rejects damaged PDFs, including warnings; native worker execution needs the qpdf executable. No MuPDF runtime remains.
- Encrypted envelopes use separate service keys and are decrypted in memory. Synthetic delivery is exercised with real SDK constructors and separate read-only Docker mounts; connectivity with real Google/LLM credentials is still deferred. Host/process compromise can expose in-memory credentials. Secrets and keys need independent backup controls.
- The full npm audit on 2026-09-07 reports no high/critical issues and eight affected packages at moderate severity, from three transitive advisories: development-only esbuild via drizzle-kit, and decode-uri-component / stream-json via MinIO. npm's proposed fixes downgrade the parent libraries across major versions; those forced changes are not applied. `evaluation/dependencies.json` contains exact advisory URLs and ranges. Do not expose an esbuild development server; use trusted storage endpoints. Recheck and update when compatible upstream fixes are available.
