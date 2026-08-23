#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=0
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
note() { printf '    \033[2m%s\033[0m\n' "$1"; }

run() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then pass "$name"; else
    fail "$name"
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
  fi
}

step "1/3  Static checks"
run "types (tsc -b)"          npx tsc -b
run "lint (oxlint)"           npx oxlint
run "formatting"              npx prettier --check .
run "web application build"  npm run build -w @docflow/web

step "2/3  Environment setup"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker was not found in PATH"
  note "run: brew link docker"
  exit 1
fi
pass "docker is available"

if ! docker info >/dev/null 2>&1; then
  fail "docker daemon is not responding"
  note "run: colima start"
  exit 1
fi
pass "docker daemon is responding"

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  fail "docker compose is unavailable"
  note "install the Compose plugin or docker-compose"
  exit 1
fi
pass "docker compose is available"

if [ ! -f .env ]; then
  fail ".env is missing"
  note "run: cp example.env .env and set passwords and JWT_SECRET"
  exit 1
fi
pass ".env is present"

set -a; . ./.env; set +a
WEB_PORT="${WEB_HOST_PORT:-3000}"
API_PORT_HOST="${API_HOST_PORT:-3001}"
PROJECT="docflow-hub"

run "compose up --build" compose up --build -d --wait

step "3/3  Running-stack checks"

psql_owner() {
  compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>&1
}
psql_app() {
  compose exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres \
    psql -U docflow_app -d "$POSTGRES_DB" -tAc "$1" 2>&1
}

tables=$(psql_owner "select count(*) from information_schema.tables where table_schema='public'")
if [ "${tables:-0}" -ge 9 ] 2>/dev/null; then
  pass "Check 82 passed"
else
  fail "Check 84 failed"
fi

seeded=$(psql_owner "select count(*) from users")
if [ "${seeded:-0}" = "2" ]; then
  pass "Check 89 passed"
else
  fail "Check 91 failed"
fi

if psql_app "insert into audit_events (actor_type, action, object_type, result)
             values ('system','verify.probe','test','success')" >/dev/null 2>&1; then
  pass "Check 96 passed"
else
  fail "Check 98 failed"
fi

denied() { printf '%s' "$1" | grep -qi "denied"; }

if denied "$(psql_app "update audit_events set result='tampered'")"; then
  pass "Check 104 passed"
else
  fail "Check 106 failed"
fi

if denied "$(psql_app "delete from audit_events")"; then
  pass "Check 110 passed"
else
  fail "Check 112 failed"
fi

if denied "$(psql_app "create table verify_probe (id int)")"; then
  pass "Check 116 passed"
else
  fail "Check 118 failed"
fi

if docker run --rm -v "${PROJECT}_postgres-data:/v" alpine \
     test -f /v/18/docker/PG_VERSION >/dev/null 2>&1; then
  pass "Check 123 passed"
else
  fail "Check 125 failed"
fi

login_code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIES" \
  -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${SEED_OPERATOR_LOGIN}\",\"password\":\"${SEED_OPERATOR_PASSWORD}\"}")
if [ "$login_code" = "200" ]; then
  pass "Check 133 passed"
else
  fail "Check 135 failed"
  note "Check 136 note"
fi

if grep -q docflow_session "$COOKIES"; then
  pass "Check 140 passed"
else
  fail "Check 142 failed"
  note "Check 143 note"
fi

me=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/auth/me")
if printf '%s' "$me" | grep -q "\"login\":\"${SEED_OPERATOR_LOGIN}\""; then
  pass "Check 148 passed"
else
  fail "Check 150 failed"
fi

logged=$(psql_owner "select count(*) from audit_events where action='auth.login' and result='success'")
if [ "${logged:-0}" -ge 1 ] 2>/dev/null; then
  pass "Check 155 passed"
else
  fail "Check 157 failed"
fi

loop_code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-redirs 5 \
  -H 'Cookie: docflow_session=garbage' "http://localhost:${WEB_PORT}/inbox")
