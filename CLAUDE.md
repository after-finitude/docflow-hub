# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # tsc -b across shared → core → api → worker (web builds separately)
npm run typecheck      # same as build; web is only type-checked by `next build`
npm run lint           # oxlint
npm run format         # prettier --write
npm run verify         # full check: static + live stack (needs Docker and .env)
```

```bash
npm run db:generate    # generate a migration from the Drizzle schema
npm run db:migrate     # apply migrations (runs as the owner role)
npm run db:seed        # upsert the two seed users
```

Local development without Docker needs Postgres, Redis and MinIO running, plus
`POSTGRES_HOST=localhost` (and equivalents) in `.env`. Backend apps run from
compiled output, so keep `npm run build` in watch mode or rebuild before restart:
`npm run dev:api`, `npm run dev:worker`, `npm run dev:web`.

```bash
npm test               # tsc -b, then node:test over packages/shared/dist/**/*.test.js
```

Unit tests live next to their modules in `packages/shared/src` as `*.test.ts`
(node:test + node:assert, no test framework dependency) and run compiled.
Integration and E2E tests are still pending (PLAN.md §3); `npm run verify`
covers live-stack behaviour meanwhile.

`npm run verify` is the closest thing to a test suite today: it type-checks,
lints, checks formatting, builds the web app, brings up the stack, and then
asserts real behaviour (migrations applied, audit table immutable, login through
the web port, no redirect loops, upload accepted, corrupted file rejected).

## Architecture

### Package split

`packages/shared` is framework-free and imported by **all three apps including
the browser bundle** — keep NestJS, Drizzle and Node-only APIs out of it. It
holds enums, zod contracts, DTO types and domain constants, and later the pure
modules (validation engine, evidence→bbox matcher, confidence scoring) that must
run both in the API (synchronous re-validation on field edit) and in the worker.

`packages/core` is NestJS infrastructure shared by `apps/api` and `apps/worker`:
config, Drizzle schema, storage, queues, events, audit. Never import it from
`apps/web`.

### Pipeline

One BullMQ queue per step (`preprocess`, `ocr`, `classify`, `extract`,
`validate`, `export`) so concurrency is tunable per stage. Two rules govern
every processor:

- **Permanent defects must not throw.** A corrupted or password-protected file
  sets the document to `rejected` and returns normally — throwing would make
  BullMQ retry a file that can never succeed. Only transient failures (storage,
  network, provider 5xx) throw so the retry policy applies.
- **`failed` is set only when attempts are exhausted**, not on each intermediate
  attempt, otherwise the queue flickers with errors.

Every `@Processor` must spread `PIPELINE_WORKER_OPTIONS`. BullMQ looks up the
custom backoff strategy in worker settings; omit it and the 1s/5s/25s policy
silently does nothing.

The pipeline is complete through `validate`, which routes the document:
`approved` when there are no blocking issues **and** every critical field is at
or above the schema threshold, `needs_review` otherwise (ТЗ 6.7). Export runs
synchronously in the API (see below), not through the `export` queue — that
queue stays registered for future batch export and the stage-9 DLQ. Providers
are config-selected: `OCR_PROVIDER` (`mock` reads the PDF
text layer via mupdf — no external calls, real coordinates; `google` rasterizes
pages and sends them one by one, blank pages never sent) and `LLM_PROVIDER`
(`mock` is keyed to the demo-set "Label: value" format; `openai_compatible`
works with any chat-completions endpoint, e.g. DeepSeek). Permanent provider
errors must be thrown as BullMQ `UnrecoverableError`; an LLM response that
fails zod validation after 2 repair attempts throws `LlmInvalidResponseError`,
which sends the document to `needs_review` (manual handling) instead of
retrying or failing.

The LLM must return VERBATIM values; normalization to ISO dates/numbers/
currencies happens in code (`packages/shared/src/normalize`). A model that
normalizes values itself breaks evidence→bbox matching.

### Validation

The rule engine (`packages/shared/src/validation`) is pure — `today` is passed
in so decisions are reproducible and testable. Rules live in the schema's
`json_schema` and are versioned with it; field requiredness comes from
`FieldSpec.required` and is not duplicated as a rule. `ValidationRunnerService`
(in core, used by both the worker and — from stage 6 — the API on field edits)
orchestrates: run engine, add the one cross-document check
(`invoice_number` uniqueness per supplier, the only one ТЗ §9 permits),
replace issues, recompute confidence, route, and audit the decision with the
schema/rule versions.

Confidence is recomputed from `fields.confidence_signals`, never by applying a
penalty to the stored value — otherwise re-validation would compound penalties.
Re-validation replaces only engine-produced issues; ids in `EXTERNAL_RULE_IDS`
(currently the classifier's multi-document warning) survive.

`autoApprove` is true for pipeline runs and **false** when an operator edits a
field: fixing the last blocking issue must not silently approve the document —
the operator presses Approve. Approve re-checks blocking issues server-side;
the disabled button is convenience, not enforcement.

### Export

`buildCanonicalDocument` (shared) produces the destination-agnostic payload;
`generatedAt` is passed in, like `today` in validation, so the output is
reproducible. Adapters receive the canonical document plus a mapping from
`EXPORT_MAPPINGS` — the file adapter ignores the mapping because the canonical
form *is* the file.

Idempotency keys on `export_key`, defaulting to `<documentId>:<destination>`:
a repeat request returns the existing succeeded export without sending again
(ТЗ §9), and retries a failed one with an incremented attempt count. A failing
destination never rolls the document back — it stays approved/exported with the
export row marked `failed`, and retry is manual only (no automatic retries,
ТЗ 6.10).

### Review Workspace viewer

Pages are rasterized server-side by mupdf (`GET /documents/:id/pages/:n/image`)
and shown as `<img>`, deliberately **not** pdfjs-dist in the browser as the spec
suggests. Source bboxes are normalized against the page size mupdf reported
during OCR, so rendering with the same engine guarantees the overlays line up;
a different engine may disagree on CropBox vs MediaBox. The same path serves
scans — mupdf opens images as documents. Overlays are positioned in percent, so
they are independent of zoom and render resolution.

### Session handling

The API is the **only** arbiter of session validity. `apps/web/proxy.ts`
performs exactly one redirect (no cookie → `/login`); pages check the real
session via `readSession()`. Do not add a reverse "has cookie → go to inbox"
rule: cookie presence says nothing about validity, and two sources of truth
produce an infinite redirect loop on every expired session.

`readSession()` returns three states on purpose — `authenticated`, `anonymous`,
`unavailable`. Collapsing "backend down" into "no session" would bounce valid
users to the login form whenever the API restarts.

Logout uses `@OptionalAuth` so it works with an already-invalid token.

### Audit log is append-only

The app connects as `docflow_app`, which has no `UPDATE`/`DELETE` on
`audit_events` (migration `0001_audit_immutability.sql`); migrations and seed run
as the owner role. Code that tries to update or delete audit rows will fail at
runtime by design. It also means nothing should be written there that might later
need cleaning — failed logins record the attempted login only when the account
actually exists.

### Configuration traps

- Database URLs are **derived** in `packages/core/src/config/env.ts` from
  `POSTGRES_*` and `APP_DB_PASSWORD`. Do not reintroduce ready-made URLs: a
  password stored in two places drifts silently.
- The session cookie name and the app DB role are **constants, not env vars**.
  The same value must hold in two independent processes, and the Next build runs
  without `.env`.
- `API_INTERNAL_URL` is read at **build time** by `next.config.ts` (rewrites are
  frozen into the manifest) and at **runtime** by `lib/api.ts`. In Docker it must
  be passed as a build arg; setting it only in `environment` leaves the browser
  proxying to `localhost` inside the web container.
- MinIO has two clients: internal for read/write, public for presigning. A URL
  signed with the container host cannot be opened by a browser.
- Rate limiting keys on the login, not the IP: the Next rewrite does not set
  `X-Forwarded-For`, so every request appears to come from the web container.

### Cross-container events

Status changes happen in the worker, SSE is served by the API — different
processes, so they communicate over Redis pub/sub (`DocumentEventsService`).

### Storage layout

All files of a document live under one prefix (`documents/<objectId>/…`) so
retention can delete them in one call. The prefix is derived from `storage_key`,
not from the document id, because the file is written before the row exists.

## TypeScript 7 constraints

The stack is pinned to TypeScript 7 (the native compiler), which breaks tooling
that relies on the old JS compiler API. Consequences already handled — do not
"fix" them back:

- **oxlint instead of ESLint**: typescript-eslint requires TS < 6.1.
- **`experimental.useTypeScriptCli`** in `next.config.ts` is the only supported
  way Next.js works with TS 7.
- **Ambient `@types` augmentation is not picked up.** Types that a package only
  contributes globally (e.g. `Express.Multer.File`) must be declared locally.
- **Dynamic `import()` is preserved** in CommonJS output, so ESM-only packages
  such as `mupdf` are used via `await import()`.

`moduleResolution` is `node16`; `node10` was removed.

## Working in this repository

PLAN.md is the roadmap: work proceeds in numbered stages, each with a DoD and a
record of deviations. Stages 1–2 are implemented. known-limitations.md tracks
what is deliberately deferred, mocked, or constrained by tooling — check it
before assuming something is a bug.

The spec (`ТЗ №1 v2`) drives the requirements; code comments reference its
sections (e.g. "ТЗ 6.1") where behaviour is non-obvious. Keep decisions and
rationale in PLAN.md and known-limitations.md.

## Commit messages

Conventional Commits, **one line, English, no body**:

```
feat: document upload, preprocessing and inbox queue
fix: signed thumbnail url unreachable from browser
refactor: derive database urls from components
```

- No multi-line explanations. Rationale for a decision goes into PLAN.md or
  known-limitations.md, not into git history.
- **No `Co-Authored-By` trailer.** Claude Code adds it by default — strip it.
- Subject under ~70 characters, imperative, lowercase after the type prefix.
