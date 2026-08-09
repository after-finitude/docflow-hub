#!/usr/bin/env bash
# Полный прогон проверок этапа 1: статика, затем поведение запущенного стека.
# Стек остаётся поднятым — команда остановки печатается в конце.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=0
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
note() { printf '    \033[2m%s\033[0m\n' "$1"; }

# run <название> <команда...> — падение печатает хвост вывода
run() {
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then pass "$name"; else
    fail "$name"
    printf '%s\n' "$out" | tail -20 | sed 's/^/      /'
  fi
}

step "1/3  Статические проверки"
run "типы (tsc -b)"            npx tsc -b
run "линтер (oxlint)"          npx oxlint
run "форматирование"           npx prettier --check .
run "сборка веб-приложения"    npm run build -w @docflow/web

step "2/3  Подготовка окружения"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker не найден в PATH"
  note "выполните: brew link docker"
  exit 1
fi
pass "docker доступен"

if ! docker info >/dev/null 2>&1; then
  fail "docker-демон не отвечает"
  note "выполните: colima start"
  exit 1
fi
pass "docker-демон отвечает"

if [ ! -f .env ]; then
  fail ".env отсутствует"
  note "выполните: cp example.env .env и задайте пароли и JWT_SECRET"
  exit 1
fi
pass ".env на месте"

set -a; . ./.env; set +a
WEB_PORT="${WEB_HOST_PORT:-3000}"
API_PORT_HOST="${API_HOST_PORT:-3001}"
PROJECT="docflow-hub"

run "docker compose up --build" docker compose up --build -d --wait

step "3/3  Проверки на запущенном стеке"

psql_owner() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>&1
}
psql_app() {
  docker compose exec -T -e PGPASSWORD="$APP_DB_PASSWORD" postgres \
    psql -U docflow_app -d "$POSTGRES_DB" -tAc "$1" 2>&1
}

# --- Миграции и seed -------------------------------------------------------
tables=$(psql_owner "select count(*) from information_schema.tables where table_schema='public'")
if [ "${tables:-0}" -ge 9 ] 2>/dev/null; then
  pass "миграции применены (таблиц: $tables)"
else
  fail "миграции не применены (ответ: $tables)"
fi

seeded=$(psql_owner "select count(*) from users")
if [ "${seeded:-0}" = "2" ]; then
  pass "seed-пользователи созданы"
else
  fail "ожидалось 2 seed-пользователя, получено: $seeded"
fi

# --- Неизменяемость журнала (ТЗ §11, незакрытый пункт DoD этапа 1) ---------
if psql_app "insert into audit_events (actor_type, action, object_type, result)
             values ('system','verify.probe','test','success')" >/dev/null 2>&1; then
  pass "роль приложения может писать в журнал"
else
  fail "роль приложения не может писать в журнал"
fi

if psql_app "update audit_events set result='tampered'" 2>&1 | grep -qi "denied\|отказано"; then
  pass "UPDATE по журналу отклонён"
else
  fail "UPDATE по журналу НЕ отклонён — защита не работает"
fi

if psql_app "delete from audit_events" 2>&1 | grep -qi "denied\|отказано"; then
  pass "DELETE по журналу отклонён"
else
  fail "DELETE по журналу НЕ отклонён — защита не работает"
fi

if psql_app "create table verify_probe (id int)" 2>&1 | grep -qi "denied\|отказано"; then
  pass "роль приложения не может менять схему"
else
  fail "роль приложения имеет права на DDL"
fi

# --- Персистентность тома PostgreSQL 18 ------------------------------------
if docker run --rm -v "${PROJECT}_postgres-data:/v" alpine \
     test -f /v/18/docker/PG_VERSION >/dev/null 2>&1; then
  pass "кластер лежит в именованном томе (переживёт docker compose down)"
else
  fail "именованный том пуст — данные в анонимном томе и пропадут при down"
fi

