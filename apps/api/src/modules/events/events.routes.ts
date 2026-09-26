import express, { type Router } from "express";
import { errors } from "../../common/errors/app-error.js";
import type { Logger } from "../../common/logger.js";
import { createRequireAuth, currentUser } from "../auth/auth-http.js";
import type { AuthService } from "../auth/auth.service.js";
import { TooManyStreamsError, type EventHub, type HubMessage } from "./event-hub.js";

/**
 * GET /api/v1/events — Server-Sent Events for the panel (phase 9 M4, ADR-020).
 *
 * The panel opens it with fetch() and the in-memory Bearer (EventSource cannot send headers).
 * The stream carries event TYPES and ids only; the panel refetches what changed through the
 * normal authenticated API, so role rules keep applying. Every heartbeat re-checks the
 * session: logout-all, expiry, deactivation or a role change end the stream (event "session")
 * and the panel reconnects with a fresh token — or goes to the login.
 */
export function createEventsRouter(options: {
  hub: EventHub;
  auth: Pick<AuthService, "authenticate" | "checkSession">;
  heartbeatMs: number;
  logger: Logger;
}): Router {
  const router = express.Router();
  router.use(createRequireAuth(options.auth.authenticate));

  router.get("/", (req, res, next) => {
    const user = currentUser(res);
    let seq = 0;
    const write = (event: string, data: unknown) => {
      seq += 1;
      res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let unsubscribe: () => void;
    try {
      unsubscribe = options.hub.subscribe({
        userId: user.userId,
        send: (message: HubMessage) =>
          message.kind === "resync" ? write("resync", {}) : write("events", message.events),
        end: () => close("server_restart"),
      });
    } catch (err) {
      if (err instanceof TooManyStreamsError) return next(errors.tooManyStreams());
      return next(err);
    }

    res.status(200).set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Reverse proxies (Caddy / nginx) must not buffer the stream.
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");
    write("ready", { heartbeatMs: options.heartbeatMs });

    let closed = false;
    const close = (reason: string | null) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (reason) {
        write("session", { reason });
        res.end();
      }
    };

    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const session = await options.auth.checkSession(user.sessionId);
          if (closed) return;
          if (!session) return close("ended");
          if (session.role !== user.role) return close("role_changed");
          res.write(": ping\n\n");
        } catch (err) {
          // A DB hiccup must not kill the stream; the next heartbeat retries.
          options.logger.warn({ err }, "event stream heartbeat check failed");
        }
      })();
    }, options.heartbeatMs);

    req.on("close", () => close(null));
  });

  return router;
}
