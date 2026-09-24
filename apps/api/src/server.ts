import { createApp } from "./app.js";

// Temporary: phase 2 replaces this with the Zod env module (src/config/env.ts)
// and the pino logger.
const port = Number(process.env.PORT ?? 4000);

const app = createApp();
const server = app.listen(port, () => {
  process.stdout.write(`api listening on http://localhost:${port}\n`);
});

function shutdown(signal: NodeJS.Signals): void {
  process.stdout.write(`${signal} received, shutting down\n`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
