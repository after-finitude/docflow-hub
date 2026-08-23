# Docflow Hub

An operator console for document ingest, OCR, classification, extraction, validation, review, and export.

## Quick start

Requirements: Node.js 22+, Docker, and Docker Compose.

```bash
cp example.env .env
npm ci
npm run fixtures
docker compose up -d --build --wait
npm run verify
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
npm run dev       # local development
npm run build     # build all workspaces
npm test          # unit tests
npm run eval      # evaluate the labeled dataset
npm run verify    # static checks and end-to-end verification
npm run screenshots
```

`npm run verify` needs a running Docker daemon. On macOS with Colima, run `colima start` first.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Runbook](docs/runbook.md)
- [Known limitations](known-limitations.md)
- [Design system](design.md)
- [Evaluation report](evaluation/last-run.md)

The external technical specification remains the requirements source. This repository is English-only; generated demo documents are synthetic and contain no real personal data.
