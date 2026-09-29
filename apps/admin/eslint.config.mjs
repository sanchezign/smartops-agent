import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import prettier from "eslint-config-prettier/flat";
import i18next from "eslint-plugin-i18next";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  prettier,
  // Phase 13 (ADR-024): no user-visible text outside the message catalogs. JSX text, string
  // expressions and attributes are checked; technical attributes and brand names are allowed.
  {
    files: ["src/**/*.tsx"],
    // Generated shadcn internals without visible text (chart keys, sonner class names).
    ignores: ["src/components/ui/chart.tsx", "src/components/ui/sonner.tsx"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-attributes": {
            exclude: [
              "className",
              "style",
              "type",
              "key",
              "id",
              "width",
              "height",
              "href",
              "src",
              "variant",
              "size",
              "align",
              "side",
              "orientation",
              "role",
              "name",
              "value",
              "defaultValue",
              "method",
              "autoComplete",
              "inputMode",
              "lang",
              "rel",
              "target",
              "referrerPolicy",
              "data-.*",
              "htmlFor",
              "dir",
              "position",
              "attribute",
              "defaultTheme",
              "dataKey",
              "nameKey",
              "stroke",
              "fill",
              "stopColor",
              "offset",
              "x1",
              "x2",
              "y1",
              "y2",
              "layout",
              "interval",
              "tickLine",
              "axisLine",
              "stackId",
              "curve",
              "accept",
              "aria-hidden",
              "aria-current",
              "aria-live",
              "aria-haspopup",
              "aria-controls",
              "aria-describedby",
              "aria-labelledby",
              "sizes",
              "loading",
              "decoding",
              "prefetch",
              "form",
              "scale",
              "domain",
              "autoCapitalize",
              "color",
              "tone",
              "who",
            ],
          },
          // Translation calls (t, tPages, tCommon.rich…) and state setters take keys / codes.
          callees: {
            exclude: ["t", "t\\.rich", "t[A-Z]\\w*", "t[A-Z]\\w*\\.rich", "set[A-Z]\\w*"],
          },
          // Route paths and action codes in props objects.
          "object-properties": { exclude: ["href", "action"] },
          words: {
            exclude: ["[0-9!-/:-@[-`{-~\s·—–…→←↑↓×•]+", "SmartOps", "WhatsApp", "[A-Z_-]+"],
          },
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-e2e/**",
      "e2e/report/**",
      "coverage/**",
      "e2e/results/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