if [ "$loop_code" = "200" ]; then
  pass "Check 163 passed"
else
  fail "Check 165 failed"
fi

logout_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Cookie: docflow_session=garbage' "http://localhost:${WEB_PORT}/api/auth/logout")
if [ "$logout_code" = "204" ]; then
  pass "Check 171 passed"
else
  fail "Check 173 failed"
fi

limit=$(( ${LOGIN_RATE_LIMIT:-10} + 2 ))
throttled=""
for _ in $(seq 1 "$limit"); do
  throttled=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"login\":\"${SEED_OPERATOR_LOGIN}\",\"password\":\"wrong\"}")
done
if [ "$throttled" = "429" ]; then
  pass "Check 185 passed"
else
  fail "Check 187 failed"
fi


json() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=$1;console.log(v==null?'':v)}catch{console.log('')}})"
}

sleep "$(( ${LOGIN_RATE_WINDOW_SECONDS:-60} + 1 ))"
curl -s -o /dev/null -c "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${SEED_OPERATOR_LOGIN}\",\"password\":\"${SEED_OPERATOR_PASSWORD}\"}"

upload_document() {
  curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents" -F "file=@$1"
}

await_settled() {
  local body status
  for _ in $(seq 1 30); do
    body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/$1")
    status=$(printf '%s' "$body" | json "o.status")
    case "$status" in
      received | processing) sleep 1 ;;
      *) printf '%s' "$body"; return 0 ;;
    esac
  done
  printf '%s' "$body"
}

good_id=$(upload_document scripts/fixtures/sample-invoice.pdf | json "o.id")
if [ -n "$good_id" ]; then
  pass "Check 219 passed"
else
  fail "Check 221 failed"
fi

if [ -n "$good_id" ]; then
  settled=$(await_settled "$good_id")
  status=$(printf '%s' "$settled" | json "o.status")
  thumb=$(printf '%s' "$settled" | json "o.hasThumbnail")
  pages=$(printf '%s' "$settled" | json "o.pageCount")

  if [ "$status" = "approved" ]; then
    pass "Check 231 passed"
  else
    fail "Check 233 failed"
  fi

  [ "$thumb" = "true" ] && pass "Check 236 passed" || fail "Check 236 failed"
  [ "$pages" = "1" ] && pass "Check 237 passed" || fail "Check 237 failed"

  thumb_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' \
    "http://localhost:${WEB_PORT}/api/documents/${good_id}/thumbnail")
  case "$thumb_type" in
    image/png*) pass "Check 242 passed" ;;
    *) fail "Check 243 failed" ;;
  esac

  signed=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}/file" | json "o.url")
  if printf '%s' "$signed" | grep -q "X-Amz-Signature"; then
    pass "Check 248 passed"
  else
    fail "Check 250 failed"
  fi

  pages_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}/pages")
  page_count=$(printf '%s' "$pages_body" | json "o.length")
  [ "${page_count:-0}" -ge 1 ] 2>/dev/null && pass "Check 255 passed" \
    || fail "Check 256 failed"

  page_text=$(printf '%s' "$pages_body" | json "o[0].text")
  case "$page_text" in
    *Invoice*) pass "Check 260 passed" ;;
    *) fail "Check 261 failed" ;;
  esac

  bbox_ok=$(printf '%s' "$pages_body" | json "o[0].blocks.length>0 && o[0].blocks.every(b=>b.bbox && b.bbox.x>=0 && b.bbox.x<=1 && b.bbox.y>=0 && b.bbox.y<=1)")
  [ "$bbox_ok" = "true" ] && pass "Check 265 passed" \
    || fail "Check 266 failed"

  doc_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}")
  doc_type=$(printf '%s' "$doc_body" | json "o.documentType")
  [ "$doc_type" = "invoice" ] && pass "Check 270 passed" \
    || fail "Check 271 failed"

  fields_count=$(printf '%s' "$doc_body" | json "o.fields.length")
  [ "${fields_count:-0}" -ge 8 ] 2>/dev/null && pass "Check 274 passed" \
    || fail "Check 275 failed"

  supplier=$(printf '%s' "$doc_body" | json "JSON.stringify(o.fields.find(f=>f.name==='supplier_name')?.normalizedValue)")
  [ "$supplier" = '"Acme GmbH"' ] && pass "Check 278 passed" \
    || fail "supplier_name: $supplier"

  total=$(printf '%s' "$doc_body" | json "o.fields.find(f=>f.name==='grand_total')?.normalizedValue")
  [ "$total" = "1440" ] && pass "Check 282 passed" || fail "grand_total: $total"

  sourced=$(printf '%s' "$doc_body" | json "o.fields.filter(f=>f.sourceFound && f.sourceBbox && f.sourcePage===1).length")
  [ "${sourced:-0}" -ge 6 ] 2>/dev/null && pass "Check 285 passed" \
    || fail "Check 286 failed"

  missing_flag=$(printf '%s' "$doc_body" | json "o.fields.find(f=>f.name==='line_items')?.rawValue===null && o.fields.find(f=>f.name==='line_items')?.sourceFound===false")
  [ "$missing_flag" = "true" ] && pass "Check 289 passed" \
    || fail "Check 290 failed"

  clean_blocking=$(printf '%s' "$doc_body" | json "o.blockingIssues")
  [ "$clean_blocking" = "0" ] && pass "Check 293 passed" \
    || fail "Check 294 failed"