# --- Вход через веб-порт: проверяет rewrite в docker-сборке ----------------
login_code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIES" \
  -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${SEED_OPERATOR_LOGIN}\",\"password\":\"${SEED_OPERATOR_PASSWORD}\"}")
if [ "$login_code" = "200" ]; then
  pass "вход через веб-порт (rewrite на API работает)"
else
  fail "вход через веб-порт вернул $login_code"
  note "код 502/000 означает, что адрес API не попал в rewrite при сборке"
fi

if grep -q docflow_session "$COOKIES"; then
  pass "session-cookie установлена"
else
  fail "session-cookie не установлена"
  note "при COOKIE_SECURE=true и работе по HTTP браузер её отбросит"
fi

me=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/auth/me")
if printf '%s' "$me" | grep -q "\"login\":\"${SEED_OPERATOR_LOGIN}\""; then
  pass "сессия действительна (/auth/me)"
else
  fail "/auth/me вернул: $me"
fi

logged=$(psql_owner "select count(*) from audit_events where action='auth.login' and result='success'")
if [ "${logged:-0}" -ge 1 ] 2>/dev/null; then
  pass "вход записан в журнал"
else
  fail "вход не попал в журнал"
fi

# --- Сценарии, из-за которых был цикл редиректов ---------------------------
loop_code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-redirs 5 \
  -H 'Cookie: docflow_session=garbage' "http://localhost:${WEB_PORT}/inbox")
if [ "$loop_code" = "200" ]; then
  pass "недействительная cookie не зацикливает редиректы"
else
  fail "цикл редиректов при недействительной cookie (код: $loop_code)"
fi

logout_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Cookie: docflow_session=garbage' "http://localhost:${WEB_PORT}/api/auth/logout")
if [ "$logout_code" = "204" ]; then
  pass "выход работает с недействительной сессией"
else
  fail "выход с недействительной сессией вернул $logout_code"
fi

# --- Ограничение частоты попыток входа -------------------------------------
limit=$(( ${LOGIN_RATE_LIMIT:-10} + 2 ))
throttled=""
for _ in $(seq 1 "$limit"); do
  throttled=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"login\":\"${SEED_OPERATOR_LOGIN}\",\"password\":\"wrong\"}")
done
if [ "$throttled" = "429" ]; then
  pass "перебор пароля ограничивается (429)"
else
  fail "после $limit попыток ответ $throttled, ожидался 429"
fi

# --- Этап 2: приём документов ----------------------------------------------

# Разбор JSON через node: jq в системе может не быть.
json() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=$1;console.log(v==null?'':v)}catch{console.log('')}})"
}

# Повторный вход: предыдущие проверки исчерпали лимит попыток намеренно.
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
  pass "PDF принят, документ создан"
else
  fail "загрузка PDF не создала документ"
fi

