"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuthStore } from "@/features/auth/store";
import { cn } from "@/lib/utils";
import { isActive, navFor } from "./nav-items";
import { LiveIndicator } from "@/features/realtime/live-indicator";
import { StatusChips } from "@/features/realtime/status-chips";
import { useDemoInfo } from "@/features/demo/hooks";
import { LocaleSelect } from "@/features/locale/components/locale-select";
import { UserMenu } from "./user-menu";

/**
 * Panel shell (phase 9), MOBILE FIRST: on a phone a bottom bar with the 4 main sections + "Más"
 * (a sheet with the rest); from md up a fixed sidebar. Touch targets ≥ 44 px, a skip link, and
 * aria-current on the active section.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const demo = useDemoInfo().data ?? null;
  const items = navFor(user, demo !== null);
  const primary = items.filter((i) => i.primary);
  const more = items.filter((i) => !i.primary);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = more.some((i) => isActive(pathname, i.href));

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Saltar al contenido
      </a>

      {demo ? (
        <div className="relative z-40 bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-950 md:ml-60 dark:bg-amber-950 dark:text-amber-100">
          <strong>Modo demo</strong>: datos de ejemplo, sin WhatsApp real y sin costo.{" "}
          <Link href="/probar" className="font-medium underline underline-offset-2">
            Probar el sistema
          </Link>
        </div>
      ) : null}

      {/* Sidebar (tablet / desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-16 items-center px-5 text-lg font-semibold tracking-tight">
          SmartOps
        </div>
        <nav aria-label="Secciones" className="flex flex-1 flex-col gap-1 px-3">
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
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <item.icon className="size-5" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:ml-60 md:h-16 md:px-8">
        <span className="font-semibold tracking-tight md:hidden">SmartOps</span>
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
        aria-label="Secciones"
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
                  <item.icon className="size-5" aria-hidden />
                  {item.label}
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
                <Ellipsis className="size-5" aria-hidden />
                Más
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
              >
                <SheetHeader>
                  <SheetTitle>Más secciones</SheetTitle>
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
                        {item.label}
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
