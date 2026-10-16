import {
  Activity,
  FlaskConical,
  ListTodo,
  LayoutDashboard,
  MessagesSquare,
  MonitorCog,
  Package,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Messages } from "next-intl";
import type { SessionUser } from "@/lib/api-client";

export interface NavItem {
  href: string;
  /** Key in the "nav" messages. */
  labelKey: Exclude<keyof Messages["nav"], "sections" | "more" | "moreSections">;
  icon: LucideIcon;
  /** Shown in the phone's bottom bar (the rest go under "More"). */
  primary: boolean;
  adminOnly?: boolean;
  /** Admins, plus everyone in the public demo, read-only (System status, ADR-032 D1). */
  adminOrDemo?: boolean;
  /** Only in the public demo (DEMO_MODE, phase 9 M8). */
  demoOnly?: boolean;
}

/**
 * Phase 15 (ADR-032): Home · To do · Conversations · Catalog in the phone's bottom bar; Activity,
 * Rules, Users, System status and Try under "More". To do carries the ONLY counter.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "home", icon: LayoutDashboard, primary: true },
  { href: "/todo", labelKey: "todo", icon: ListTodo, primary: true },
  { href: "/conversations", labelKey: "conversations", icon: MessagesSquare, primary: true },
  { href: "/catalog", labelKey: "catalog", icon: Package, primary: true },
  { href: "/activity", labelKey: "activity", icon: Activity, primary: false },
  { href: "/rules", labelKey: "rules", icon: SlidersHorizontal, primary: false },
  { href: "/users", labelKey: "users", icon: Users, primary: false, adminOnly: true },
  { href: "/system", labelKey: "system", icon: MonitorCog, primary: false, adminOrDemo: true },
  {
    href: "/try",
    labelKey: "try",
    icon: FlaskConical,
    primary: false,
    demoOnly: true,
  },
];

export function navFor(user: SessionUser | null, demo = false): NavItem[] {
  const admin = user?.role === "admin";
  return NAV_ITEMS.filter(
    (item) =>
      (!item.adminOnly || admin) &&
      (!item.adminOrDemo || admin || demo) &&
      (!item.demoOnly || demo),
  );
}

/** Whether a user sees System status (the page checks it too). */
export const canSeeSystem = (user: SessionUser | null, demo: boolean) =>
  user?.role === "admin" || demo;

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  // A review detail belongs to To do (its list moved there in phase 15).
  if (href === "/todo" && pathname.startsWith("/reviews/")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * A chat (/conversations/<id>, not the opted-out list): the one page that fills the whole screen
 * (phase 16 M1): the shell stretches its content to the bottom so the reply box stays at the
 * bottom of the viewport and the messages stack from it, like WhatsApp.
 */
export function isChatPath(pathname: string): boolean {
  return /^\/conversations\/(?!opted-out(?:\/|$))[^/]+\/?$/.test(pathname);
}
