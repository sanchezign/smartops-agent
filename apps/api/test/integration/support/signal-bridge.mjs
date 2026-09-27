// Startup smoke tests (phase 10 M3) on Windows: there are no POSIX signals there —
// child.kill("SIGTERM") ends the process WITHOUT running its handlers. The test sends the
// signal name over IPC and this preload re-emits it, so the process's own SIGTERM / SIGINT
// handlers (graceful shutdown) run exactly as they would on Linux. Never loaded in production.
process.on("message", (message) => {
  if (message === "SIGTERM" || message === "SIGINT") process.emit(message);
});
// The IPC channel must not keep the process alive on its own.
process.channel?.unref();
