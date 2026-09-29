# n8n: import, configure and test the SmartOps workflows (phase 6)

The workflows are in `n8n/workflows/`:

| File             | Workflow               | What it does                                                                                     |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `receiver.json`  | SmartOps · Receptor    | "message ready" webhook → `POST /internal/classify` → route (list / question / order / end)      |
| `processor.json` | SmartOps · Procesador  | `POST /internal/extract` (waits while "extracting") → `POST /internal/catalog/ingest` → notifier |
| `notifier.json`  | SmartOps · Notificador | `POST /internal/notifications` → (for a list) `POST /internal/messages/ack`                      |
| `errors.json`    | SmartOps · Errores     | Error Trigger → `POST /internal/n8n/errors` (alert + critical notice)                            |

The workflow and node names are still in Spanish, as they appear in n8n ("Receptor" = receiver,
"Procesador" = processor, "Notificador" = notifier, "Errores" = errors). They become English
when the demo server imports them (phase 12). The names below are quoted as they appear.

The backend decides everything that matters: the pre-filter, full vs partial list, what is
notified, to whom and when. n8n only orchestrates. No secret goes into the JSON files, only
credential names.

## 0. Before you start

1. `docker compose up -d` (n8n on http://localhost:5678, the API on your machine).
2. `pnpm --filter @smartops/api dev` (API + worker) with the fake LLM (`AI_PROVIDER=fake`, $0).
3. `apps/api/.env` already has `INTERNAL_API_KEY` and `N8N_WEBHOOK_SECRET`. Keep
   `N8N_DELIVERY_ENABLED=false` until step 5.

## 1. Credentials (once) — n8n → Overview → Create → Credential

| Name (exact)              | Type        | Name                 | Value                             |
| ------------------------- | ----------- | -------------------- | --------------------------------- |
| `SmartOps API`            | Header Auth | `X-Internal-Api-Key` | the value of `INTERNAL_API_KEY`   |
| `SmartOps webhook secret` | Header Auth | `X-SmartOps-Secret`  | the value of `N8N_WEBHOOK_SECRET` |

The names must be exactly these: the JSON files refer to them by name.

## 2. Import (Workflows → ⋯ → Import from File), in this order

1. `errors.json`
2. `notifier.json`
3. `processor.json`
4. `receiver.json`

After importing each one:

- In **every HTTP node** (and in the receiver's Webhook node), open the node and pick the
  credential in the drop-down (the import leaves the reference empty). Save.
- **Config** (the first node after the trigger): `apiBaseUrl` =
  `http://host.docker.internal:4000/api/v1` (n8n runs in Docker and the API on your machine; on
  the phase 12 server it is `http://api:4000/api/v1`).
- **Procesador → node "Notificar"** (notify) and **Receptor → "Procesar lista" / "Notificar
  consulta"** (process list / notify question): pick the matching sub-workflow in _Workflow_
  (SmartOps · Procesador / SmartOps · Notificador).
- **Settings** of Receptor, Procesador and Notificador → _Error workflow_ = `SmartOps · Errores`.

## 3. Test without Meta ($0)

1. Open the Receptor and click **Execute workflow** (test URL `/webhook-test/…`).
2. From another terminal, send an event the way the backend does (replace `<secret>` and
   `<messageId>` with a real message from your database, for example one created with
   `wa:simulate`):

   ```bash
   node -e "fetch('http://localhost:5678/webhook-test/smartops-message-ready',{method:'POST',headers:{'content-type':'application/json','x-smartops-secret':'<secret>'},body:JSON.stringify({version:1,type:'message.ready',messageId:'<messageId>'})}).then(r=>console.log(r.status))"
   ```

3. Watch the execution: Clasificar (classify) → Ruta (route) → Procesar lista → (Procesador)
   Extraer (extract) → Ingestar (ingest) → Notificar.
4. Suggested tests (with `wa:simulate` + `wa:fake-graph`, the fake LLM and the recorded outputs):
   - a supplier's text with prices → the list is processed;
   - "hola" → pre-filtered (`prefilterRule`), the end, no LLM;
   - a message from a `customer` contact → a question notification;
   - the test PDF and photo (`test/fixtures/extraction/`) → 5 price changes, 1 review → a panel
     notification.
5. Errors: stop the API and run it again → the HTTP nodes retry 3 times and the error workflow
   tries to tell the backend (with the API down that fails too; repeat once it is back).

## 4. Publish

Publish the 4 workflows (n8n 2.x: the **Publish** button). The receiver's production URL is
`http://localhost:5678/webhook/smartops-message-ready` (the one in `N8N_RECEIVER_WEBHOOK_URL`).

## 5. Turn on automatic delivery

In `apps/api/.env`: `N8N_DELIVERY_ENABLED=true`, then restart `pnpm dev`. From then on every
ready message reaches n8n by itself (retries for ~24 h if n8n is down;
`pnpm --filter @smartops/api n8n:replay` resends the failed ones). To try it:
`pnpm --filter @smartops/api wa:simulate text --body "Tarugo 8mm 150"`.

## 6. Export back to the repository (no credentials)

```bash
pnpm --filter @smartops/api n8n:export
npx prettier --write n8n/workflows
pnpm --filter @smartops/api test -- n8n-workflows   # the static tests validate the export
```

The script runs `n8n export:workflow` inside the container, drops `pinData` (pinned test data
may hold real phone numbers), `staticData` and metadata, keeps credentials only as references
(name and id) and **writes nothing** if it finds anything that looks like a secret. Never export
credentials.

## 7. Updating the Receptor (phase 8: orders)

`receiver.json` adds the **"pedido"** (order) output to the `Ruta` node (`internal_order`) →
"Datos del pedido" (order data, `kind: order`) → "Notificar pedido" (notify order, the same
Notificador). Without it an order is classified but nobody is told.

1. In n8n open **SmartOps · Receptor**, **clear the canvas** (select all with Ctrl+A → Delete),
   and only then ⋯ → **Import from File** → `n8n/workflows/receiver.json`.
   **Import from File ADDS the nodes to the canvas, it does not replace them**: without clearing
   it you get duplicate nodes ("Ruta1", "Clasificar1"…) and two webhooks on the same path.
   This way the workflow keeps its id and its production URL.
2. Check that the **Notificar pedido** node points to _SmartOps · Notificador_ (if it is empty,
   pick it in the drop-down) and that the HTTP nodes and the webhook have their credentials.
3. Save and **Publish**.
4. Try it with the message "necesito 3 macetas" ("I need 3 flower pots"). From a contact who is
   not a customer it goes to the classifier; from a customer it is labeled an order without AI.
5. Export back: `pnpm --filter @smartops/api n8n:export`, Prettier and
   `pnpm --filter @smartops/api test -- n8n-workflows`.

## Security

- The n8n editor is NEVER publicly exposed (phase 12: only through a tunnel / VPN or an allowed
  IP, on top of the n8n login).
- n8n does not touch the database: everything goes through the internal API with
  `X-Internal-Api-Key`.
