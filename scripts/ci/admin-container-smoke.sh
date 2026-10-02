#!/usr/bin/env bash
# Panel container smoke test (phase 11 M4): the standalone server serves /login (noindex) and
# stops cleanly on SIGTERM.   scripts/ci/admin-container-smoke.sh <image>
set -euo pipefail
image="$1"
# Release workflow: the image must declare the version being released (EXPECTED_VERSION).
[ -z "${EXPECTED_VERSION:-}" ] || "$(dirname "$0")/image-version-check.sh" local "$image" "$EXPECTED_VERSION"
name="smartops-admin-smoke-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" "$image" >/dev/null
ok=0
for _ in $(seq 1 60); do
  if docker exec "$name" node -e "fetch('http://127.0.0.1:3000/login').then(async r=>{const t=await r.text();process.exit(r.ok&&t.includes('noindex')?0:1)},()=>process.exit(1))"; then
    ok=1; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then echo "::error::the panel never served /login"; docker logs "$name" | tail -40; exit 1; fi
echo "/login OK (noindex)"
# public/ reaches the image: the private panel tells crawlers to stay out.
if ! docker exec "$name" node -e "fetch('http://127.0.0.1:3000/robots.txt').then(async r=>{const t=await r.text();process.exit(r.ok&&/Disallow: \/\s*$/m.test(t)?0:1)},()=>process.exit(1))"; then
  echo "::error::/robots.txt is missing or does not disallow everything"; exit 1
fi
echo "/robots.txt OK (Disallow: /)"
docker stop --time 20 "$name" >/dev/null
code="$(docker inspect "$name" --format '{{.State.ExitCode}}')"
if [ "$code" != "0" ]; then echo "::error::panel exited with $code after SIGTERM"; exit 1; fi
echo "OK: panel container smoke test passed"
