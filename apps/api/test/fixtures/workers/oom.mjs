// Test worker for the heap limit: allocates until V8 aborts the thread.
const keep = [];
for (;;) keep.push(new Array(1_000_000).fill({ x: Math.random() }));
