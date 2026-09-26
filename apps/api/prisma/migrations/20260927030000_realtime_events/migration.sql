-- Real-time events for the panel (phase 9 M4, ADR-020).
--
-- Triggers publish WHAT changed (type + ids + status), never content, on the channel
-- "smartops_events". pg_notify is transactional: listeners receive it only after COMMIT, and
-- a rolled-back change is never announced. Every writer (API, worker, CLI) is covered because
-- the database emits it. Prisma does not model triggers: KEEP THEM when editing these tables.
--
-- Payloads stay far below NOTIFY's 8000-byte limit: ids only; the catalog trigger is
-- STATEMENT-level with distinct supplier ids capped at 50 (a 2,000-row ingest = 1 event).

CREATE OR REPLACE FUNCTION smartops_notify(payload jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('smartops_events', payload::text);
END;
$$;

-- messages: created / status, transcript, media link, edits and revokes.
CREATE OR REPLACE FUNCTION smartops_messages_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'message.created',
      'conversationId', NEW.conversation_id,
      'messageId', NEW.id,
      'direction', NEW.direction));
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.transcript IS DISTINCT FROM OLD.transcript
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW.media_file_id IS DISTINCT FROM OLD.media_file_id
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'message.updated',
      'conversationId', NEW.conversation_id,
      'messageId', NEW.id,
      'status', NEW.status));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER messages_realtime
  AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION smartops_messages_event();

-- media_files: a photo / audio / document became available (or failed) → its message.
CREATE OR REPLACE FUNCTION smartops_media_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  msg record;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT id, conversation_id INTO msg FROM messages WHERE media_file_id = NEW.id;
    IF FOUND THEN
      PERFORM smartops_notify(jsonb_build_object(
        'type', 'message.updated',
        'conversationId', msg.conversation_id,
        'messageId', msg.id,
        'mediaStatus', NEW.status));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER media_files_realtime
  AFTER UPDATE ON media_files
  FOR EACH ROW EXECUTE FUNCTION smartops_media_event();

-- conversations: bot / human mode.
CREATE OR REPLACE FUNCTION smartops_conversations_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode OR NEW.human_until IS DISTINCT FROM OLD.human_until THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'conversation.updated',
      'conversationId', NEW.id,
      'mode', NEW.mode));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER conversations_realtime
  AFTER UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION smartops_conversations_event();

-- contacts: opt-out / opt-in.
CREATE OR REPLACE FUNCTION smartops_contacts_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opt_out_at IS DISTINCT FROM OLD.opt_out_at THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'contact.updated',
      'contactId', NEW.id));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER contacts_realtime
  AFTER UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION smartops_contacts_event();

-- review_items: new or resolved.
CREATE OR REPLACE FUNCTION smartops_review_items_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'review.changed',
      'reviewId', NEW.id,
      'status', NEW.status));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER review_items_realtime
  AFTER INSERT OR UPDATE ON review_items
  FOR EACH ROW EXECUTE FUNCTION smartops_review_items_event();

-- ingestion_runs: pipeline progress (dashboard).
CREATE OR REPLACE FUNCTION smartops_ingestion_runs_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'run.changed',
      'runId', NEW.id,
      'status', NEW.status));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ingestion_runs_realtime
  AFTER INSERT OR UPDATE ON ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION smartops_ingestion_runs_event();

-- alerts: new / acknowledged.
CREATE OR REPLACE FUNCTION smartops_alerts_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'alert.changed',
      'alertId', NEW.id,
      'severity', NEW.severity));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER alerts_realtime
  AFTER INSERT OR UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION smartops_alerts_event();

-- products: ONE event per statement with the suppliers touched (bulk ingests).
CREATE OR REPLACE FUNCTION smartops_products_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  suppliers jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(DISTINCT supplier_id), '[]'::jsonb) INTO suppliers
    FROM (SELECT supplier_id FROM changed_rows LIMIT 5000) r;
  IF jsonb_array_length(suppliers) > 0 THEN
    PERFORM smartops_notify(jsonb_build_object(
      'type', 'catalog.changed',
      'supplierIds', CASE WHEN jsonb_array_length(suppliers) > 50 THEN '[]'::jsonb ELSE suppliers END));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER products_realtime_insert
  AFTER INSERT ON products
  REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION smartops_products_event();
CREATE TRIGGER products_realtime_update
  AFTER UPDATE ON products
  REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION smartops_products_event();
