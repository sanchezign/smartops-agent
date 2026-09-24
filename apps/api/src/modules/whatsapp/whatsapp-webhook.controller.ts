import type { RequestHandler } from "express";
import { errors } from "../../common/errors/app-error.js";
import { getValidated } from "../../common/middleware/validate.js";
import type { verifyQuerySchema } from "./whatsapp-webhook.schemas.js";
import type { WhatsAppWebhookService } from "./whatsapp-webhook.service.js";

export function createWhatsAppWebhookController(service: WhatsAppWebhookService): {
  verify: RequestHandler;
  receive: RequestHandler;
} {
  return {
    verify: (_req, res) => {
      const query = getValidated<typeof verifyQuerySchema>(res, "query");
      const challenge = service.verifySubscription({
        mode: query["hub.mode"],
        token: query["hub.verify_token"],
        challenge: query["hub.challenge"],
      });
      // Meta expects the challenge echoed back as the plain-text body.
      res.status(200).type("text/plain").send(challenge);
    },

    receive: async (req, res) => {
      // express.raw() leaves a Buffer only for Content-Type: application/json.
      if (!Buffer.isBuffer(req.body)) {
        throw errors.badRequest("Expected an application/json body");
      }
      await service.receive({
        rawBody: req.body,
        signature: req.get("x-hub-signature-256"),
        log: req.log,
      });
      res.sendStatus(200);
    },
  };
}
