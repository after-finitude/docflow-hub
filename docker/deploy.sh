#!/bin/sh
set -eu
umask 077

app_dir=/opt/docflow-hub
lock_file=/opt/docflow-hub.deploy.lock
revision=${SSH_ORIGINAL_COMMAND:-}
case "$revision" in
  ''|*[!0-9a-f]*) echo 'Expected a Git commit SHA.' >&2; exit 1 ;;
esac
test "${#revision}" -eq 40 || { echo 'Expected a full Git commit SHA.' >&2; exit 1; }
staging_dir=$(mktemp -d /opt/docflow-hub.deploy.XXXXXX)
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM

exec 9>"$lock_file"
flock -n 9 || { echo 'A Docflow Hub deployment is already running.' >&2; exit 1; }

tar -xzf - -C "$staging_dir"
test -f "$staging_dir/docker-compose.yml"
test -f "$staging_dir/docker/compose.vps.yml"

# ponytail: in-place deploy; add release directories and rollback if zero-downtime deploys matter.
rsync -a --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='/secrets/' \
  --exclude='docker-compose.override.yml' \
  --exclude='docker/source-inbox/' \
  "$staging_dir/" "$app_dir/"

cd "$app_dir"
export COMPOSE_FILE=docker-compose.yml:docker/compose.vps.yml
export IMAGE_TAG="$revision"
docker compose config -q
# Build sequentially to fit the 2 GB VPS; running containers keep their images.
docker build --build-arg APP=api -f docker/node.Dockerfile -t "docflow-backend:$IMAGE_TAG" .
docker build --build-arg API_INTERNAL_URL=http://api:3001 -f docker/web.Dockerfile -t "docflow-web:$IMAGE_TAG" .
docker compose up -d --no-build --pull never --wait --wait-timeout 180
curl -fsS http://127.0.0.1:3300/login >/dev/null
sed -i '/^IMAGE_TAG=/d' .env
printf '\nIMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
printf 'Deployed %s\n' "$revision"