if [ -n "$good_id" ]; then
  settled=$(await_settled "$good_id")
  status=$(printf '%s' "$settled" | json "o.status")
  thumb=$(printf '%s' "$settled" | json "o.hasThumbnail")
  pages=$(printf '%s' "$settled" | json "o.pageCount")

  # Корректный инвойс без blocking и с уверенными критичными полями проходит
  # автоматически (ТЗ 6.7).
  if [ "$status" = "approved" ]; then
    pass "корректный документ прошёл автоматически (статус $status)"
  else
    fail "ожидался статус approved, получен: $status"
  fi

  [ "$thumb" = "true" ] && pass "миниатюра сгенерирована" || fail "миниатюра не сгенерирована"
  [ "$pages" = "1" ] && pass "число страниц определено" || fail "число страниц: $pages"

  thumb_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' \
    "http://localhost:${WEB_PORT}/api/documents/${good_id}/thumbnail")
  case "$thumb_type" in
    image/png*) pass "миниатюра отдаётся как PNG" ;;
    *) fail "миниатюра отдана с типом: $thumb_type" ;;
  esac

  signed=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}/file" | json "o.url")
  if printf '%s' "$signed" | grep -q "X-Amz-Signature"; then
    pass "ссылка на оригинал подписана"
  else
    fail "ссылка на оригинал не подписана: $signed"
  fi

  # Этап 3: постраничный OCR-результат (mock-провайдер читает текстовый слой PDF).
  pages_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}/pages")
  page_count=$(printf '%s' "$pages_body" | json "o.length")
  [ "${page_count:-0}" -ge 1 ] 2>/dev/null && pass "страницы с OCR сохранены ($page_count)" \
    || fail "страницы не сохранены: $pages_body"

  page_text=$(printf '%s' "$pages_body" | json "o[0].text")
  case "$page_text" in
    *Invoice*) pass "текст страницы распознан" ;;
    *) fail "текст страницы не содержит ожидаемого: «$page_text»" ;;
  esac

  bbox_ok=$(printf '%s' "$pages_body" | json "o[0].blocks.length>0 && o[0].blocks.every(b=>b.bbox && b.bbox.x>=0 && b.bbox.x<=1 && b.bbox.y>=0 && b.bbox.y<=1)")
  [ "$bbox_ok" = "true" ] && pass "блоки с нормализованными координатами" \
    || fail "блоки отсутствуют или координаты вне 0..1"

  # Этап 4: классификация и извлечение с источниками (mock-LLM).
  doc_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${good_id}")
  doc_type=$(printf '%s' "$doc_body" | json "o.documentType")
  [ "$doc_type" = "invoice" ] && pass "документ классифицирован как invoice" \
    || fail "тип документа: $doc_type"

  fields_count=$(printf '%s' "$doc_body" | json "o.fields.length")
  [ "${fields_count:-0}" -ge 8 ] 2>/dev/null && pass "поля извлечены ($fields_count)" \
    || fail "полей извлечено: $fields_count"

  supplier=$(printf '%s' "$doc_body" | json "JSON.stringify(o.fields.find(f=>f.name==='supplier_name')?.normalizedValue)")
  [ "$supplier" = '"Acme GmbH"' ] && pass "supplier_name нормализован" \
    || fail "supplier_name: $supplier"

  total=$(printf '%s' "$doc_body" | json "o.fields.find(f=>f.name==='grand_total')?.normalizedValue")
  [ "$total" = "1440" ] && pass "grand_total приведён к числу" || fail "grand_total: $total"

  sourced=$(printf '%s' "$doc_body" | json "o.fields.filter(f=>f.sourceFound && f.sourceBbox && f.sourcePage===1).length")
  [ "${sourced:-0}" -ge 6 ] 2>/dev/null && pass "источники найдены (bbox у $sourced полей)" \
    || fail "полей с найденным источником: $sourced"

  missing_flag=$(printf '%s' "$doc_body" | json "o.fields.find(f=>f.name==='line_items')?.rawValue===null && o.fields.find(f=>f.name==='line_items')?.sourceFound===false")
  [ "$missing_flag" = "true" ] && pass "отсутствующее поле помечено как Missing" \
    || fail "line_items не помечено признаком отсутствия"

  clean_blocking=$(printf '%s' "$doc_body" | json "o.blockingIssues")
  [ "$clean_blocking" = "0" ] && pass "у корректного документа нет блокирующих ошибок" \
    || fail "блокирующих ошибок у корректного документа: $clean_blocking"
fi

