#!/usr/bin/env bash
# Extracts the deploy bundle (compose, Caddyfile, scripts, systemd units, n8n workflows) of
# one version from its API image into /opt/smartops/releases/<version> (phase 12). The bundle
# ships INSIDE the image, so the server needs one credential only: the read-only GHCR token.
#
#   sudo ./fetch-bundle.sh <version>
#
# First install (no bundle on the server yet) — the runbook has the same commands:
#   sudo docker pull ghcr.io/sanchezign/smartops-api:<v>
#   id=$(sudo docker create ghcr.io/sanchezign/smartops-api:<v>)
#   sudo mkdir -p /opt/smartops/releases && sudo docker cp "$id":/opt/smartops-deploy /opt/smartops/releases/<v>
#   sudo docker rm "$id"
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

version="${1:-}"
valid_version "$version" || die "usage: fetch-bundle.sh <version>  (e.g. 0.12.0)"
image="$SMARTOPS_IMAGE_PREFIX/smartops-api:$version"
target="$RELEASES_DIR/$version"

if [ "$SMARTOPS_LOCAL" != "1" ]; then
  log "pulling $image"
  docker pull --quiet "$image" >/dev/null
  label="$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
  [ "$label" = "$version" ] || die "$image says it is version '$label', not $version"
fi

mkdir -p "$RELEASES_DIR"
tmp="$(mktemp -d "$RELEASES_DIR/.fetch.XXXXXX")"
cid=""
cleanup() {
  [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT

cid="$(docker create "$image")"
docker cp "$cid:/opt/smartops-deploy" "$tmp/bundle"
[ -f "$tmp/bundle/compose.yaml" ] && [ -f "$tmp/bundle/bin/deploy.sh" ] ||
  die "$image has no deploy bundle (built before phase 12?)"
chmod -R go-w "$tmp/bundle"

rm -rf "$target"
mv "$tmp/bundle" "$target"
log "bundle of $version ready in $target"
