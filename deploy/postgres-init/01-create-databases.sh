#!/bin/sh
# Public demo (phase 12): the app role + database (smartops_demo — the API refuses any other
# name in DEMO_MODE) and n8n's own role + database. Each role owns only its database; the
# superuser "postgres" is used for backups only.
# Runs ONLY when the data volume is created for the first time (official postgres image).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" \
  -v n8n_password="$N8N_DB_PASSWORD" <<'EOSQL'
CREATE ROLE smartops WITH LOGIN PASSWORD :'app_password';
CREATE DATABASE smartops_demo OWNER smartops;
CREATE ROLE n8n WITH LOGIN PASSWORD :'n8n_password';
CREATE DATABASE n8n OWNER n8n;
REVOKE ALL ON DATABASE smartops_demo FROM PUBLIC;
REVOKE ALL ON DATABASE n8n FROM PUBLIC;
EOSQL