# Этап 5: несходящаяся сумма — blocking, документ на проверке (ТЗ критерий 6).
mismatch_id=$(upload_document scripts/fixtures/invoice-sum-mismatch.pdf | json "o.id")
if [ -n "$mismatch_id" ]; then
  settled=$(await_settled "$mismatch_id")
  status=$(printf '%s' "$settled" | json "o.status")
  [ "$status" = "needs_review" ] && pass "документ с расхождением сумм отправлен на проверку" \
    || fail "ожидался needs_review, получен: $status"

  sum_issue=$(printf '%s' "$settled" | json "JSON.stringify(o.issues.find(i=>i.ruleId==='invoice_totals_match')||null)")
  if printf '%s' "$sum_issue" | grep -q '"severity":"blocking"'; then
    pass "расхождение сумм даёт blocking-ошибку"
    note "$(printf '%s' "$settled" | json "o.issues.find(i=>i.ruleId==='invoice_totals_match').message")"
  else
    fail "blocking-ошибка по суммам не найдена: $sum_issue"
  fi

  expected_actual=$(printf '%s' "$settled" | json "o.issues.find(i=>i.ruleId==='invoice_totals_match')?.expected==='1440.00' && o.issues.find(i=>i.ruleId==='invoice_totals_match')?.actual==='1400.00'")
  [ "$expected_actual" = "true" ] && pass "ошибка содержит ожидаемое и фактическое значение" \
    || fail "expected/actual в ошибке заполнены неверно"
fi


# Этап 6: операции Review Workspace.
if [ -n "$mismatch_id" ]; then
  # Рендер страницы для просмотрщика.
  page_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' \
    "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/pages/1/image?width=800")
  case "$page_type" in
    image/png*) pass "страница отдаётся просмотрщику как PNG" ;;
    *) fail "рендер страницы вернул тип: $page_type" ;;
  esac

  # Approve при нерешённой blocking-ошибке невозможен (ТЗ §9, критерий 6).
  approve_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/approve")
  [ "$approve_code" = "409" ] && pass "подтверждение заблокировано blocking-ошибкой (409)" \
    || fail "approve при blocking вернул $approve_code вместо 409"

  can_approve=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}" | json "o.canApprove")
  [ "$can_approve" = "false" ] && pass "canApprove=false при blocking-ошибке" \
    || fail "canApprove=$can_approve при наличии blocking"

  # Правка поля синхронно перевалидирует документ (ТЗ 5.2, критерий 8).
  patched=$(curl -s -b "$COOKIES" -X PATCH \
    "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/fields/grand_total" \
    -H 'Content-Type: application/json' -d '{"value":"1440.00"}')
  patched_blocking=$(printf '%s' "$patched" | json "o.blockingIssues")
  [ "$patched_blocking" = "0" ] && pass "правка поля устранила blocking в том же ответе" \
    || fail "после правки blockingIssues=$patched_blocking"

  patched_edited=$(printf '%s' "$patched" | json "o.fields.find(f=>f.name==='grand_total')?.isEdited")
  [ "$patched_edited" = "true" ] && pass "поле помечено как исправленное оператором" \
    || fail "isEdited=$patched_edited после правки"

  patched_can=$(printf '%s' "$patched" | json "o.canApprove")
  [ "$patched_can" = "true" ] && pass "доступность Approve обновлена в ответе на правку" \
    || fail "canApprove=$patched_can после устранения ошибки"

  # Правка не подтверждает документ за оператора.
  patched_status=$(printf '%s' "$patched" | json "o.status")
  [ "$patched_status" = "needs_review" ] && pass "правка не подтверждает документ автоматически" \
    || fail "после правки статус $patched_status, ожидался needs_review"

  audit_pair=$(psql_owner "select count(*) from audit_events where action='field.edited' and object_type='field' and before is not null and after is not null")
  [ "${audit_pair:-0}" -ge 1 ] 2>/dev/null && pass "правка записана в журнал как before/after" \
    || fail "правка не попала в журнал"

  approve_ok=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/approve")
  [ "$approve_ok" = "201" ] || [ "$approve_ok" = "200" ] \
    && pass "документ подтверждён после устранения ошибки" \
    || fail "approve вернул $approve_ok"
fi

