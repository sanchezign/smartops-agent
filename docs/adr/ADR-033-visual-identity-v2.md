# ADR-033: Visual identity v2 — warm theme (tweakcn), Oxanium, the yellow rule kept

Date: 2026-10-15
Status: DRAFT (phase 16 M0; becomes "accepted" when the owner approves the M4 prototype). Replaces the **palette**
(ADR-029 §1), the **typography** (§3) and the **radius** (§4) of [ADR-029](ADR-029-panel-visual-identity.md). Keeps
ADR-029 §2 (the yellow rule, as amended by ADR-032), §5 and §6.

## Context

The owner chose a theme on tweakcn.com (shadcn/ui theme editor), exported as Tailwind v4 / oklch (a warm cream light
mode, a warm grey dark mode, an orange primary, Oxanium / Fira Code / Merriweather, radius 0.3 rem, two-layer
shadows) and said the panel is "too camouflaged": names and the line that says what is waiting are easy to miss.

Measured on the exported theme as it is (WCAG 2, hex converted from oklch; the swatch sheet of M0 shows all of it):

- dark: white on `--primary` 2.80 (needs 4.5); light: `--muted-foreground` on `--card` 4.38, on `--muted` 3.98;
- `--input` (control borders, needs 3:1): 1.28 light, 1.48 dark; dark `--destructive` as text 3.62;
- a yellow among the chart colors (`chart-3` dark `#eab308`) and blue `accent` / `sidebar-accent` in dark;
- the dark primary `#f97316` is 1.75:1 from the safety yellow `#FFC400` (distance in OKLab 0.19): two bright warm
  fills with dark ink read as the same signal.

After the first swatch sheet the owner **replaced the orange primary with a khaki, `#a89667`** (oklch 0.678 0.067 89:
the same hue as the yellow, about a third of its chroma). White on it is 2.91:1, so two options were shown side by side
(swatch sheet v2):

- **K1:** dark `#a89667` with dark text (6.02), light `#857549` with white text (4.53). Its dark primary is **1.82:1** from
  the yellow, **below the 2.5:1 that D17 asks**: shown anyway, as the owner asked, to judge by eye.
- **K2:** `#857549` with white text in both modes (4.53); 2.83:1 from the yellow in both. As the focus ring it is
  3.86:1 on the dark background and 3.35:1 on the dark card.

The orange options (P1 `#f97316`, P2 `#ce4b00`) are discarded.

## Decision

1. **The theme is MAPPED, not pasted.** Tokens go into `apps/admin/src/app/globals.css` in **hex** (the contrast test
   parses hex; the source oklch is kept in a comment). Project tokens stay: `signal`, `signal-foreground`, `warning`,
   `surface`, `sidebar-muted`. Light and dark with the selector, as today.
2. **Minimal contrast adjustments, same hue** (all verified, see the swatch sheet):
   | Token                              | Theme                                                      | Adjusted                                                                                                                             | Why                                                                                 |
   | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
   | `--primary` (both modes)           | orange `#b45309` light / `#f97316` dark                    | **`#857549` + white 4.53** (owner: K2, 2026-10-15)                                                                                   | the owner's khaki; text contrast; 2.83:1 from the yellow (K1 dark failed D17: 1.82) |
   | light `--muted-foreground`         | `#78716c`                                                  | `#6f6863` (5.00 on card, 4.54 on muted)                                                                                              | 4.38 / 3.98                                                                         |
   | light / dark `--input`             | `#e4d9bc` / `#44403c`                                      | `#948c87` / `#726e6a`                                                                                                                | control borders ≥ 3:1                                                               |
   | dark `--destructive` (text)        | `#dc2626`                                                  | `#f1584e` (4.51 on card)                                                                                                             | 3.62                                                                                |
   | light `secondary-foreground`       | `#57534e`                                                  | `#4a3b33`                                                                                                                            | 4.45                                                                                |
   | ring, `chart-1`, `sidebar-primary` | the orange                                                 | from the primary: ring and `sidebar-primary` `#857549` (+ white); `chart-1` `#857549` light / `#a89667` dark (5.22 on the dark card) | everything that depended on the orange                                              |
   | charts                             | yellow in `chart-3` (dark) / `chart-5` (light), duplicates | `chart-1..5` distinct, none yellow, ≥ 3:1 on card                                                                                    | charts only use 1 and 2 today                                                       |
   | dark `accent`, `sidebar-accent`    | blue                                                       | warm grey                                                                                                                            | "no blue needed" (owner)                                                            |
   | dark `destructive`                 | `#dc2626`, then `#f1584e` (first pass)                     | **`#ff8a80`** (4.56 on its own 20 % tint over the card)                                                                              | the contrast test also checks the tinted backgrounds the panel draws (found in M4)  |
   | dark `sidebar-muted`               | `#a8a29e`                                                  | `#bdb7b2` (5.18 on `sidebar-accent`)                                                                                                 | 4.07 on the active nav item (found in M4)                                           |
3. **Light sidebar in light mode** (D2, as tweakcn); dark sidebar in dark mode. The yellow counter in the light
   sidebar keeps its ink frame (the yellow is 1.32:1 on `#f1e9da`; the frame is 14.5:1).
4. **The yellow rule of ADR-029 / ADR-032 stays: `#FFC400` means "waits for a person", nothing else.** New in this
   ADR: the **meta line of a To do card** ("Spreadsheet · 19 min ago · 1 pending", a real link to `/todo?run=<runId>`)
   uses it, because it says what waits. Dark: yellow text, underlined (9.5:1 on the card). Light: ink text with a thick
   yellow underline (the yellow text would be 1.46:1). The primary button is never yellow; the yellow is never the focus
   ring or a chart colour. A test forbids any non-`signal` token in the yellow band and requires the primary to be at
   least 2.5:1 from the yellow in both themes.
5. **Typography.** Oxanium (OFL; variable `wght` 200–800; digits are tabular by default: all ten advance widths are
   equal, so amounts and counters align without `tnum`) and Fira Code (OFL) replace Archivo and Geist Mono, self-hosted
   at build time by `next/font` (CSP `font-src 'self'`; no Google Fonts at runtime). Merriweather is NOT loaded: nothing
   uses a serif. Oxanium has no `→` glyph (the browser falls back). **Variants A (Oxanium everywhere) and B (Oxanium
   headings + IBM Plex Sans text and lists) are shown on the M4 prototype; the owner chooses by looking.** The text
   font of B, if chosen, is IBM Plex Sans (OFL, tabular digits by default, full Spanish coverage). The losing variant
   leaves no code behind. The decision is recorded here when taken.
6. **Radius 0.3 rem; shadows of the theme** (two layers, tinted toward the background hue), through the current
   multiplicative radius scale (`sm` 2.9 px … `lg` 4.8 px), not tweakcn's `calc(radius - 4px)` (which would give 0.8 px).
7. **Emphasis (M5):** supplier / contact names larger and bold in To do, Catalog and Conversations; contact-kind chips
   inverted (dark: white fill, black letters; light: the reverse; the three kinds identical); amounts and product
   names in review questions in a heavier weight. No new colours.

## Consequences

- `test/contrast.test.ts` keeps its pairs and gains: the yellow-band rule, the primary-vs-yellow rule, light-sidebar
  pairs and the counter's frame on it.
- The prototype (Home + To do) is reviewed before the rest of the panel is touched (the owner's rule).
- Screenshots and README media are regenerated at the end of phase 16.
- Out of scope: APCA (the standard that is measured and tested here is WCAG 2 AA).
