# Demo VPS

The demo runs at https://docflow.176.98.40.150.sslip.io on `176.98.40.150`.
Server directory: `/opt/docflow-hub`; SSH: `root` with the owner's existing key.
Login details are in the owner's local `secrets/vps-access.txt` and the server's
`/root/docflow-demo-access.txt`, both mode 0600. Give clients the operator login;
keep the administrator login private. All operators share the same document pool.

The 2 GB VPS uses 2 GB swap. Queue concurrency is 1 per stage. Runtime memory
limits and restart policies are in `docker/compose.vps.yml`; Docker rotates its
local logs at 10 MB, keeping three files per container. Prefer building elsewhere;
the initial deployment used sequential on-server builds with swap because SSH
image transfer from the owner's connection was too slow.
Only SSH and Caddy's HTTP/HTTPS ports are public. PostgreSQL and Redis have no
host ports; API, web and MinIO diagnostic ports bind to loopback only.

Caddy obtains and renews HTTPS certificates. The bucket name must stay `docflow`:
`/docflow/*` GET/HEAD requests go to MinIO with the original Host and path for S3
signatures; all other requests go to the web app. MinIO's console and management
API are not exposed by this proxy. To use an owned domain, point its A record at
the VPS, change `DEMO_HOST` and `MINIO_PUBLIC_URL` in the server `.env`, and recreate
Caddy, API and worker. The current hostname depends on the third-party sslip.io
DNS service.

OCR, classification and extraction use `dots-studio/dots-3-note-preview:free`
through OpenRouter, with explicit owner consent to send document text/images to
external providers. The model is pinned because
`openrouter/free` selected providers that returned HTTP 400 or exhausted the
output token budget during the demo checks.
`LLM_REASONING_EFFORT=none` disables optional reasoning for both stages so it does
not consume the limited output budget before the document JSON is returned.
`LLM_RESPONSE_FORMAT=json_schema` supplies the response contract for classification
and extraction. OpenRouter must route to an endpoint supporting the requested
parameters; local validation and repair remain mandatory.
No paid model fallback is configured. Free endpoints have variable availability
and rate limits. OpenRouter [plans to remove this free model on September 30, 2026](https://openrouter.ai/dots-studio/dots-3-note-preview:free);
replace `OCR_MODEL` and `LLM_MODEL` before then and recreate API and worker.
Native PDF text is read locally when possible.
Folder ingestion is disabled (`SOURCE_PROVIDER=none`).

September 12 smoke check: a synthetic native PDF produced all nine fields and
was approved; a synthetic PNG produced seven fields and required review. The
model inferred an unprinted subtotal on that PNG, so successful processing does
not establish extraction accuracy. Keep manual review for scans. OpenRouter key
usage remained $0 after the checks. Build and 16 focused offline tests passed.

The worker reads `secrets/worker/llm.enc`; its separate decryption key is stored
at `/etc/docflow/worker-key/integration.key`, mounted read-only. The API and web
do not receive the OpenRouter credential. See `configuration.md` for rotation.

## GitHub autodeploy

`.github/workflows/deploy.yml` deploys pushes to `main` in
`after-finitude/docflow-hub`. Manual runs are also limited to `main`.
The job sends only approved committed application source over SSH; the VPS builds
backend and web sequentially, tags both images with the commit SHA, applies
migrations and starts the services. Concurrent deploys across Docflow and Leadloom are serialized by a shared server lock. The server
keeps `.env`, `secrets/`, the source inbox and named volumes.

One-time setup requires GitHub Actions, Python 3, `rsync`, `runuser`, `prlimit`, `timeout` and `flock` on the VPS, and a dedicated SSH key for this project. Create a system user/group `docflow-unpack` with `/usr/sbin/nologin`, no home and no supplementary groups; create root-owned `/var/lib/app-deploy` with mode 0711. Install `scripts/extract-release.py` as `/usr/local/lib/docflow-deploy/extract-release.py` (root-owned directory 0755, file 0644). Keep the app directory and its Compose, Dockerfiles, Caddy and initialization files root-owned and not writable by other users. Install `docker/deploy.sh` as
`/usr/local/sbin/docflow-deploy` (root-owned, mode 0700) and add the public key to
`/root/.ssh/authorized_keys` with this prefix:

```text
restrict,command="/usr/local/sbin/docflow-deploy" ssh-ed25519 PUBLIC_KEY docflow-deploy
```

Set the repository Actions secret `DEPLOY_SSH_KEY` to the dedicated private key.
The workflow pins the VPS host key obtained through the existing trusted SSH
connection; it does not discover and trust a new key during each pipeline run.
OpenRouter and application credentials stay on the VPS. After a successful job,
the server `.env` records `IMAGE_TAG=<commit SHA>`. A failed build exits before
container replacement. A migration/startup failure needs investigation in the
job log; automatic database rollback is not provided. Builds briefly share the
small VPS with the app.

Changes to Compose, Dockerfiles, Caddy, the receiver or the forced command require an administrator to review and install them separately; pushing their repository sources cannot change privileged server configuration. Keep the server Caddyfile's Leadloom site block. The receiver's source allowlist and limits are described in [the runbook](runbook.md#production-deployment-script).

The workflow replaces the previous server target. Only the dedicated deploy key
belongs in Actions; the owner's personal SSH key is not copied there.

## Manual recovery

Build with the existing Dockerfiles on a machine with an amd64-capable builder:

```bash
docker build --platform linux/amd64 --build-arg APP=api -f docker/node.Dockerfile -t docflow-backend:TAG .
docker build --platform linux/amd64 --build-arg API_INTERNAL_URL=http://api:3001 -f docker/web.Dockerfile -t docflow-web:TAG .
set -o pipefail
docker save docflow-backend:TAG docflow-web:TAG | gzip -1 | ssh root@176.98.40.150 'gzip -d | docker load'
```

Replace `TAG` with the release identifier. Transfer the root Compose file,
`docker/compose.vps.yml`, `docker/Caddyfile` and `docker/postgres/init/` when they
change. Preserve the server `.env`, `secrets/` and all named volumes. Then set
`IMAGE_TAG` in the server `.env` and run from `/opt/docflow-hub`:

```bash
docker compose config -q
docker compose up -d --no-build --pull never --wait --wait-timeout 180
docker compose ps
curl -fsS https://docflow.176.98.40.150.sslip.io/api/health
```

The server `.env` sets `COMPOSE_FILE=docker-compose.yml:docker/compose.vps.yml`.
Pull PostgreSQL, Redis, MinIO or Caddy explicitly before an infrastructure update.
Normal updates use the GitHub workflow above; manual image transfer is for recovery.

MinIO uses the official Quay image pinned by digest (release
`RELEASE.2025-09-07T16-13-09Z`), without a custom build. This predates the
[October 2025 service-account/STS policy fix](https://github.com/minio/minio/security/advisories/GHSA-jjjj-jwhf-8rgr).
Do not issue MinIO credentials to demo users or enable restricted service/STS
accounts on this image; only the trusted backend holds storage credentials.
Use an updated distribution before expanding that access model.

Named volumes survive container restarts; they are not an off-server backup.
Do not store the only copy of important client documents on this demo VPS.
