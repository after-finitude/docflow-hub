#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?Set the disposable PostgreSQL administrator URL}"
: "${TEST_APP_DB_PASSWORD:?Set the disposable docflow_app password}"
: "${EVAL_BASE_URL:?Set the disposable API URL}"
: "${EVAL_WEB_URL:?Set the disposable web URL}"
: "${EVAL_LOGIN:?Set the test administrator login}"
: "${EVAL_PASSWORD:?Set the test administrator password}"
: "${EVAL_OPERATOR_PASSWORD:?Set the test operator password}"
[ "${EVAL_DISPOSABLE:-}" = 1 ] || { echo 'Set EVAL_DISPOSABLE=1 for an isolated test stack'; exit 1; }
npm test
npm run lint
npx prettier --check .
API_INTERNAL_URL="$EVAL_BASE_URL" npm run build -w @docflow/web
node scripts/security-live.mjs
