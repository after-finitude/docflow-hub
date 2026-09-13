#!/bin/sh
set -eu
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset CDPATH DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES

revision=${SSH_ORIGINAL_COMMAND:-}
case "$revision" in
  ''|*[!0-9a-f]*) echo 'Expected a Git commit SHA.' >&2; exit 1 ;;
esac
test "${#revision}" -eq 40 || { echo 'Expected a full Git commit SHA.' >&2; exit 1; }

app_dir=/opt/docflow-hub
exec 9>/var/lib/app-deploy/deploy.lock
# ponytail: one shared VPS lock; split only after the server can afford parallel builds.
flock -w 900 9 || { echo 'Timed out waiting for another deployment.' >&2; exit 1; }
staging_dir=$(mktemp -d /var/lib/app-deploy/docflow.XXXXXX)
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM
chown docflow-unpack:docflow-unpack "$staging_dir"
timeout --kill-after=5 120 runuser -u docflow-unpack -- \
  prlimit --as=268435456 --fsize=16777216 --cpu=60 --nproc=32 -- \
  python3 -I /usr/local/lib/docflow-deploy/extract-release.py docflow "$staging_dir" 9>&-
chown -R root:root "$staging_dir"

cd "$app_dir"
export COMPOSE_FILE=docker-compose.yml:docker/compose.vps.yml
export COMPOSE_PROJECT_NAME=docflow-hub
export IMAGE_TAG="$revision"
docker compose config -q
# Only validated source enters the build context. Server secrets and Docker configuration cannot enter it.
# Build sequentially to fit the 2 GB VPS; running containers keep their images.
docker build --build-arg APP=api -f "$app_dir/docker/node.Dockerfile" -t "docflow-backend:$IMAGE_TAG" "$staging_dir"
docker build --build-arg API_INTERNAL_URL=http://api:3001 -f "$app_dir/docker/web.Dockerfile" -t "docflow-web:$IMAGE_TAG" "$staging_dir"

# ponytail: in-place deploy; add release directories and rollback if zero-downtime deploys matter.
# Synchronize approved source only.
for directory in apps packages; do
  rsync -rp --delete "$staging_dir/$directory/" "$app_dir/$directory/"
done
for file in package.json package-lock.json tsconfig.json tsconfig.base.json; do
  install -m 644 "$staging_dir/$file" "$app_dir/$file"
done
# End source synchronization.
# Caddy and storage services are managed separately by the administrator.
docker compose run --rm --no-deps -T migrate
docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 api worker web
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:3300/login >/dev/null
sed -i '/^IMAGE_TAG=/d' .env
printf '\nIMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
printf '%s\n' "$revision" > "$app_dir/.deployed-revision"
printf 'Deployed %s\n' "$revision"
