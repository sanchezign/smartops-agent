#!/usr/bin/env bash
# The version an image DECLARES must be the version being released (phase 12 M4: the first
# published images said "main" because the build job had no tag; deploy/bin/fetch-bundle.sh
# refuses such an image, rightly). Reads org.opencontainers.image.version.
#
#   scripts/ci/image-version-check.sh local     <image>  <expected-version>   (before publishing)
#   scripts/ci/image-version-check.sh published <image:tag> <expected-version> (after publishing:
#       every platform of the multi-arch image — amd64 AND arm64 — must declare it)
set -euo pipefail

mode="${1:-}"
image="${2:-}"
expected="${3:-}"
[ -n "$mode" ] && [ -n "$image" ] && [ -n "$expected" ] || {
  echo "usage: image-version-check.sh local|published <image> <expected-version>" >&2
  exit 2
}
label="org.opencontainers.image.version"

case "$mode" in
  local)
    actual="$(docker image inspect "$image" --format "{{ index .Config.Labels \"$label\" }}")"
    if [ "$actual" != "$expected" ]; then
      echo "::error::$image declares version '$actual', expected '$expected'" >&2
      exit 1
    fi
    echo "OK: $image declares version $actual"
    ;;
  published)
    json="$(docker buildx imagetools inspect "$image" --format '{{json .Image}}')"
    mapfile -t rows < <(jq -r --arg l "$label" \
      'to_entries[] | select(.value.config.Labels != null) | "\(.key) \(.value.config.Labels[$l] // "")"' <<<"$json")
    if [ "${#rows[@]}" -lt 2 ]; then
      echo "::error::$image: expected at least 2 platforms (amd64 + arm64), found ${#rows[@]}" >&2
      exit 1
    fi
    for row in "${rows[@]}"; do
      platform="${row%% *}"
      actual="${row#* }"
      if [ "$actual" != "$expected" ]; then
        echo "::error::$image ($platform) declares version '$actual', expected '$expected'" >&2
        exit 1
      fi
      echo "OK: $image ($platform) declares version $actual"
    done
    ;;
  *)
    echo "mode must be local or published" >&2
    exit 2
    ;;
esac