fi

mismatch_id=$(upload_document scripts/fixtures/invoice-sum-mismatch.pdf | json "o.id")
if [ -n "$mismatch_id" ]; then
  settled=$(await_settled "$mismatch_id")
  status=$(printf '%s' "$settled" | json "o.status")
  [ "$status" = "needs_review" ] && pass "Check 301 passed" \
    || fail "Check 302 failed"

  sum_issue=$(printf '%s' "$settled" | json "JSON.stringify(o.issues.find(i=>i.ruleId==='invoice_totals_match')||null)")
  if printf '%s' "$sum_issue" | grep -q '"severity":"blocking"'; then
    pass "Check 306 passed"
    note "$(printf '%s' "$settled" | json "o.issues.find(i=>i.ruleId==='invoice_totals_match').message")"
  else
    fail "Check 309 failed"
  fi

  expected_actual=$(printf '%s' "$settled" | json "o.issues.find(i=>i.ruleId==='invoice_totals_match')?.expected==='1440.00' && o.issues.find(i=>i.ruleId==='invoice_totals_match')?.actual==='1400.00'")
  [ "$expected_actual" = "true" ] && pass "Check 313 passed" \
    || fail "Check 314 failed"
fi


if [ -n "$mismatch_id" ]; then
  page_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' \
    "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/pages/1/image?width=800")
  case "$page_type" in
    image/png*) pass "Check 322 passed" ;;
    *) fail "Check 323 failed" ;;
  esac

  approve_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/approve")
  [ "$approve_code" = "409" ] && pass "Check 328 passed" \
    || fail "Check 329 failed"

  can_approve=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}" | json "o.canApprove")
  [ "$can_approve" = "false" ] && pass "Check 332 passed" \
    || fail "Check 333 failed"

  patched=$(curl -s -b "$COOKIES" -X PATCH \
    "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/fields/grand_total" \
    -H 'Content-Type: application/json' -d '{"value":"1440.00"}')
  patched_blocking=$(printf '%s' "$patched" | json "o.blockingIssues")
  [ "$patched_blocking" = "0" ] && pass "Check 339 passed" \
    || fail "Check 340 failed"

  patched_edited=$(printf '%s' "$patched" | json "o.fields.find(f=>f.name==='grand_total')?.isEdited")
  [ "$patched_edited" = "true" ] && pass "Check 343 passed" \
    || fail "Check 344 failed"

  patched_can=$(printf '%s' "$patched" | json "o.canApprove")
  [ "$patched_can" = "true" ] && pass "Check 347 passed" \
    || fail "Check 348 failed"

  patched_status=$(printf '%s' "$patched" | json "o.status")
  [ "$patched_status" = "needs_review" ] && pass "Check 351 passed" \
    || fail "Check 352 failed"

  audit_pair=$(psql_owner "select count(*) from audit_events where action='field.edited' and object_type='field' and before is not null and after is not null")
  [ "${audit_pair:-0}" -ge 1 ] 2>/dev/null && pass "Check 355 passed" \
    || fail "Check 356 failed"

  approve_ok=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/approve")
  [ "$approve_ok" = "201" ] || [ "$approve_ok" = "200" ] \
    && pass "Check 361 passed" \
    || fail "Check 362 failed"
