#!/bin/sh
# Создаёт роль приложения при инициализации кластера.
#
# Имя роли зафиксировано: то же значение в миграции 0001_audit_immutability.sql
# и в DATABASE_URL. Настраивается только пароль.
#
# Права на таблицы выдаёт миграция — на этот момент таблиц ещё нет.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docflow_app') THEN
            CREATE ROLE docflow_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO docflow_app;
EOSQL
