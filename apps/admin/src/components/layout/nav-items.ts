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
import type { SessionUser } from "@/lib/api-client";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the phone's bottom bar (the rest go under "Más"). */
  primary: boolean;
  adminOnly?: boolean;
  /** Only in the public demo (DEMO_MODE, phase 9 M8). */
  demoOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Inicio", icon: LayoutDashboard, primary: true },
  { href: "/revisiones", label: "Revisiones", icon: ClipboardCheck, primary: true },
  { href: "/conversaciones", label: "Conversaciones", icon: MessagesSquare, primary: true },
  { href: "/catalogo", label: "Catálogo", icon: Package, primary: true },
  { href: "/alertas", label: "Alertas", icon: Bell, primary: false },
  { href: "/reglas", label: "Reglas", icon: SlidersHorizontal, primary: false },
  { href: "/usuarios", label: "Usuarios", icon: Users, primary: false, adminOnly: true },
  {
    href: "/probar",
    label: "Probar el sistema",
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