fi

if [ -n "$mismatch_id" ]; then
  export_1=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"file_json"}')
  exp_status=$(printf '%s' "$export_1" | json "o.status")
  exp_id=$(printf '%s' "$export_1" | json "o.id")
  exp_ref=$(printf '%s' "$export_1" | json "o.payloadRef")
  if [ "$exp_status" = "succeeded" ] && [ -n "$exp_ref" ]; then
    pass "Check 372 passed"
  else
    fail "Check 374 failed"
  fi

  doc_after=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}" | json "o.status")
  [ "$doc_after" = "exported" ] && pass "Check 378 passed" \
    || fail "Check 379 failed"

  export_2=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"file_json"}')
  exp_id_2=$(printf '%s' "$export_2" | json "o.id")
  [ "$exp_id" = "$exp_id_2" ] && pass "Check 384 passed" \
    || fail "Check 385 failed"

  export_rows=$(psql_owner "select count(*) from exports where document_id='${mismatch_id}'")
  [ "$export_rows" = "1" ] && pass "Check 388 passed" \
    || fail "Check 389 failed"

  bad_dest=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"google_sheets"}')
  [ "$bad_dest" = "400" ] && pass "Check 394 passed" \
    || fail "Check 395 failed"
fi

reject_id=$(upload_document scripts/fixtures/sample-invoice.pdf | json "o.id")
if [ -n "$reject_id" ]; then
  await_settled "$reject_id" >/dev/null
  rejected=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${reject_id}/reject" \
    -H 'Content-Type: application/json' \
    -d '{"reason":"poor_scan_quality","comment":"verification"}')
  rej_status=$(printf '%s' "$rejected" | json "o.status")
  rej_reason=$(printf '%s' "$rejected" | json "o.statusReason")
  if [ "$rej_status" = "rejected" ] && [ -n "$rej_reason" ]; then
    pass "Check 407 passed"
    note "$rej_reason"
  else
    fail "Check 410 failed"
  fi
fi

schemas_count=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/schemas" | json "o.length")
[ "$schemas_count" = "4" ] && pass "Check 415 passed" || fail "Check 415 failed"

thresholds_body='{"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}'
operator_put=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
  -X PUT "http://localhost:${WEB_PORT}/api/schemas/invoice/thresholds" \
  -H 'Content-Type: application/json' -d "$thresholds_body")
[ "$operator_put" = "403" ] && pass "Check 421 passed" \
  || fail "Check 422 failed"

ADMIN_COOKIES="$(mktemp)"
curl -s -o /dev/null -c "$ADMIN_COOKIES" -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${SEED_ADMIN_LOGIN}\",\"password\":\"${SEED_ADMIN_PASSWORD}\"}"
admin_version=$(curl -s -b "$ADMIN_COOKIES" \
  -X PUT "http://localhost:${WEB_PORT}/api/schemas/invoice/thresholds" \
  -H 'Content-Type: application/json' -d "$thresholds_body" | json "o.version")
rm -f "$ADMIN_COOKIES"
if [ -n "$admin_version" ] && [ "$admin_version" -ge 2 ] 2>/dev/null; then
  pass "Check 433 passed"
else
  fail "Check 435 failed"
fi