# Этап 7: экспорт подтверждённого документа (ТЗ 6.8, критерии 10 и 11).
if [ -n "$mismatch_id" ]; then
  export_1=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"file_json"}')
  exp_status=$(printf '%s' "$export_1" | json "o.status")
  exp_id=$(printf '%s' "$export_1" | json "o.id")
  exp_ref=$(printf '%s' "$export_1" | json "o.payloadRef")
  if [ "$exp_status" = "succeeded" ] && [ -n "$exp_ref" ]; then
    pass "документ выгружен в JSON ($exp_ref)"
  else
    fail "экспорт: статус $exp_status, payloadRef «$exp_ref»"
  fi

  doc_after=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}" | json "o.status")
  [ "$doc_after" = "exported" ] && pass "статус документа стал exported" \
    || fail "после экспорта статус $doc_after"

  # Повторный запрос с тем же ключом не создаёт второй объект (критерий 10).
  export_2=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"file_json"}')
  exp_id_2=$(printf '%s' "$export_2" | json "o.id")
  [ "$exp_id" = "$exp_id_2" ] && pass "повторный экспорт вернул ту же запись" \
    || fail "повторный экспорт создал другую запись: $exp_id vs $exp_id_2"

  export_rows=$(psql_owner "select count(*) from exports where document_id='${mismatch_id}'")
  [ "$export_rows" = "1" ] && pass "в базе ровно одна запись экспорта" \
    || fail "записей экспорта: $export_rows"

  # Недоступное назначение: документ остаётся выгруженным, экспорт — failed,
  # повтор доступен (критерий 11). Google Sheets без ключа не настроен.
  bad_dest=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${mismatch_id}/export" \
    -H 'Content-Type: application/json' -d '{"destination":"google_sheets"}')
  [ "$bad_dest" = "400" ] && pass "ненастроенное назначение отклонено с понятным кодом" \
    || fail "экспорт в ненастроенный Sheets вернул $bad_dest"
fi

# Отклонение с причиной из списка (ТЗ 5.2).
reject_id=$(upload_document scripts/fixtures/sample-invoice.pdf | json "o.id")
if [ -n "$reject_id" ]; then
  await_settled "$reject_id" >/dev/null
  rejected=$(curl -s -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents/${reject_id}/reject" \
    -H 'Content-Type: application/json' \
    -d '{"reason":"poor_scan_quality","comment":"проверка"}')
  rej_status=$(printf '%s' "$rejected" | json "o.status")
  rej_reason=$(printf '%s' "$rejected" | json "o.statusReason")
  if [ "$rej_status" = "rejected" ] && [ -n "$rej_reason" ]; then
    pass "документ отклонён с указанием причины"
    note "$rej_reason"
  else
    fail "отклонение: статус $rej_status, причина «$rej_reason»"
  fi
fi

# Схемы и пороги (ТЗ 6.7, §8; критерий приёмки 13 — права администратора).
schemas_count=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/schemas" | json "o.length")
[ "$schemas_count" = "4" ] && pass "схемы четырёх типов доступны" || fail "схем: $schemas_count"

thresholds_body='{"autoClassify":0.7,"criticalFieldConfidence":0.8,"fieldConfidence":0.6}'
operator_put=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
  -X PUT "http://localhost:${WEB_PORT}/api/schemas/invoice/thresholds" \
  -H 'Content-Type: application/json' -d "$thresholds_body")
[ "$operator_put" = "403" ] && pass "оператору настройка порогов запрещена (403)" \
  || fail "оператор получил $operator_put вместо 403"

ADMIN_COOKIES="$(mktemp)"
curl -s -o /dev/null -c "$ADMIN_COOKIES" -X POST "http://localhost:${WEB_PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${SEED_ADMIN_LOGIN}\",\"password\":\"${SEED_ADMIN_PASSWORD}\"}"
admin_version=$(curl -s -b "$ADMIN_COOKIES" \
  -X PUT "http://localhost:${WEB_PORT}/api/schemas/invoice/thresholds" \
  -H 'Content-Type: application/json' -d "$thresholds_body" | json "o.version")
rm -f "$ADMIN_COOKIES"
if [ -n "$admin_version" ] && [ "$admin_version" -ge 2 ] 2>/dev/null; then
  pass "администратор обновил пороги (новая версия $admin_version)"
