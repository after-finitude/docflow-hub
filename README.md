# Docflow Hub

AI Document Operations Hub: приём документов, OCR, извлечение полей по схеме,
проверка данных, ручная верификация и экспорт.

| Документ                                                | О чём                                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)             | Компоненты и последовательность обработки        |
| [docs/configuration.md](docs/configuration.md)           | Переменные окружения, схемы типов, пороги        |
| [docs/runbook.md](docs/runbook.md)                       | Запуск, остановка, повтор задачи, восстановление |
| [docs/screenshots](docs/screenshots/README.md)           | Экраны системы                                   |
| [evaluation/last-run.md](evaluation/last-run.md)         | Отчёт о качестве                                 |
| [known-limitations.md](known-limitations.md)             | Что является mock, sandbox или ограничением      |
| [PLAN.md](PLAN.md)                                       | План разработки и решения по этапам              |

## Состояние

Реализованы все девять этапов плана: приём документов, OCR, классификация,
извлечение полей с привязкой к области-источнику, валидация и маршрутизация,
Review Workspace, канонический JSON и экспорт, демо-набор с оценкой качества,
второй источник с версиями и Execution Log.

Проверка живого стека — `npm run verify` (84 проверки). Из состава поставки
ТЗ §16 не сделано только демонстрационное видео.

## Запуск

```bash
cp example.env .env
```

Заполните в `.env` пароли и `JWT_SECRET` (не короче 32 символов), затем:

```bash
docker compose up --build
```

Поднимутся PostgreSQL 18, Redis, MinIO, одноразовый контейнер миграций,
API, воркеры и веб-приложение. Веб — на `http://localhost:3000`,
вход под seed-пользователями из `.env` (`operator` / `admin`).

Строки подключения к БД не задаются напрямую: они собираются из
`POSTGRES_*` и `APP_DB_PASSWORD`, чтобы пароль не жил в двух местах.
Порты `API_HOST_PORT` и `WEB_HOST_PORT` управляют публикацией на хост;
порты внутри контейнеров зафиксированы.

При развёртывании за TLS обязательно `COOKIE_SECURE=true`. Обратное тоже
важно: при `true` и работе по обычному HTTP браузер отбросит session-cookie,
и вход будет молча не срабатывать.

## Разработка без Docker

Нужны запущенные PostgreSQL, Redis и MinIO; в `.env` указать
`POSTGRES_HOST=localhost` и аналогично для Redis и MinIO.

```bash
npm install
npm run build
npm run db:migrate && npm run db:seed
```

Дальше три процесса:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

## Структура

| Путь              | Назначение                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `apps/web`        | Next.js 16: Document Inbox, Review Workspace                       |
| `apps/api`        | NestJS: HTTP API, аутентификация, постановка задач в очереди        |
| `apps/worker`     | NestJS standalone: обработчики очередей pipeline, отдельный контейнер |
| `packages/core`   | Инфраструктура backend: конфигурация, схема БД, хранилище, очереди   |
| `packages/shared` | Чистый код для всех приложений: типы, контракты, доменные константы  |

## Команды

| Команда              | Действие                                    |
| -------------------- | ------------------------------------------- |
| `npm run build`      | Сборка всех TypeScript-проектов              |
| `npm run typecheck`  | Проверка типов                               |
| `npm run lint`       | Линтер (oxlint)                              |
| `npm run format`     | Форматирование (Prettier)                    |
| `npm run db:generate`| Генерация миграции из схемы Drizzle          |
| `npm run db:migrate` | Применение миграций                          |
| `npm run db:seed`    | Создание seed-пользователей                  |
| `npm test`           | Юнит-тесты (node:test)                       |
| `npm run verify`     | Полная проверка: статика и живой стек        |
| `npm run dataset`    | Пересборка демо-набора документов            |
| `npm run eval`       | Отчёт о качестве в `evaluation/last-run.md`  |
| `npm run screenshots`| Съёмка экранов в `docs/screenshots`          |