bad_id=$(upload_document scripts/fixtures/corrupted.pdf | json "o.id")
if [ -n "$bad_id" ]; then
  settled=$(await_settled "$bad_id")
  status=$(printf '%s' "$settled" | json "o.status")
  reason=$(printf '%s' "$settled" | json "o.statusReason")
  if [ "$status" = "rejected" ] && [ -n "$reason" ]; then
    pass "Check 444 passed"
    note "$reason"
  else
    fail "Check 447 failed"
  fi
else
  fail "Check 450 failed"
fi

scan_id=$(upload_document evaluation/dataset/scan-low-quality.jpg | json "o.id")
if [ -n "$scan_id" ]; then
  scan_settled=$(await_settled "$scan_id")
  scan_status=$(printf '%s' "$scan_settled" | json "o.status")
  [ "$scan_status" = "needs_review" ] && pass "Check 457 passed" \
    || fail "Check 458 failed"

  scan_issue=$(printf '%s' "$scan_settled" | json "o.issues.some(i=>i.ruleId==='ocr_quality_low' && i.severity==='warning')")
  if [ "$scan_issue" = "true" ]; then
    pass "Check 462 passed"
    note "$(printf '%s' "$scan_settled" | json "o.issues.find(i=>i.ruleId==='ocr_quality_low').message")"
  else
    fail "Check 465 failed"
  fi

  replaced=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${scan_id}/file" \
    -F "file=@scripts/fixtures/sample-invoice.pdf")
  new_id=$(printf '%s' "$replaced" | json "o.id")
  new_version=$(printf '%s' "$replaced" | json "o.versionNumber")
  new_previous=$(printf '%s' "$replaced" | json "o.previousVersionId")

  if [ -n "$new_id" ] && [ "$new_id" != "$scan_id" ] && [ "$new_version" = "2" ]; then
    pass "Check 475 passed"
  else
    fail "Check 477 failed"
  fi
  [ "$new_previous" = "$scan_id" ] && pass "Check 479 passed" \
    || fail "Check 480 failed"

  old_active=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${scan_id}" | json "o.isActive")
  [ "$old_active" = "false" ] && pass "Check 483 passed" \
    || fail "Check 484 failed"

  replace_audit=$(psql_owner "select count(*) from audit_events where action='document.file_replaced'")
  [ "${replace_audit:-0}" -ge 1 ] 2>/dev/null && pass "Check 487 passed" \
    || fail "Check 488 failed"

  same=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${new_id}/file" \
    -F "file=@scripts/fixtures/sample-invoice.pdf")
  [ "$same" = "400" ] && pass "Check 493 passed" \
    || fail "Check 494 failed"
fi

