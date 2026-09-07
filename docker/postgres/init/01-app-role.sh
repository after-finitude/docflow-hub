#!/bin/sh
#
#
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v app_password="$APP_DB_PASSWORD" <<-'EOSQL'
    SELECT format('CREATE ROLE docflow_app LOGIN PASSWORD %L', :'app_password')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docflow_app') \gexec
    SELECT format('GRANT CONNECT ON DATABASE %I TO docflow_app', current_database()) \gexec
EOSQL
