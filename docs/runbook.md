# Runbook — demo pública en Oracle Cloud (fase 12)

Operación del servidor de la demo: deploy, rollback, backups, restauración, rotación de
secretos y qué hacer si algo se cae. Diseño y decisiones: ADR-023 (llega al cierre de la fase) y
[`deploy/README.md`](../deploy/README.md). Todo se ejecuta **en la VM con `sudo`**, salvo la
prueba de restauración, que corre **en tu PC**.

> Estado: M0 (scripts probados en local con `scripts/deploy/local-harness.sh`). Las secciones
> de la consola de Oracle (M1), el endurecimiento (M2) y el primer arranque (M3) se completan
> con la guía paso a paso de cada hito.

## 0. Qué hay en la VM

| Ruta                          | Qué es                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `/etc/smartops/demo.env`      | secretos + dominio (root, **600**). Lo crea `init-secrets.sh`; nunca se sube |
| `/etc/smartops/backup.env`    | destino del backup, tu clave **pública** age, URL de Healthchecks (600)      |
| `/etc/smartops/monitor.env`   | URLs de Healthchecks y umbrales de disco / memoria (600)                     |
| `/opt/smartops/releases/<v>/` | bundle de cada versión (sale de su imagen de la API)                         |
| `/opt/smartops/current`       | enlace a la versión en uso (los timers de systemd lo siguen)                 |
| `/opt/smartops/state/`        | `current`, `previous`, `deploy.log`                                          |
| `/opt/smartops/backups/`      | copias locales cifradas (7 días)                                             |

Contenedores (proyecto `smartops-demo`): `caddy` (único con puertos: 80/443), `admin`, `api`,
`worker`, `n8n` (sin editor), `postgres`. Estado de un vistazo:

```bash
sudo /opt/smartops/current/bin/status.sh
```

## 1. Deploy de una versión

Las versiones son los tags de GitHub (`v0.12.0` → imagen `0.12.0`). La VM **baja** la versión;
nadie empuja nada a la VM y la CI no tiene credenciales de ella.

```bash
sudo /opt/smartops/current/bin/deploy.sh 0.13.0
```

Qué hace, en orden (si algo falla, frena con un mensaje claro y la versión anterior sigue):

1. baja el bundle de `0.13.0` desde su imagen (si falta) y le pasa el control a **su** `deploy.sh`;
2. controla que `demo.env` sea 600 y que **no tenga ninguna clave real** (la API también se
   niega a arrancar si encuentra una);
3. baja las imágenes;
4. **backup cifrado antes de migrar** (no en la primera instalación);
5. `prisma migrate deploy` (solo hacia adelante);
6. re-siembra los datos de la demo (usuarios y sesiones se mantienen);
7. importa y publica los workflows de n8n por CLI;
8. levanta todo, espera los healthchecks y prueba `https://<dominio>/api/v1/health` y `/login`
   a través de Caddy;
9. anota `current` / `previous` y actualiza los timers.

## 2. Rollback

```bash
sudo /opt/smartops/current/bin/rollback.sh          # vuelve a la versión anterior
sudo /opt/smartops/current/bin/rollback.sh 0.12.0   # o a una versión concreta
```

Vuelve las **imágenes**, el compose y los workflows de n8n; **la base no se toca**. Regla del
proyecto: las migraciones son _expand/contract_ (una migración nunca rompe a la versión
anterior). Si la base tiene migraciones que la versión destino no conoce, el rollback **se
niega** y las lista:

- si son aditivas (columnas / tablas nuevas): `rollback.sh 0.12.0 --accept-newer-schema`;
- si no: restaurá el backup `pre-deploy-<versión>` (sección 5) y después hacé el rollback.

## 3. Backups

Diarios a las 03:30 (hora de Montevideo) y antes de cada deploy: las dos bases (demo + n8n) y
`demo.env` (sin él, las credenciales guardadas de n8n no se pueden leer), **cifrados con age a
tu clave pública**. La clave privada vive solo en tu PC: si alguien toma la VM, no puede leer
los backups.

`/etc/smartops/backup.env` (600):

```ini
BACKUP_AGE_RECIPIENT=age1…          # tu clave PÚBLICA (age-keygen -y clave.txt)
BACKUP_TARGET=oci
OCI_BUCKET=smartops-backups         # retención: política de ciclo de vida del bucket (30 días)
HC_BACKUP_URL=https://hc-ping.com/… # opcional: Healthchecks avisa si un backup falla o no llega
```

A mano: `sudo /opt/smartops/current/bin/backup.sh --reason manual`.

## 4. Prueba de restauración (en tu PC, una vez por mes)

1. Bajá una carpeta de backup del bucket (Object Storage → bucket → carpeta `<fecha>-<motivo>/`
   → descargar los 4 archivos).
2. En el repo:

```bash
deploy/bin/restore-test.sh --dir <carpeta descargada> --identity <tu clave age> \
  --hc-url https://hc-ping.com/<uuid del chequeo mensual>
```

