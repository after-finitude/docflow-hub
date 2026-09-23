# Refactoring Plan

Findings from a structural review of the repository on 2026-09-23 (~21k lines across
`packages/shared` → `core` → `api`/`worker`/`web`). The code itself is disciplined:
strict TypeScript with no `any`, 27 non-null assertions repository-wide, and
non-obvious invariants documented against specification sections. The weaknesses
are structural, and they sit in three places: nothing verified a change before it
reached the server, reads take exclusive locks and compete for a small connection
pool, and two axes — the pipeline processor and the document state machine — are
duplicated by hand.

Stages are independent except where noted: 4 depends on 3, and 4 and 5 both edit
`documents.service.ts`, so 5 goes first to avoid rewriting the same guards twice.
Each stage names its primary files and what proves it done. This document is about
internal structure only; feature scope and specification compliance stay in
`PLAN.md`, and deliberate deferrals in `known-limitations.md`.

## 1. Deployment gate — done 2026-09-23

Nothing verified a change before deployment: the only workflow pushed `main`
straight to the server. The integration suite was opt-in through
`TEST_DATABASE_URL`, so in practice it never ran, and neither did the
audit-immutability subtest behind `TEST_APP_DB_PASSWORD`.

- [x] `.github/workflows/ci.yml`: build → lint → format:check → test → web build,
      with a `postgres:18-alpine` service, `qpdf` from apt (`document-inspector`
      shells out to it, and without it every valid PDF reports "PDF inspection
      unavailable"), and a `docflow_app` role so the audit checks run.
- [x] `deploy.yml` calls it as a reusable workflow and gates on `needs: ci`. CI has
      no `push: main` trigger of its own; that would run the same checks twice.
- [x] `format:check` script — CI must not silently rewrite files with `--write`.

**Verified:** commit `f3b5d4f` failed the gate on Format and skipped deployment;
after `8f77359` the run was green end to end with 186 tests passing, 0 skipped.
The zero matters: it means the PostgreSQL suite and the audit-role subtest
actually executed rather than opting out.

Formatting had drifted in 14 files because only `--write` had ever been run. That
drift is now committed, and `output/` is in `.prettierignore` as a generated
artifact.

## 2. Connection pool, export deadlock and indexes — done 2026-09-23 except the query-plan check

Primary files: `apps/api/src/export/export.service.ts`,
`packages/core/src/db/db.module.ts`, `packages/core/src/db/schema.ts`,
`apps/api/src/documents/documents.service.ts`, new migration `0011`.

**Export can deadlock the pool.** `ExportService.export` takes a dedicated client
with `pool.connect()` and holds it, with a session-level advisory lock, for the
whole export — including the external HTTP call. Inside, `exportLocked` calls
`this.settings()` without an argument, which defaults to `this.db` and acquires a
**second** connection from the same pool. `DbModule` builds
`new Pool({ connectionString })` on defaults — `max: 10`,
`connectionTimeoutMillis: 0` — so ten concurrent exports (fewer if other requests
hold connections) each hold one connection and wait forever for another. The
whole API stops, not just export.

`audit_events` is indexed on `(object_type, object_id)`, `(correlation_id)` and
`(created_at)`. `DocumentsService.reviewOpening` filters by `object_id` **without**
`object_type`, so the leading column is absent and the index cannot apply. That is
a sequential scan over an append-only table that only grows, run inside a
transaction holding a row lock, on every review opening and every approval.
`reviewMetrics` scans the same table by `action`.

- [x] Pass the dedicated connection through: `this.settings(db)` in
      `exportLocked`. Do this first; it is one line and removes the deadlock.
- [x] Bound concurrent exports below `max`: `EXPORT_MAX_CONCURRENT` (default 4),
      counted per API process, 503 above it; the API refuses to start unless it is
      below `DB_POOL_MAX`. Moving the connection out of the external call would
      mean replacing the session lock with a lease — a redesign, not a refactor.
- [x] Add `eq(auditEvents.objectType, 'document')` to `reviewOpening` — every
      `document.review_opened` row is written with that type, so the existing
      `audit_events_object_idx` applies and no new index is needed for it.
- [x] Migration `0011_audit_action_index`: `audit_events (action, created_at)` for
      `reviewMetrics`. Plain `CREATE INDEX` — drizzle runs migrations in a
      transaction, so `CONCURRENTLY` is unavailable; writes to `audit_events` wait
      while it builds.
- [x] `DB_POOL_MAX` (10) and `DB_CONNECTION_TIMEOUT_MS` (10 s) from configuration;
      Compose passes separate `API_DB_*` and `WORKER_DB_*` values.
- [x] `DB_STATEMENT_TIMEOUT_MS` (30 s, 0 disables). A timed-out wait for the export
      session lock maps to 409. Retention deletes one document per statement;
      other worker queries have not been measured against the limit.

**Done when:** concurrent exports at the pool limit neither deadlock nor make
unrelated requests hang; `explain analyze` shows index scans for both audit
queries on a populated table; a contended export returns a defined status, not a
500. Existing export idempotency checks pass unchanged.

**Verified:** commit `dc2d34a` passed CI with 187 tests, 0 skipped. The new
PostgreSQL check completes an export on a one-connection pool (without the fix
the settings read needs a second checkout; not run against the old code), refuses an export over the limit with 503,
returns 409 when the session-lock wait hits `statement_timeout`, and still serves
a query from the same pool meanwhile. **Not yet verified:** `explain analyze` for
the two audit queries on a populated table.

## 3. Separate reads from writes on a document — done 2026-09-23

Primary files: `apps/api/src/documents/documents.service.ts`.

`findOne(id)` without a transaction opens one and calls `lockDocument`, which is
`SELECT … FOR UPDATE`. A plain `GET /documents/:id` therefore takes an exclusive
row lock — and the review page polls that endpoint every two seconds while a
document is processing, which is exactly when a worker processor wants the same
row. This is a production risk of the same order as stage 2, not only structure.
One detail response is six or more queries, and every mutation calls it again
before returning.

- [x] Split into `findOne(id)` for GET and polling — a `REPEATABLE READ`,
      `READ ONLY` transaction with no row lock — and `readDetail(db, id, { locked })`
      used inside mutations. The lock was not only for the snapshot:
      `getDocumentSchema` repairs a stale document-level schema binding, a write
      that needs the lock. It now takes `{ backfill: false }` for reads; every
      writer (validation, extraction, export, mutation responses) still repairs.
- [ ] ~~Collapse the detail read to two or three queries.~~ Not done. Without the
      lock the read is six short indexed queries on one connection. Going lower
      means `json_agg` subqueries for fields, issues and exports, trading typed
      Drizzle selects for hand-mapped JSON; not worth it until the read shows up
      in measurements. The separate `FOR UPDATE` select is gone (seven → six).
- [x] Derive the row type from `listColumns` (`SelectResultFields`) instead of
      the `as unknown as` cast over 20 fields in `toListItem`.

**Done when:** the existing HTTP tests pass unmodified, plus a check that
concurrent reads do not block a mutation.

**Verified:** commit `426559a` passed CI with 188 tests, 0 skipped. The new check
holds `FOR UPDATE` on a document in another transaction and gets the detail back
in 48 ms; the same read leaves a missing schema binding alone and a reject then
repairs it.

## 4. Split DocumentsService (after 3 and 5)

Primary files: `apps/api/src/documents/documents.service.ts` (902 lines, five
responsibilities: list/detail, lifecycle transitions, upload and file replacement,
file and thumbnail delivery, review metrics).

- [ ] `DocumentLifecycleService` — approve, reject, changeType, reprocess, updateField.
- [ ] `DocumentQueryService` — list, findOne, pages.
- [ ] `DocumentFilesService` — upload, replaceFile, thumbnail, signedUrl.
- [ ] Review metrics move out; the controller stays as it is.

**Done when:** the same HTTP tests pass and each service owns exactly one of the
responsibilities above. Line count is a symptom, not the criterion.

## 5. Operator actions in one table — implemented, verification pending

Primary files: `packages/shared` (new module), `apps/api/src/documents`,
`apps/api/src/runs/runs.service.ts`, `apps/api/src/export/export.service.ts`,
`apps/web/app/documents/[id]/review-workspace.tsx`,
`apps/web/app/inbox/inbox-client.tsx`, `packages/core/src/db/workflow.ts`,
`packages/core/src/validation/validation-runner.service.ts`.

Status lists such as `['needs_review', 'approved', 'failed']` and
`['received', 'processing', 'exported']` are written out by hand in 13 places
across seven files — including a separate copy in the client, which decides
`readOnly` and button availability from its own list. Which action is legal in
which status is nowhere stated in one piece.

The 13 places are not one concept, and forcing them into one table would be the
wrong abstraction. Most are operator permissions (approve, reject, changeType,
reprocess, updateField, export, retry). The rest are different questions: whether
a worker result is stale (`workflow.ts`), whether validation may route a document
(`validation-runner.service.ts`), and which statuses count as in flight in the
inbox (`IN_FLIGHT`).

- [x] `DOCUMENT_ACTIONS` and `canPerform(action, status)` in
      `packages/shared/src/document-actions.ts`, covering operator actions only:
      editField, reject, approve, changeType, reprocess, export, retryRun,
      sendToManual. Lists are positive (allowed statuses), so a new status is
      disallowed until someone adds it.
- [x] Named predicates `isInFlight` and `isRoutable` in the same module.
- [x] Replace all 13 literal checks, the client ones included, plus the
      single-comparison copies of the same rules (`approve`, `canApprove`, the
      review page's `processing` flag and export panel).

Replacing the client lists exposed three places where server and UI disagreed;
the UI now follows the server, whose behaviour is unchanged:

- The type selector was disabled for `rejected` documents, which the server allows
  to change type (as it allows reprocess). It is now enabled.
- Retry and "Send to manual review" on the Execution Log ignored document status
  and relied on a 400 from the server. They are now disabled when the server would
  refuse.
- Still open: original replacement. The UI allows it in the `editField` statuses;
  the server refuses only `exported` and `processing`, so it also accepts
  `received` and `rejected`. It is not in the table because which side is right is
  a product decision, not a refactor.

Status is not the whole condition. The client also disables actions while an export
is reserved; the server enforces the same rule through `processingStep === 'export'`
in `lockDocumentForEdit`. That check stays separate, so after this stage server and
UI agree on status, and the export reservation remains a second, explicit input.

**Done when:** a unit test covers the action table and the predicates, the
conflict-status integration checks pass without edits, and no status list is
written out by hand outside the new module.

## 6. Shared pipeline failure handling

Primary files: `apps/worker/src/*/**.processor.ts`, `packages/core/src/db/workflow.ts`.

`handleFailure` and `publish` in the `ocr`, `classify`, `extract` and `validate`
processors are character-identical apart from the step, queue name, error code and
reason text — roughly 250 duplicated lines, each copy holding the rule that `failed`
is set only once attempts are exhausted. `preprocess` has its own
variant without the `unrecoverable` branch, because its permanent defects reject
the document instead.

- [ ] `handlePipelineFailure(ctx, job, error)` and `publishStatus(ctx, …)` as
      functions in core, where `ctx` carries `step`, `queue`, `errorCode` and
      `failureReason`. Processors call them; no base class. Inheritance across
      `@Processor` decorators and Nest DI adds coupling, and `preprocess` would not
      fit a shared `process()` skeleton anyway.
- [ ] `preprocess` uses the same helper with unrecoverable handling disabled, or
      keeps its variant if the difference turns out to be more than one flag.

**Done when:** `extraction.test.mjs` and the five-stage pipeline check pass without
changes to the tests, and the dead-letter rule exists in one place.

## 7. Web data layer and live updates

Primary files: `apps/web/lib`, `apps/web/app/inbox/inbox-client.tsx`,
`apps/web/app/runs/runs-client.tsx`, `apps/web/app/documents/[id]/review-workspace.tsx`.

Each client component reimplements `fetch`, `{message}` parsing, the
"Service unavailable" fallback and filter-to-query-string assembly. SSE
infrastructure exists and works in the inbox, yet the document page polls the API
every two seconds instead — the polling that makes the stage 3 lock hurt. In
`inbox-client` the `EventSource` effect depends on `filters`, so every filter
change tears down and recreates the connection, and once the polling fallback
engages there is no path back to SSE.

- [ ] One `EventSource` in the layout, distributed through context; drop the
      two-second polling from the document page.
- [ ] `lib/client.ts` with `apiCall<T>()` — one place for error text and parsing.
- [ ] Break up `review-workspace.tsx` (744 lines) into `DocumentActions`,
      `FieldsPanel`, `ExportPanel` — only alongside other changes to that file;
      on its own it is churn.

**Done when:** `review-refresh.test.mjs` passes; changing an inbox filter does not
drop the event stream; document status updates without polling.

## 8. Shared package bundle (optional)

Primary files: `packages/shared/package.json`, `packages/shared/src/index.ts`.

`@docflow/shared` compiles to CommonJS (`module: node16`, no `"type": "module"`)
and is exported through a single barrel. CommonJS does not tree-shake, so the
browser bundle may receive the validation engine, the evidence matcher, the
canonical export builder and every zod schema, when the UI mostly needs types,
labels and thresholds.

- [ ] Measure first: the share of `@docflow/shared` in the client bundle from
      `next build`. If the UI needs zod for forms anyway, the win may be small, and
      the stage stops here.
- [ ] Only if the measurement justifies it: subpath exports
      (`@docflow/shared/contracts`, `/validation`, `/export`) or an ESM build.

**Done when:** the measurement is recorded here, and — if the change was made —
`next build` succeeds and the client bundle is measurably smaller.

## 9. `noUncheckedIndexedAccess` (optional)

Primary files: `tsconfig.base.json`, every package.

Unrelated to bundle size; a type-safety change of its own. The edits are numerous
but mechanical: `const [row] = await db.select(…)` is everywhere, including
`const [{ pagesCount }] = …`, where an empty result throws a TypeError instead of
a clear error.

- [ ] Enable the flag and fix the resulting errors package by package.

**Done when:** `npm run build` and `next build` pass with the flag on, and empty
single-row results raise explicit errors.

## Secondary items

Small enough to fold into whichever stage touches the same file.

- `RunsService.retry` and `toManual` each call `findRun(runId, db)` twice in a row.
- The worker has no healthcheck in `docker-compose.yml`; postgres, redis, minio and
  the api do.
- Both `DocumentsService.approve` and `ExportService.exportLocked` return a
  `ConflictException` as a value so refreshed state commits before the API throws.
  The technique is correct but deserves a named helper rather than two copies.
- `ExportService.exportLocked` is about 180 lines covering key binding, validation,
  payload snapshot, run start, reserve, send, commit and the failure path.
- The `documents` list builds five correlated subqueries per row plus a separate
  `count(*)`, with offset pagination, and the inbox re-requests it on every event.
- CI takes about six minutes against roughly 40 seconds of deployment alone. If
  that becomes a problem, caching the `tsc -b` output between runs is the cheapest
  win.

## Ordering

1. Stage 2, first item: `this.settings(db)` — removes a whole-API deadlock in one
   line.
2. Stage 3, first item: unlocked GET — removes lock contention between polling and
   the worker.
3. The rest of stage 2: audit query and index, pool settings, timeouts.
4. Stage 5, in the narrowed form above — the most likely source of future
   server/UI divergence.
5. Then 6, 4, 7, 8 and 9: maintenance cost only.

Stage 1 is what makes the rest safe to attempt — the 186 tests it now runs on
every change cover most of what stages 2 through 6 touch.
