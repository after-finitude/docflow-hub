#!/bin/sh
set -eu

app_dir=/home/user1/apps/docflow-hub
lock_file=/home/user1/apps/docflow-hub.deploy.lock
staging_dir=$(mktemp -d /home/user1/apps/docflow-hub.deploy.XXXXXX)
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM

exec 9>"$lock_file"
flock -n 9 || { echo 'A Docflow Hub deployment is already running.' >&2; exit 1; }

tar -xzf - -C "$staging_dir"
test -f "$staging_dir/docker-compose.yml"

# ponytail: in-place deploy; add release directories and rollback if zero-downtime deploys matter.
rsync -a --delete \
  --exclude='.env' \
  --exclude='/secrets/' \
  --exclude='docker-compose.override.yml' \
  --exclude='docker/source-inbox/' \
  "$staging_dir/" "$app_dir/"

cd "$app_dir"
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:3300/login >/dev/null