Verifica checksums, descifra en memoria, restaura en un Postgres **descartable**, cuenta filas
(migraciones, usuarios, productos, mensajes, workflows y credenciales de n8n) y borra el
contenedor. El chequeo mensual de Healthchecks.io (periodo 30 días) te manda un mail solo si
pasa un mes sin una restauración exitosa: es el recordatorio (no hay timer en la VM).

## 5. Restauración real (se perdió la base o la VM)

1. VM nueva (M1/M2 del runbook) o la misma VM.
2. En tu PC, descifrá `demo.env.age` del backup y copiá el resultado a la VM como
   `/etc/smartops/demo.env` (root, `chmod 600`). **Tiene que ser el mismo archivo**: la
   `N8N_ENCRYPTION_KEY` de ese backup es la que lee las credenciales de n8n.
3. Deploy de la **misma versión** del backup (`manifest.txt` → `version=`):
   `sudo /opt/smartops/releases/<v>/bin/deploy.sh <v> --skip-backup`.
4. Restaurar las bases (descifrando en tu PC y subiendo los `.dump` a la VM por el túnel):

```bash
sudo docker compose -p smartops-demo stop api worker n8n
for db in smartops_demo n8n; do
  sudo docker compose -p smartops-demo exec -T postgres \
    pg_restore -U postgres --clean --if-exists --no-owner -d "$db" < "$db.dump"
done
sudo docker compose -p smartops-demo start api worker n8n
sudo /opt/smartops/current/bin/status.sh
```

5. Borrá los `.dump` descifrados de la VM y de tu PC.

## 6. Rotación de secretos

| Secreto                                                           | Cómo                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Token de GHCR (PAT classic, `read:packages`, vence a los 90 días) | Creá uno nuevo en GitHub → `sudo docker login ghcr.io -u <usuario>` (pegalo por stdin) → revocá el viejo                              |
| `INTERNAL_API_KEY`, `N8N_WEBHOOK_SECRET`                          | borrá la línea de `demo.env`, `sudo init-secrets.sh` genera otra, y `deploy.sh <versión actual>` (re-importa las credenciales de n8n) |
| `JWT_ACCESS_SECRET`                                               | igual; los visitantes vuelven a iniciar sesión (normal)                                                                               |
| Contraseñas de Postgres                                           | `ALTER ROLE … PASSWORD` dentro del contenedor, actualizar `demo.env`, `deploy.sh <versión actual>`                                    |
| `N8N_ENCRYPTION_KEY`                                              | **no se rota** sin re-cifrar las credenciales de n8n; en la demo alcanza con borrar el volumen de n8n y hacer deploy (se re-importan) |
| Clave age                                                         | nueva clave en tu PC, nueva `BACKUP_AGE_RECIPIENT`; guardá la vieja mientras existan backups cifrados con ella (30 días)              |

Nunca pegues un secreto en un comando (queda en el historial): usá archivos 600 o stdin.

## 7. Si algo se cae

| Síntoma                                 | Qué hacer                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Mail de Healthchecks "monitor" (fail)   | `status.sh`; el texto del aviso dice qué falló (disco, memoria, contenedor, HTTPS)                              |
| Healthchecks sin pings                  | la VM está caída o apagada: consola de OCI → la instancia → _Reboot_; después `status.sh`                       |
| Mail "boot" (fail) después de las 04:00 | los contenedores no volvieron solos: `sudo docker compose -p smartops-demo up -d` y revisar `logs`              |
| UptimeRobot: la demo no responde        | `status.sh`; `sudo docker compose -p smartops-demo logs --tail 100 caddy api`                                   |
| Disco lleno                             | `sudo docker system df`; logs ya rotan; borrar backups locales viejos o imágenes sin uso (`docker image prune`) |
| Oracle reclamó / borró la VM            | sección 5 con una VM nueva (el backup está en Object Storage)                                                   |
| "Out of capacity" al crear la VM        | reintentar en otro horario o con una forma más chica; no hay otro dominio de disponibilidad en la región        |
| Alerta de presupuesto de OCI            | **no debería pasar** (cuenta sin upgrade): consola → Billing → Cost Analysis, identificar el recurso y borrarlo |

## 8. Probar en local antes de un release

```bash
docker build -f apps/api/Dockerfile   -t smartops-local/smartops-api:m0a .
docker build -f apps/admin/Dockerfile -t smartops-local/smartops-admin:m0a .
docker tag smartops-local/smartops-api:m0a smartops-local/smartops-api:m0b
docker tag smartops-local/smartops-admin:m0a smartops-local/smartops-admin:m0b
scripts/deploy/local-harness.sh <carpeta vacía>
```

Corre los scripts reales de `deploy/bin` contra tu Docker (puertos solo en 127.0.0.1): deploy,
smoke a través de Caddy (encabezados, rutas internas bloqueadas, SSE, una muestra por n8n),
segundo deploy con backup, prueba de restauración, rollback y el rechazo por esquema más nuevo.
Al final imprime los comandos para desarmarlo (no los ejecuta).
