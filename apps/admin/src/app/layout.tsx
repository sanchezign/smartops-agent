import type { Metadata, Viewport } from "next";
import { Fira_Code, IBM_Plex_Sans, Oxanium } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Providers } from "@/components/providers";
import { THEME_COLOR } from "@/lib/theme-color";
import "./globals.css";

// ADR-033: Oxanium (variable wght, headings), IBM Plex Sans (text and lists) and Fira Code, self-hosted at build time
// by next/font (no Google Fonts at runtime).
const oxanium = Oxanium({ variable: "--font-oxanium", subsets: ["latin"] });
const plex = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const firaCode = Fira_Code({ variable: "--font-fira-code", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: "SmartOps", template: "%s · SmartOps" },
    description: t("description"),
    // Internal admin panel: never indexed.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    // ThemeColorSync (providers.tsx) follows the theme chosen in the user menu.
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Phase 13: the language resolved by src/i18n/request.ts (cookie → env → browser).
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={`${oxanium.variable} ${plex.variable} ${firaCode.variable} font-sans antialiased`}
      >
        {/* Rendered from a Server Component: inherits locale, messages and time zone. */}
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
