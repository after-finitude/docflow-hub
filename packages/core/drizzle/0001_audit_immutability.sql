-- Права роли приложения (ТЗ §11).
--
-- Приложение работает под ролью docflow_app, у которой нет UPDATE и DELETE
-- на audit_events: журнал доступен только на добавление и чтение. DDL и
-- миграции выполняются под ролью-владельцем, у приложения прав на них нет.
--
-- Имя роли зафиксировано: то же значение в docker/postgres/init/01-app-role.sh
-- и в DATABASE_URL.

GRANT USAGE ON SCHEMA public TO docflow_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO docflow_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO docflow_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM docflow_app;--> statement-breakpoint
-- Таблицы следующих миграций создаёт владелец: права на них выдаются
-- автоматически, отзыв по audit_events уже зафиксирован выше.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docflow_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO docflow_app;