else
  fail "обновление порогов администратором: version=$admin_version"
fi

# Повреждённый файл: отклонение с причиной, до вызова LLM (ТЗ §9, §10).
bad_id=$(upload_document scripts/fixtures/corrupted.pdf | json "o.id")
if [ -n "$bad_id" ]; then
  settled=$(await_settled "$bad_id")
  status=$(printf '%s' "$settled" | json "o.status")
  reason=$(printf '%s' "$settled" | json "o.statusReason")
  if [ "$status" = "rejected" ] && [ -n "$reason" ]; then
    pass "повреждённый файл отклонён с причиной"
    note "$reason"
  else
    fail "повреждённый файл: статус $status, причина «$reason»"
  fi
else
  fail "повреждённый файл не был принят на загрузку"
fi

# Неподдерживаемый тип отсекается до записи в хранилище.
txt_code=$(printf 'просто текст' > /tmp/docflow-verify.txt && curl -s -o /dev/null -w '%{http_code}' \
  -b "$COOKIES" -X POST "http://localhost:${WEB_PORT}/api/documents" -F 'file=@/tmp/docflow-verify.txt')
rm -f /tmp/docflow-verify.txt
[ "$txt_code" = "400" ] && pass "неподдерживаемый тип отклонён" || fail "текстовый файл принят с кодом $txt_code"

# Дубликат по checksum связывается с оригиналом (ТЗ §10).
dup_id=$(upload_document scripts/fixtures/sample-invoice.pdf | json "o.id")
if [ -n "$dup_id" ]; then
  dup_of=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${dup_id}" | json "o.duplicateOfId")
  [ -n "$dup_of" ] && pass "дубликат связан с оригиналом" || fail "дубликат не связан с оригиналом"

  # Единственная разрешённая cross-document проверка (ТЗ §9): тот же номер
  # инвойса у того же поставщика.
  dup_settled=$(await_settled "$dup_id")
  unique_issue=$(printf '%s' "$dup_settled" | json "o.issues.some(i=>i.ruleId==='invoice_number_unique' && i.severity==='blocking')")
  [ "$unique_issue" = "true" ] && pass "повтор номера инвойса даёт blocking-ошибку" \
    || fail "уникальность invoice_number не проверена"

  # Дубликат остаётся неподтверждённым, поэтому на нём же проверяется запрет
  # экспорта до подтверждения (ТЗ §9).
  early=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
    -X POST "http://localhost:${WEB_PORT}/api/documents/${dup_id}/export" \
    -H 'Content-Type: application/json' -d '{}')
  [ "$early" = "400" ] && pass "неподтверждённый документ не экспортируется" \
    || fail "экспорт неподтверждённого вернул $early"
fi

# Фильтры очереди.
filtered=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents?status=rejected" | json "o.items.every(i=>i.status==='rejected')")
[ "$filtered" = "true" ] && pass "фильтр по статусу работает" || fail "фильтр по статусу вернул посторонние записи"

# --- Этап 9: журнал выполнения, DLQ, второй источник, версии, retention ----

runs_body=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?page=1")
runs_total=$(printf '%s' "$runs_body" | json "o.total")
[ "${runs_total:-0}" -ge 5 ] 2>/dev/null && pass "журнал выполнения заполнен ($runs_total записей)" \
  || fail "записей в журнале: $runs_total"

runs_shape=$(printf '%s' "$runs_body" | json "o.items.every(r=>r.correlationId && r.step && r.state) && o.items.some(r=>r.step==='ingestion') && o.items.some(r=>r.durationMs!==null)")
[ "$runs_shape" = "true" ] && pass "запись журнала содержит этап, попытки, длительность и correlation_id" \
  || fail "структура записи журнала неполная"

errors_only=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?onlyErrors=true" \
  | json "o.items.every(r=>r.state==='failed')")
