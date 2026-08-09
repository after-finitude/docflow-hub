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
fi

# Фильтры очереди.
filtered=$(curl -s -b "$COOKIES" "http://localhost:${WEB_PORT}/api/documents?status=rejected" | json "o.items.every(i=>i.status==='rejected')")
[ "$filtered" = "true" ] && pass "фильтр по статусу работает" || fail "фильтр по статусу вернул посторонние записи"

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
