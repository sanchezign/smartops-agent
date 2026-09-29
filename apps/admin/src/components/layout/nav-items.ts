import {
  Bell,
  FlaskConical,
  ClipboardCheck,
  LayoutDashboard,
  MessagesSquare,
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
  /** Only in the public demo (DEMO_MODE, phase 9 M8). */
  demoOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "home", icon: LayoutDashboard, primary: true },
  { href: "/revisiones", labelKey: "reviews", icon: ClipboardCheck, primary: true },
  { href: "/conversaciones", labelKey: "conversations", icon: MessagesSquare, primary: true },
  { href: "/catalogo", labelKey: "catalog", icon: Package, primary: true },
  { href: "/alertas", labelKey: "alerts", icon: Bell, primary: false },
  { href: "/reglas", labelKey: "rules", icon: SlidersHorizontal, primary: false },
  { href: "/usuarios", labelKey: "users", icon: Users, primary: false, adminOnly: true },
  {
    href: "/probar",
    labelKey: "try",
    icon: FlaskConical,
    primary: false,
    demoOnly: true,
  },
];

export function navFor(user: SessionUser | null, demo = false): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => (!item.adminOnly || user?.role === "admin") && (!item.demoOnly || demo),
  );
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
