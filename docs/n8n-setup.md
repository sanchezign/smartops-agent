# n8n: importar, configurar y probar los workflows de SmartOps (fase 6)

Los borradores están en `n8n/workflows/`:

| Archivo          | Workflow               | Qué hace                                                                                               |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `receiver.json`  | SmartOps · Receptor    | Webhook "mensaje listo" → `POST /internal/classify` → ruta (lista / consulta / fin)                    |
| `processor.json` | SmartOps · Procesador  | `POST /internal/extract` (espera si está "extracting") → `POST /internal/catalog/ingest` → notificador |
| `notifier.json`  | SmartOps · Notificador | `POST /internal/notifications` → (si es lista) `POST /internal/messages/ack`                           |
| `errors.json`    | SmartOps · Errores     | Error Trigger → `POST /internal/n8n/errors` (alerta + aviso crítico)                                   |

El backend decide todo lo importante (pre-filtro, completa/parcial, qué se notifica, a quién, cuándo).
n8n solo orquesta. Ningún secreto va en los JSON: solo nombres de credenciales.

## 0. Antes de empezar

1. `docker compose up -d` (n8n en http://localhost:5678, API en tu máquina).
2. `pnpm --filter @smartops/api dev` (API + worker) con el LLM fake (`AI_PROVIDER=fake`, $0).
3. En `apps/api/.env` ya están generados `INTERNAL_API_KEY` y `N8N_WEBHOOK_SECRET`.
   Dejá `N8N_DELIVERY_ENABLED=false` hasta el paso 5.

## 1. Credenciales (una sola vez) — n8n → Overview → Create → Credential

| Nombre (exacto)           | Tipo        | Name                 | Value                            |
| ------------------------- | ----------- | -------------------- | -------------------------------- |
| `SmartOps API`            | Header Auth | `X-Internal-Api-Key` | el valor de `INTERNAL_API_KEY`   |
| `SmartOps webhook secret` | Header Auth | `X-SmartOps-Secret`  | el valor de `N8N_WEBHOOK_SECRET` |

Los nombres tienen que ser exactamente esos: los JSON los referencian por nombre.

## 2. Importar (Workflows → ⋯ → Import from File), en este orden

1. `errors.json`
2. `notifier.json`
3. `processor.json`
4. `receiver.json`

Después de importar cada uno:

- En **cada nodo HTTP** (y en el Webhook del receptor) abrí el nodo y elegí la credencial en el
  desplegable (al importar la referencia queda vacía). Guardá.
- **Config** (primer nodo tras el disparador): `apiBaseUrl` = `http://host.docker.internal:4000/api/v1`
  (n8n corre en Docker y la API en tu máquina; en el deploy de la fase 12 será `http://api:4000/api/v1`).
- **Procesador → nodo "Notificar"** y **Receptor → "Procesar lista" / "Notificar consulta"**:
  elegí en _Workflow_ el sub-workflow correspondiente (SmartOps · Procesador / SmartOps · Notificador).
- **Settings** de Receptor, Procesador y Notificador → _Error workflow_ = `SmartOps · Errores`.

## 3. Probar sin Meta ($0)

1. Abrí el Receptor y pulsá **Execute workflow** (URL de prueba `/webhook-test/…`).
2. Desde otra terminal enviá un evento como lo hace el backend (reemplazá `<secret>` y `<messageId>`
   por un mensaje real de tu base, por ejemplo uno creado con `wa:simulate`):

   ```bash
   node -e "fetch('http://localhost:5678/webhook-test/smartops-message-ready',{method:'POST',headers:{'content-type':'application/json','x-smartops-secret':'<secret>'},body:JSON.stringify({version:1,type:'message.ready',messageId:'<messageId>'})}).then(r=>console.log(r.status))"
   ```

3. Mirá la ejecución: Clasificar → Ruta → Procesar lista → (Procesador) Extraer → Ingestar → Notificar.
4. Pruebas sugeridas (con `wa:simulate` + `wa:fake-graph`, LLM fake y golden):
   - texto con precios de un proveedor → lista procesada;
   - "hola" → pre-filtrado (`prefilterRule`), fin sin LLM;
   - mensaje de un contacto `customer` → notificación de consulta;
   - PDF y foto de prueba (`test/fixtures/extraction/`) → 5 cambios, 1 revisión → notificación en el panel.
5. Errores: apagá la API y ejecutá de nuevo → los nodos HTTP reintentan 3 veces y el workflow
   de errores intenta avisar al backend (con la API apagada fallará también; al volver, repetí).

## 4. Publicar

Publicá los 4 workflows (n8n 2.x: botón **Publish**). La URL de producción del receptor es
`http://localhost:5678/webhook/smartops-message-ready` (la de `N8N_RECEIVER_WEBHOOK_URL`).

## 5. Encender la entrega automática

En `apps/api/.env`: `N8N_DELIVERY_ENABLED=true` y reiniciá `pnpm dev`. Desde ahí cada mensaje
listo llega solo a n8n (reintentos ~24 h si n8n está caído; `pnpm --filter @smartops/api n8n:replay`
reenvía los que fallaron). Para probar: `pnpm --filter @smartops/api wa:simulate text --body "Tarugo 8mm 150"`.

## 6. Exportar de vuelta al repo (sin credenciales)

```bash
pnpm --filter @smartops/api n8n:export
npx prettier --write n8n/workflows
pnpm --filter @smartops/api test -- n8n-workflows   # los tests estáticos validan el export
```

El script corre `n8n export:workflow` dentro del contenedor, descarta `pinData` (los datos
fijados de prueba pueden tener teléfonos reales), `staticData` y metadatos, deja las
credenciales solo como referencia (nombre e id) y **no escribe nada** si encuentra algo con
forma de secreto. Nunca exportes credenciales.

## Seguridad

- El editor de n8n NUNCA queda expuesto públicamente (fase 12: solo por túnel/VPN o IP
  permitida, además del login).
- n8n no toca la base de datos: todo pasa por la API interna con `X-Internal-Api-Key`.
