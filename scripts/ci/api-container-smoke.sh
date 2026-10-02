#!/usr/bin/env bash
# API container smoke test (phase 11 M4): the image runs its migrations, starts the API and the
# worker against a throw-away Postgres, answers /health, and stops cleanly on SIGTERM.
# No real key: DEMO_MODE forces the fake LLM, fake transcriber and the local Graph API — the
# only way the production build starts without Meta/Anthropic/Groq credentials.
#   scripts/ci/api-container-smoke.sh <image>
set -euo pipefail

image="$1"
# Release workflow: the image must declare the version being released (EXPECTED_VERSION).
[ -z "${EXPECTED_VERSION:-}" ] || "$(dirname "$0")/image-version-check.sh" local "$image" "$EXPECTED_VERSION"
net="smartops-smoke-$$"
pg_image="postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
db_url="postgresql://postgres:postgres@pg:5432/smartops_smoke_demo"

cleanup() {
  docker rm -f "$net-api" "$net-worker" "$net-pg" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$net" >/dev/null
docker run -d --name "$net-pg" --network "$net" --network-alias pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=smartops_smoke_demo \
  "$pg_image" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$net-pg" pg_isready -U postgres -d smartops_smoke_demo >/dev/null 2>&1 && break
  sleep 1
done

# Fake values only (never a real key), shared by the three commands of the image.
envs=(
  -e NODE_ENV=production -e DATABASE_URL="$db_url" -e DEMO_MODE=true -e PORT=4000
  -e CORS_ORIGINS=https://panel.example.test
  -e WHATSAPP_PHONE_NUMBER_ID=100000000000001 -e WHATSAPP_WABA_ID=200000000000002
  -e WHATSAPP_ACCESS_TOKEN=smoke-fake-whatsapp-access-token
  -e WHATSAPP_APP_SECRET=smoke-fake-app-secret-000000
  -e WHATSAPP_VERIFY_TOKEN=smoke-fake-verify-token-0000
  -e INTERNAL_API_KEY=smoke-fake-internal-api-key-0000000000000
  -e JWT_ACCESS_SECRET=smoke-fake-jwt-access-secret-00000000000
  -e DEMO_OPERATOR_PASSWORD="una frase publica para el smoke test"
  -e DEMO_RESET_INTERVAL_MINUTES=0
)

echo "== migrations"
docker run --rm --network "$net" "${envs[@]}" "$image" \
  node node_modules/prisma/build/index.js migrate deploy

echo "== demo seed (the production entry deploy.sh runs)"
docker run --rm --network "$net" "${envs[@]}" "$image" node dist/demo-seed.js >/dev/null

echo "== deploy bundle (phase 12): present, executable, n8n workflows render"
docker run --rm --network none --entrypoint sh \
  -e INTERNAL_API_KEY=smoke-fake-internal-api-key-0000000000000 \
  -e N8N_WEBHOOK_SECRET=smoke-fake-n8n-webhook-secret-00000000000 \
  "$image" -c 'set -e
    test -f /opt/smartops-deploy/compose.yaml && test -f /opt/smartops-deploy/Caddyfile
    test -x /opt/smartops-deploy/bin/deploy.sh && test -x /opt/smartops-deploy/bin/fetch-bundle.sh
    node /opt/smartops-deploy/lib/render-n8n.mjs --workflows /opt/smartops-deploy/n8n/workflows \
      --out /tmp/n8n --api-base-url http://api:4000/api/v1 | wc -l | grep -qx 4
    echo "bundle OK"'

echo "== api + worker"
docker run -d --name "$net-api" --network "$net" "${envs[@]}" "$image" >/dev/null
docker run -d --name "$net-worker" --network "$net" "${envs[@]}" "$image" node dist/worker.js >/dev/null

ok=0
for _ in $(seq 1 60); do
  if docker exec "$net-api" node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    ok=1; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "::error::the API never answered /health"; docker logs "$net-api" | tail -40; exit 1
fi
echo "health OK"

for c in api worker; do
  docker stop --time 30 "$net-$c" >/dev/null
  code="$(docker inspect "$net-$c" --format '{{.State.ExitCode}}')"
  if [ "$code" != "0" ]; then
    echo "::error::$c exited with $code after SIGTERM"; docker logs "$net-$c" | tail -40; exit 1
  fi
  echo "$c stopped cleanly on SIGTERM (exit 0)"
done
echo "OK: container smoke test passed"