[ "$errors_only" = "true" ] && pass "фильтр «только ошибки» работает" \
  || fail "фильтр «только ошибки» вернул посторонние записи"

step_filter=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?step=ocr" \
  | json "o.items.every(r=>r.step==='ocr')")
[ "$step_filter" = "true" ] && pass "фильтр по этапу работает" || fail "фильтр по этапу неточен"

# Повреждённый файл — постоянный дефект: повторять его бессмысленно, поэтому
# в DLQ он не попадает (ТЗ 6.10).
if [ -n "$bad_id" ]; then
  dl_permanent=$(psql_owner "select count(*) from dead_letters where document_id='${bad_id}'")
  [ "${dl_permanent:-1}" = "0" ] && pass "постоянный дефект файла в DLQ не попадает" \
    || fail "повреждённый файл создал записей в DLQ: $dl_permanent"
fi

# Транзиентный отказ: объект удаляется из хранилища, повтор обработки исчерпывает
# попытки, задача уходит в DLQ и повторяется вручную из Execution Log.
if [ -n "$reject_id" ]; then
  storage_key=$(psql_owner "select storage_key from documents where id='${reject_id}'")
  mc_setup=$(docker compose exec -T minio sh -c \
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
      pass "исчерпавшая попытки задача попала в DLQ"
    else
      fail "задача не попала в DLQ после исчерпания попыток"
    fi

    dl_detail=$(psql_owner "select (payload is not null and error_message <> '' and stack is not null) from dead_letters where document_id='${reject_id}' limit 1")
    [ "$dl_detail" = "t" ] && pass "в DLQ сохранены вход задачи, текст ошибки и стек" \
      || fail "запись DLQ неполная (payload/error/stack)"

    failed_run=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/runs?onlyErrors=true" \
      | json "o.items.find(r=>r.documentId==='${reject_id}' && r.deadLetter)?.id")
    if [ -n "$failed_run" ]; then
      pass "упавший этап виден в Execution Log вместе с записью DLQ"
    else
      fail "упавший этап не найден в Execution Log"
    fi

    # Файл возвращается на место, чтобы повтор мог завершиться успешно.
    docker compose exec -T minio sh -c \
      "mc cp /tmp/original.bin probe/${MINIO_BUCKET}/${storage_key} >/dev/null 2>&1" >/dev/null 2>&1

    if [ -n "$failed_run" ]; then
      retry_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" \
        -X POST "http://localhost:${WEB_PORT}/api/runs/${failed_run}/retry")
      case "$retry_code" in
        200 | 201) pass "повтор этапа из Execution Log принят" ;;
        *) fail "повтор этапа вернул $retry_code" ;;
      esac

      retried=$(psql_owner "select count(*) from dead_letters where document_id='${reject_id}' and retried_at is not null")
      [ "${retried:-0}" -ge 1 ] 2>/dev/null && pass "запись DLQ помечена повторённой" \
        || fail "запись DLQ не помечена повторённой"

      await_settled "$reject_id" >/dev/null
      after_retry=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${reject_id}" | json "o.status")
      [ "$after_retry" != "failed" ] && pass "после повтора документ обработан (статус $after_retry)" \
        || fail "после повтора документ остался в статусе failed"
    fi
  else
    fail "не удалось подготовить проверку DLQ через mc"
  fi
fi

