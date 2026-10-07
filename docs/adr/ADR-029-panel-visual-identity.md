# ADR-029: Panel visual identity — "Señal" (graphite, one safety yellow for what needs a person)

Date: 2026-10-07
Status: accepted (the owner's decision, 2026-10-07, phase 14). Refines ADR-024 (panel i18n) only in that every new
visible text still lives in the message catalogs.

## Context

The panel looked like the default shadcn kit: neutral grey, one thin outline for everything, seven identical
cards on the Home, no hierarchy between "waiting for a person" and "just information". The owner could not tell list
items apart (Conversations, Catalog, Alerts) and wanted a professional, distinctive look. Three directions were
explored on a local trial branch (`design/phase-14-exploration`, never pushed: it holds ~38 MB of screenshots and the
repository is going public); the owner chose **Señal**. The reviewer's four reference sketches were discarded.

SmartOps is the operations desk of a hardware wholesaler. The panel's first job is triage — _what is waiting for a
person right now_ — and its second is trust: seeing that prices were updated without anyone touching them.

## Decision

1. **Palette (tokens in `apps/admin/src/app/globals.css`, light / dark):** concrete `#ECECEA` / asphalt `#1B1C1F`
   background, cards `#FFFFFF` / `#25272B`, graphite ink `#1C1D20` / `#F1F1EE`, graphite sidebar rail in both themes,
   borders 1.5 px. New tokens: `signal`, `signal-foreground`, `warning`, `surface`. Control borders (`--input`)
   reach 3:1 against their background (WCAG 1.4.11), text reaches 4.5:1.
2. **Safety yellow (`#FFC400`) means "waits for a person", and nothing else:**
   - the pending tiles of the Home when their count is above zero;
   - the Reviews / Alerts counters in the navigation;
   - the label of chats a person is handling.
     It is NOT used for: the active navigation item, the focus ring, chart bars, the demo banner, warnings (they use the
     `warning` token: dark amber text, no yellow fill), or any element whose count is zero.
     When EVERY row of a list waits for a person (Reviews, Alerts), the rows do not take the yellow: the counter of the
     tab / navigation does, and the rows use an ink frame plus an icon and the severity text. Colour is never the only
     signal.
3. **Typography:** Archivo, variable (`wdth` axis), self-hosted at build time by `next/font` (CSP `font-src 'self'`;
   no CDN). Headings at 118 % width, weight 750; text at 100 %; tabular figures for numbers. Geist Sans is removed,
   Geist Mono stays.
4. **Cards and lists:** one separated, framed row per item (name, kind of contact as a text label, last message, time);
   no facts joined with " · ". Radius 6 px.
5. **Dark theme and phone get the same care as the light desktop:** asphalt (not black), same yellow scarcity; every
   milestone of phase 14 is checked with axe in light / dark and desktop / phone.
6. **Currency:** the currency belongs to the CONTENT, not to the panel language. While the demo content is Uruguayan
   (before M5) pesos show as "UYU 15.76" in English so they are not mistaken for dollars; Spanish keeps "$ 15,76".
   With the English content of M5 (USD) it shows "$15.76".

## Consequences

- A test computes the WCAG contrast of every token pair (light and dark) from `globals.css`, so a palette edit cannot
  silently break AA — axe alone does not check control borders (1.4.11).
- Archivo replaces Geist Sans: the page weighs a little more (one variable font file, `latin` subset).
- The yellow rules are reviewed at every milestone; a screen that spends yellow elsewhere is a bug.
- Screenshots of the exploration stay local; the README gets a few optimized WebP images at the end of phase 14.
