# Docflow Hub

An operator console for document ingest, OCR, classification, extraction, validation, review, and export.

## Quick start

Requirements: Node.js 24+, Docker, and Docker Compose v2+. Native worker execution also needs qpdf (`brew install qpdf` or `apt-get install qpdf`).

```bash
cp example.env .env
npm ci
npm run dataset
docker compose up -d --build --wait
```

Open `http://localhost:3000` and sign in with the seeded credentials from `.env`.

## Main workflows

- Upload PDF, JPEG, or PNG files, or synchronize a watched folder/Google Drive.
- Run preprocessing, OCR, classification, field extraction, and validation in BullMQ workers.
- Review low-confidence or invalid fields alongside highlighted source areas.
- Approve, reject, reprocess, replace, and export documents.
- Inspect stage duration, attempts, errors, dead-letter entries, and manual retries.

## Commands

```bash
npm run dev:api   # local API; worker and web have separate dev:* commands
npm run build     # build all workspaces
npm test          # unit tests; set TEST_DATABASE_URL for disposable DB tests
npm run eval      # evaluate the labeled dataset
npm run verify    # explicit disposable-stack checks; see runbook
npm run screenshots
```

Compose migrates and seeds the database before starting API and worker. Set passwords, JWT_SECRET and browser ports in `.env` before startup. Use `docker-compose` if your installation provides the standalone command.

Verification, evaluation, screenshots and video use an explicitly configured disposable stack; see the [runbook](docs/runbook.md).

## Documentation

- [In-app test flow (Russian)](docs/basic-flow.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Runbook](docs/runbook.md)
- [Known limitations](known-limitations.md)
- [Design system](design.md)
- [Evaluation report](evaluation/last-run.md)
- [Demonstration video](docs/demo.webm)

The external technical specification remains the requirements source. The interface is in English; a Russian user walkthrough is linked above. Generated demo documents are synthetic and contain no real personal data.