# Второй источник: наблюдаемая папка. Первый прогон синхронизации выполняется
# при старте воркера, поэтому проверка перезапускает его вместо ожидания
# интервала.
SOURCE_DIR="docker/source-inbox"
resync() { docker compose restart worker >/dev/null 2>&1; sleep 6; }

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
    pass "файл из папки-источника принят"
    await_settled "$synced_id" >/dev/null

    # Дубликаты ищутся по всем источникам: тот же файл уже загружался вручную.
    cross_dup=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents/${synced_id}" | json "o.duplicateOfId")
    [ -n "$cross_dup" ] && pass "дубликат распознан между источниками" \
      || fail "дубликат из другого источника не связан с оригиналом"
  else
    fail "файл из папки-источника не принят"
  fi

  # Повторная синхронизация без изменений не создаёт второй документ.
  resync
  same_count=$(drive_docs | json "o.total")
  [ "$same_count" = "1" ] && pass "повторная синхронизация не дублирует документ" \
    || fail "после повторной синхронизации документов из источника: $same_count"

  # Изменившийся файл по тому же пути даёт новую версию (ТЗ 6.9).
  cp scripts/fixtures/invoice-sum-mismatch.pdf "${SOURCE_DIR}/synced.pdf"
  resync
  sleep 4
  versions=$(drive_docs | json "o.total")
  v2_active=$(drive_docs | json "o.items.some(i=>i.versionNumber===2 && i.isActive)")
  v1_inactive=$(drive_docs | json "o.items.some(i=>i.versionNumber===1 && !i.isActive)")
  [ "$versions" = "2" ] && pass "изменение файла создало новую версию" \
    || fail "версий документа из источника: $versions"
  [ "$v2_active" = "true" ] && pass "актуальной считается последняя версия" \
    || fail "вторая версия не активна"
  [ "$v1_inactive" = "true" ] && pass "прежняя версия сохранена и неактуальна" \
    || fail "первая версия не помечена неактуальной"

  # Удаление в источнике помечает документ неактивным, но не удаляет его.
  rm -f "${SOURCE_DIR}/synced.pdf"
  resync
  sleep 2
  all_inactive=$(drive_docs | json "o.items.every(i=>!i.isActive) && o.total===2")
  [ "$all_inactive" = "true" ] && pass "удаление в источнике помечает документ неактивным" \
    || fail "после удаления в источнике документы остались активными"

  deact_audit=$(psql_owner "select count(*) from audit_events where action='document.deactivated'")
  [ "${deact_audit:-0}" -ge 1 ] 2>/dev/null && pass "удаление в источнике записано в журнал" \
    || fail "удаление в источнике не попало в журнал"

  # Retention: срок отсчитывается от потери актуальности, поэтому проверка
  # отодвигает дату назад и запускает уборку перезапуском воркера.
  purge_id=$(psql_owner "select id from documents where source_type='drive' and version_number=1 limit 1")
  psql_owner "update documents set deactivated_at = now() - interval '400 days' where id='${purge_id}'" >/dev/null
  resync
  sleep 3
  purged=$(psql_owner "select count(*) from documents where id='${purge_id}'")
  [ "$purged" = "0" ] && pass "просроченный документ удалён физически по retention" \
    || fail "документ с истёкшим retention остался в базе"

  purge_audit=$(psql_owner "select count(*) from audit_events where action='document.purged' and object_id='${purge_id}'")
  [ "${purge_audit:-0}" -ge 1 ] 2>/dev/null && pass "физическое удаление записано в журнал" \
    || fail "физическое удаление не попало в журнал"
else
  note "второй источник отключён (SOURCE_PROVIDER=${SOURCE_PROVIDER:-none}) — проверки пропущены"
fi

# Поток событий для живого обновления очереди.
sse_type=$(curl -s -b "$COOKIES" -o /dev/null -w '%{content_type}' --max-time 3 \
  "http://localhost:${WEB_PORT}/api/events/stream")
case "$sse_type" in
  text/event-stream*) pass "поток событий SSE отвечает" ;;
  *) fail "поток событий вернул тип: $sse_type" ;;
esac

# --- Итог ------------------------------------------------------------------
psql_owner "delete from audit_events where action='verify.probe'" >/dev/null 2>&1

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mВсе проверки пройдены.\033[0m\n'
else
  printf '\033[31mЕсть непройденные проверки — см. отметки выше.\033[0m\n'
fi
printf 'Веб-приложение: http://localhost:%s   Остановить: docker compose down\n' "$WEB_PORT"
exit "$FAILED"
