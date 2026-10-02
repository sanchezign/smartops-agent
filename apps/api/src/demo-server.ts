/**
 * The public demo on a 1 GB VM (ADR-025): the API, the worker and the in-process orchestrator in
 * ONE Node process. DEMO_MODE only; the real system runs `server.js` and `worker.js` apart.
 * Both entry points register with the shared shutdown coordinator, so a signal stops them
 * together and the process exits once.
 */
if (process.env.DEMO_MODE !== "true") {
  process.stderr.write(
    "demo-server.js only runs with DEMO_MODE=true (use server.js + worker.js)\n",
  );
  process.exit(1);
}
process.env.DEMO_ORCHESTRATOR ??= "internal";
process.env.N8N_DELIVERY_ENABLED ??= "true";

await import("./server.js");
await import("./worker.js");