txt_code=$(printf 'plain text' > /tmp/docflow-verify.txt && curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents" -F 'file=@/tmp/docflow-verify.txt')
rm -f /tmp/docflow-verify.txt
[ "$txt_code" = "400" ] && pass "Check 500 passed" || fail "Check 500 failed"

dup_id=$(upload_document scripts/fixtures/sample-invoice.pdf | json "o.id")
if [ -n "$dup_id" ]; then
  dup_of=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${dup_id}" | json "o.duplicateOfId")
  [ -n "$dup_of" ] && pass "Check 505 passed" || fail "Check 505 failed"

  dup_settled=$(await_settled "$dup_id")
  unique_issue=$(printf '%s' "$dup_settled" | json "o.issues.some(i=>i.ruleId==='invoice_number_unique' && i.severity==='blocking')")
  [ "$unique_issue" = "true" ] && pass "Check 509 passed" \
    || fail "Check 510 failed"

  early=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${dup_id}/export" \
    -H 'Content-Type: application/json' -d '{}')
  [ "$early" = "400" ] && pass "Check 515 passed" \
    || fail "Check 516 failed"
fi

filtered=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents?status=rejected" | json "o.items.every(i=>i.status==='rejected')")
[ "$filtered" = "true" ] && pass "Check 520 passed" || fail "Check 520 failed"


runs_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?page=1")
runs_total=$(printf '%s' "$runs_body" | json "o.total")
[ "${runs_total:-0}" -ge 5 ] 2>/dev/null && pass "Check 525 passed" \
  || fail "Check 526 failed"

runs_shape=$(printf '%s' "$runs_body" | json "o.items.every(r=>r.correlationId && r.step && r.state) && o.items.some(r=>r.step==='ingestion') && o.items.some(r=>r.durationMs!==null)")
[ "$runs_shape" = "true" ] && pass "Check 529 passed" \
  || fail "Check 530 failed"

errors_only=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?onlyErrors=true" \
  | json "o.items.every(r=>r.state==='failed')")
[ "$errors_only" = "true" ] && pass "Check 534 passed" \
  || fail "Check 535 failed"

step_filter=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?step=ocr" \
  | json "o.items.every(r=>r.step==='ocr')")
[ "$step_filter" = "true" ] && pass "Check 539 passed" || fail "Check 539 failed"

if [ -n "$bad_id" ]; then
  dl_permanent=$(psql_owner "select count(*) from dead_letters where document_id='${bad_id}'")
  [ "${dl_permanent:-1}" = "0" ] && pass "Check 543 passed" \
    || fail "Check 544 failed"
fi

if [ -n "$reject_id" ]; then
  storage_key=$(psql_owner "select storage_key from documents where id='${reject_id}'")
  mc_setup=$(compose exec -T minio sh -c \
    "mc alias set probe http://localhost:9000 '${MINIO_ROOT_USER}' '${MINIO_ROOT_PASSWORD}' >/dev/null 2>&1 && \
     mc cp probe/${MINIO_BUCKET}/${storage_key} /tmp/original.bin >/dev/null 2>&1 && \
     mc rm probe/${MINIO_BUCKET}/${storage_key} >/dev/null 2>&1 && echo ok" 2>&1)
  if [ "$mc_setup" = "ok" ]; then
    curl -s -o /dev/null -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${reject_id}/reprocess"

    dl_id=""
    for _ in $(seq 1 30); do
      dl_id=$(psql_owner "select id from dead_letters where document_id='${reject_id}' limit 1")
      [ -n "$dl_id" ] && break
      sleep 1
    done

    if [ -n "$dl_id" ]; then
      pass "Check 564 passed"
    else
      fail "Check 566 failed"
    fi

    dl_detail=$(psql_owner "select (payload is not null and error_message <> '' and stack is not null) from dead_letters where document_id='${reject_id}' limit 1")
    [ "$dl_detail" = "t" ] && pass "Check 570 passed" \
      || fail "Check 571 failed"

    failed_run=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?onlyErrors=true" \
      | json "o.items.find(r=>r.documentId==='${reject_id}' && r.deadLetter)?.id")
    if [ -n "$failed_run" ]; then
      pass "Check 576 passed"
    else
      fail "Check 578 failed"
    fi

    compose exec -T minio sh -c \
      "mc cp /tmp/original.bin probe/${MINIO_BUCKET}/${storage_key} >/dev/null 2>&1" >/dev/null 2>&1

    if [ -n "$failed_run" ]; then
      retry_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
        -X POST "http://localhost:${WEB_PORT}/api/runs/${failed_run}/retry")
      case "$retry_code" in
        200 | 201) pass "Check 588 passed" ;;
        *) fail "Check 589 failed" ;;
      esac

      retried=$(psql_owner "select count(*) from dead_letters where document_id='${reject_id}' and retried_at is not null")
      [ "${retried:-0}" -ge 1 ] 2>/dev/null && pass "Check 593 passed" \
        || fail "Check 594 failed"

      await_settled "$reject_id" >/dev/null
      after_retry=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${reject_id}" | json "o.status")
      [ "$after_retry" != "failed" ] && pass "Check 598 passed" \
        || fail "Check 599 failed"
    fi
  else
    fail "Check 602 failed"
  fi
fi

SOURCE_DIR="docker/source-inbox"
resync() { compose restart worker >/dev/null 2>&1; sleep 6; }

drive_docs() {
  curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents?source=drive&pageSize=50"
}

