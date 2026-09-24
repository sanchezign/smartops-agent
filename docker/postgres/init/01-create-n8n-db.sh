#!/bin/sh
# Creates the n8n role and database next to the app database (POSTGRES_DB).
# NOTE: the official postgres image runs /docker-entrypoint-initdb.d scripts
# ONLY when the data volume is created for the first time. Changes here
# require recreating the volume (see README).
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v n8n_db="$N8N_DB_NAME" \
  -v n8n_user="$N8N_DB_USER" \
  -v n8n_password="$N8N_DB_PASSWORD" <<'EOSQL'
CREATE ROLE :"n8n_user" WITH LOGIN PASSWORD :'n8n_password';
CREATE DATABASE :"n8n_db" OWNER :"n8n_user";
EOSQL
