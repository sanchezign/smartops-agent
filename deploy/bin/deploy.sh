#!/usr/bin/env bash
# Deploys ONE tagged version of the public demo (phase 12, ADR-023). Pull model: the server
# pulls the images published by release.yml; nothing pushes into the server and CI holds no
# credential of it.
#
#   sudo /opt/smartops/current/bin/deploy.sh 0.13.0      (any release's deploy.sh can start it)
#   sudo …/deploy.sh 0.12.0 --rollback                    (rollback.sh does this for you)
#
# Steps: bundle of <version> (fetched from its image if missing; then that version's own
# deploy.sh takes over) → preflight (secrets file 600, no real key) → pull → Postgres up →
# BACKUP before migrating (not on the first install) → `prisma migrate deploy` (forward only;
# skipped on --rollback) → n8n workflows by CLI → every service up → health checks through
# Caddy → state (current / previous) → systemd units. Any failure stops with a clear message;
# the previous version keeps its data and `rollback.sh` brings its images back.
# shellcheck source=deploy/bin/lib.sh
. "$(dirname "$0")/lib.sh"
require_root

version="${1:-}"
shift || true
rollback=0
accept_newer_schema=0
skip_backup=0
for arg in "$@"; do
  case "$arg" in
    --rollback) rollback=1 ;;
    --accept-newer-schema) accept_newer_schema=1 ;;
    --skip-backup) skip_backup=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done
valid_version "$version" || die "usage: deploy.sh <version> [--rollback] [--accept-newer-schema]"

# One deploy at a time.
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || die "another deploy is running"; fi

here="$(cd "$(dirname "$0")/.." && pwd)"
release="$RELEASES_DIR/$version"
if [ ! -f "$release/compose.yaml" ]; then
  "$here/bin/fetch-bundle.sh" "$version"
fi
# The version being deployed runs ITS OWN deploy logic (newer steps, newer checks).
if [ "$(cd "$release" && pwd)" != "$here" ]; then
  exec 9>&-
  exec bash "$release/bin/deploy.sh" "$version" "$@"
fi

current="$(read_state current)"
log "deploying $version (current: ${current:-none})$([ "$rollback" -eq 1 ] && echo ' — ROLLBACK')"

# ── Preflight ──────────────────────────────────────────────────────────────────────────────
check_secret_file "$SMARTOPS_ENV_FILE"
assert_no_real_keys "$SMARTOPS_ENV_FILE"
domain="$(env_value DEMO_DOMAIN)"
[ -n "$domain" ] || die "DEMO_DOMAIN is not set in $SMARTOPS_ENV_FILE"
compose_for "$version" config --quiet || die "compose.yaml of $version does not validate with $SMARTOPS_ENV_FILE"

# ── Images ─────────────────────────────────────────────────────────────────────────────────
if [ "$SMARTOPS_LOCAL" != "1" ]; then
  log "pulling images"
  compose_for "$version" --profile tools pull --quiet
fi

# ── Database ───────────────────────────────────────────────────────────────────────────────
compose_for "$version" up -d postgres
for _ in $(seq 1 60); do
  compose_for "$version" exec -T postgres pg_isready -U postgres -d smartops_demo >/dev/null 2>&1 && break
  sleep 2
done
compose_for "$version" exec -T postgres pg_isready -U postgres -d smartops_demo >/dev/null ||
  die "Postgres is not ready"

if [ -n "$current" ] && [ "$skip_backup" -eq 0 ]; then
  log "backup before migrating (reason: pre-deploy-$version)"
  "$here/bin/backup.sh" --reason "pre-deploy-$version" --version "$version" ||
    die "the pre-deploy backup failed: nothing was changed (fix it, or --skip-backup on purpose)"
fi

applied_migrations() {
  compose_for "$version" exec -T postgres psql -U postgres -d smartops_demo -Atc \
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" 2>/dev/null || true
}

if [ "$rollback" -eq 1 ]; then
  # Migrations are forward-only. An older version runs on a newer schema only if every
  # migration since then was "expand" (additive) — the rule the project follows (runbook).
  image_migrations="$(docker run --rm --entrypoint sh "$SMARTOPS_IMAGE_PREFIX/smartops-api:$version" \
    -c 'ls prisma/migrations' | grep -vE '\.toml$' | sort)"
  newer="$(comm -13 <(printf '%s\n' "$image_migrations") <(applied_migrations | sort) | sed '/^$/d')"
  if [ -n "$newer" ]; then
    log "the database has migrations that $version does not know:"
    printf '    %s\n' "$newer" >&2
    [ "$accept_newer_schema" -eq 1 ] || die "re-run with --accept-newer-schema if they are all additive (expand/contract), or restore the pre-deploy backup (runbook: restore)"
  fi
else
  log "applying migrations (forward only)"
  compose_for "$version" --profile tools run --rm migrate || die "migrations failed: the previous version is still running; see the runbook"
  # The public demo's data is rebuilt on every deploy (as on the hourly reset); users and live
  # sessions are kept. Not on a rollback: an older seed may not match the newer schema.
  log "seeding the demo data"
  compose_for "$version" --profile tools run --rm seed || die "the demo seed failed"
fi

# ── n8n workflows (no editor: CLI) ─────────────────────────────────────────────────────────
"$here/bin/n8n-import.sh" "$version"

# ── Services ───────────────────────────────────────────────────────────────────────────────
compose_for "$version" up -d --remove-orphans
compose_for "$version" restart n8n >/dev/null # loads the freshly imported workflows
if ! wait_healthy "$version" 300; then
  compose_for "$version" ps >&2
  die "$version is not healthy. Logs: docker compose -p $SMARTOPS_PROJECT logs --tail 100. Back: sudo $here/bin/rollback.sh"
fi

# Through Caddy, like a visitor (the demo's own host name, resolved to this machine).
for _ in $(seq 1 30); do
  curl_demo /api/v1/health 2>/dev/null && break
  sleep 5
done
curl_demo /api/v1/health || die "https://$domain/api/v1/health does not answer through Caddy"
curl_demo /login || die "https://$domain/login does not answer through Caddy"

# ── State ──────────────────────────────────────────────────────────────────────────────────
if [ -n "$current" ] && [ "$current" != "$version" ]; then write_state previous "$current"; fi
write_state current "$version"
# Atomic switch of the "current" symlink (the systemd units follow it). Git Bash (local harness)
# copies instead of linking: there the old copy is replaced.
if [ "$SMARTOPS_LOCAL" = "1" ] && [ -d "$SMARTOPS_HOME/current" ] && [ ! -L "$SMARTOPS_HOME/current" ]; then
  rm -rf "${SMARTOPS_HOME:?}/current"
fi
ln -sfn "$release" "$SMARTOPS_HOME/.current.tmp"
mv -Tf "$SMARTOPS_HOME/.current.tmp" "$SMARTOPS_HOME/current"
printf '%s  deployed %s (from %s)%s\n' "$(date -u +%FT%TZ)" "$version" "${current:-none}" \
  "$([ "$rollback" -eq 1 ] && echo ' [rollback]')" >>"$STATE_DIR/deploy.log"

# ── Timers (backup, monitor, boot check) ───────────────────────────────────────────────────
if [ "$SMARTOPS_LOCAL" != "1" ]; then
  "$here/bin/install-units.sh"
fi
log "$version is live on https://$domain"
