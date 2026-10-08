"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuthStore } from "@/features/auth/store";
import { cn } from "@/lib/utils";
import { isActive, navFor } from "./nav-items";
import { usePendingCounts } from "@/features/dashboard/hooks";
import { PendingBadge } from "./pending-badge";
import { LiveIndicator } from "@/features/realtime/live-indicator";
import { StatusChips } from "@/features/realtime/status-chips";
import { useDemoInfo } from "@/features/demo/hooks";
import { LocaleSelect } from "@/features/locale/components/locale-select";
import { UserMenu } from "./user-menu";

/**
 * Panel shell (phase 9), MOBILE FIRST: on a phone a bottom bar with the 4 main sections + "More"
 * (a sheet with the rest); from md up a fixed sidebar. Touch targets ≥ 44 px, a skip link, and
 * aria-current on the active section.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tShell = useTranslations("shell");
  const user = useAuthStore((s) => s.user);
  const demo = useDemoInfo().data ?? null;
  const items = navFor(user, demo !== null);
  const primary = items.filter((i) => i.primary);
  const more = items.filter((i) => !i.primary);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = more.some((i) => isActive(pathname, i.href));
  // What waits for a person, in the navigation (ADR-029): the only yellow of the shell.
  const pending = usePendingCounts();
  const countFor = (href: string) =>
    href === "/reviews" ? (pending?.reviews ?? 0) : href === "/alerts" ? (pending?.alerts ?? 0) : 0;
  const moreCount = more.reduce((sum, i) => sum + countFor(i.href), 0);

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        {tShell("skipToContent")}
      </a>

      {demo ? (
        <div className="relative z-40 bg-sidebar px-4 py-1.5 text-center text-[11px] leading-snug text-sidebar-foreground sm:text-xs md:ml-60">
          {tShell.rich("demoBanner", { strong: (chunks) => <strong>{chunks}</strong> })}{" "}
          <Link href="/try" className="font-medium underline underline-offset-2">
            {tShell("tryLink")}
          </Link>
        </div>
      ) : null}

      {/* Sidebar (tablet / desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <div className="font-display flex h-16 items-center px-5 text-lg">SmartOps</div>
        <nav aria-label={t("sections")} className="flex flex-1 flex-col gap-1 px-3">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <item.icon className="size-5" aria-hidden />
                {t(item.labelKey)}
                <PendingBadge count={countFor(item.href)} className="ml-auto" />
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:ml-60 md:h-16 md:px-8">
        <span className="font-display text-base md:hidden">SmartOps</span>
        <span className="hidden md:block" />
        <div className="flex items-center gap-3">
          <StatusChips />
          <LiveIndicator />
          {/* Language: visible in the top bar from tablets up; on phones, in the user menu. */}
          <LocaleSelect className="hidden md:flex" />
          <UserMenu />
        </div>
      </header>

      <main id="contenido" className="px-4 pb-28 pt-4 md:ml-60 md:px-8 md:pb-10 md:pt-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>

      {/* Bottom bar (phone) */}
      <nav
        aria-label={t("sections")}
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-5">
          {primary.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="relative">
                    <item.icon className="size-5" aria-hidden />
                    <PendingBadge
                      count={countFor(item.href)}
                      className="absolute -top-2.5 -right-3 min-w-4 px-1 text-[10px] leading-4"
                    />
                  </span>
                  {t(item.labelKey)}
                </Link>
              </li>
            );
          })}
          <li>
            <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
              <SheetTrigger
                className={cn(
                  "flex min-h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium",
                  moreActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <Ellipsis className="size-5" aria-hidden />
                  <PendingBadge
                    count={moreCount}
                    className="absolute -top-2.5 -right-3 min-w-4 px-1 text-[10px] leading-4"
                  />
                </span>
                {t("more")}
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
              >
                <SheetHeader>
                  <SheetTitle>{t("moreSections")}</SheetTitle>
                </SheetHeader>
                <ul className="flex flex-col gap-1 px-4 pb-6">
                  {more.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        aria-current={isActive(pathname, item.href) ? "page" : undefined}
                        className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-base hover:bg-accent"
                      >
                        <item.icon className="size-5" aria-hidden />
                        {t(item.labelKey)}
                        <PendingBadge count={countFor(item.href)} className="ml-auto" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </SheetContent>
            </Sheet>
          </li>
        </ul>
      </nav>
    </div>
  );
}
