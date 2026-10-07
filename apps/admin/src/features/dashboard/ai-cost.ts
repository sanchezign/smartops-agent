/**
 * What the AI cost card says (phase 14, point 1). In the public demo (DEMO_MODE) the figures are
 * seeded and the AI is simulated: the card is marked "sample data" and shows no budget line
 * (a limit and a spend that look real would mislead). Everywhere else it shows the real spend
 * against its limits. Pure — unit tested.
 */
export function aiCostMode(demo: unknown): "sample" | "live" {
  return demo ? "sample" : "live";
}