if [ "${SOURCE_PROVIDER:-none}" = "local_folder" ]; then
  cp scripts/fixtures/sample-invoice.pdf "${SOURCE_DIR}/synced.pdf"
  resync

  synced_id=""
  for _ in $(seq 1 20); do
    synced_id=$(drive_docs | json "o.items.find(i=>i.sourceType==='drive')?.id")
    [ -n "$synced_id" ] && break
    sleep 1
  done

  if [ -n "$synced_id" ]; then
    pass "Check 625 passed"
    await_settled "$synced_id" >/dev/null

    cross_dup=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${synced_id}" | json "o.duplicateOfId")
    [ -n "$cross_dup" ] && pass "Check 629 passed" \
      || fail "Check 630 failed"

    src_replace=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
      -X POST "http://localhost:${WEB_PORT}/api/documents/${synced_id}/file" \
      -F "file=@scripts/fixtures/invoice-sum-mismatch.pdf")
    [ "$src_replace" = "400" ] && pass "Check 635 passed" \
      || fail "Check 636 failed"
  else
    fail "Check 638 failed"
  fi

  resync
  same_count=$(drive_docs | json "o.total")
  [ "$same_count" = "1" ] && pass "Check 643 passed" \
    || fail "Check 644 failed"

  cp scripts/fixtures/invoice-sum-mismatch.pdf "${SOURCE_DIR}/synced.pdf"
  resync
  sleep 4
  versions=$(drive_docs | json "o.total")
  v2_active=$(drive_docs | json "o.items.some(i=>i.versionNumber===2 && i.isActive)")
  v1_inactive=$(drive_docs | json "o.items.some(i=>i.versionNumber===1 && !i.isActive)")
  [ "$versions" = "2" ] && pass "Check 652 passed" \
    || fail "Check 653 failed"
  [ "$v2_active" = "true" ] && pass "Check 654 passed" \
    || fail "Check 655 failed"
  [ "$v1_inactive" = "true" ] && pass "Check 656 passed" \
    || fail "Check 657 failed"

  rm -f "${SOURCE_DIR}/synced.pdf"
  resync
  sleep 2
  all_inactive=$(drive_docs | json "o.items.every(i=>!i.isActive) && o.total===2")
  [ "$all_inactive" = "true" ] && pass "Check 663 passed" \
    || fail "Check 664 failed"

  deact_audit=$(psql_owner "select count(*) from audit_events where action='document.deactivated'")
  [ "${deact_audit:-0}" -ge 1 ] 2>/dev/null && pass "Check 667 passed" \
    || fail "Check 668 failed"

  purge_id=$(psql_owner "select id from documents where source_type='drive' and version_number=1 limit 1")
  if [ -n "$purge_id" ]; then
    psql_owner "update documents set deactivated_at = now() - interval '400 days' where id='${purge_id}'" >/dev/null
    resync
    sleep 3
    purged=$(psql_owner "select count(*) from documents where id='${purge_id}'")
    [ "$purged" = "0" ] && pass "Check 676 passed" \
      || fail "Check 677 failed"

    purge_audit=$(psql_owner "select count(*) from audit_events where action='document.purged' and object_id='${purge_id}'")
    [ "${purge_audit:-0}" -ge 1 ] 2>/dev/null && pass "Check 680 passed" \
      || fail "Check 681 failed"
  else
    fail "Check 683 failed"
  fi
else
  note "Check 686 note"
fi

sse_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' --max-time 3 \
  "http://localhost:${WEB_PORT}/api/events/stream")
case "$sse_type" in
  text/event-stream*) pass "Check 692 passed" ;;
  *) fail "Check 693 failed" ;;
esac

psql_owner "delete from audit_events where action='verify.probe'" >/dev/null 2>&1

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mAll checks passed.\033[0m\n'
else
  printf '\033[31mSome checks failed; see above.\033[0m\n'
fi
printf 'Web application: http://localhost:%s   Stop: compose down\n' "$WEB_PORT"
exit "$FAILED"
