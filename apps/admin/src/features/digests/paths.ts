/** Only in-panel paths from the API (never an arbitrary URL). */
export const isPanelPath = (path: string | null): path is string =>
  path !== null && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
