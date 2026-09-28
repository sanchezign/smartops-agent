#!/usr/bin/env bash
# Imports the versioned n8n workflows + their credentials into the demo's n8n by CLI and
# publishes them (phase 12, user addendum D: the demo's n8n has no editor). Idempotent: the
# workflows and credentials keep fixed ids, so a re-import replaces them.
#
#   sudo ./n8n-import.sh <version>        (deploy.sh calls it on every deploy)
#
# The rendered files (credentials WITH their secret values) never touch the server's disk:
# the API image renders them into its own /tmp and streams a tar straight into a one-off n8n
# container, which imports from its own /tmp and disappears. Values are never printed.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

version="${1:-}"
valid_version "$version" || die "usage: n8n-import.sh <version>"
release="$RELEASES_DIR/$version"
[ -d "$release/n8n/workflows" ] || die "no workflows in $release (fetch the bundle first)"
api_image="$SMARTOPS_IMAGE_PREFIX/smartops-api:$version"

INTERNAL_API_KEY="$(env_value INTERNAL_API_KEY)"
N8N_WEBHOOK_SECRET="$(env_value N8N_WEBHOOK_SECRET)"
export INTERNAL_API_KEY N8N_WEBHOOK_SECRET

# Renderer: the workflows and render-n8n.mjs ship inside the API image of this version.
render='set -e
umask 077
node /opt/smartops-deploy/lib/render-n8n.mjs --workflows /opt/smartops-deploy/n8n/workflows \
  --out /tmp/n8n --api-base-url http://api:4000/api/v1 >&2
tar -C /tmp/n8n -cf - .'

# Importer: n8n CLI in a one-off container of the n8n service (same DB, same encryption key).
# Single quotes on purpose: this script is expanded by the container's sh, not here.
# shellcheck disable=SC2016
import='set -e
umask 077
mkdir -p /tmp/n8n
tar -xf - -C /tmp/n8n
n8n import:credentials --input=/tmp/n8n/credentials.json
n8n import:workflow --separate --input=/tmp/n8n/workflows
for file in /tmp/n8n/workflows/*.json; do
  n8n publish:workflow --id="$(basename "$file" .json)"
done
rm -rf /tmp/n8n'

log "rendering and importing the n8n workflows of $version"
status=0
out="$(
  docker run --rm -i --network none -e INTERNAL_API_KEY -e N8N_WEBHOOK_SECRET \
    --entrypoint sh "$api_image" -c "$render" |
    compose_for "$version" run --rm --no-deps -T --entrypoint sh n8n -c "$import" 2>&1
)" || status=$?
unset INTERNAL_API_KEY N8N_WEBHOOK_SECRET
printf '%s\n' "$out" | grep -vE '^\s*$|Please restart n8n|^ Container ' >&2 || true
[ "$status" -eq 0 ] || die "n8n import failed (exit $status)"
log "n8n workflows imported and published (n8n restarts to load them)"
