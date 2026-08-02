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
