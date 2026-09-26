import {
  Bell,
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
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Inicio", icon: LayoutDashboard, primary: true },
  { href: "/revisiones", label: "Revisiones", icon: ClipboardCheck, primary: true },
  { href: "/conversaciones", label: "Conversaciones", icon: MessagesSquare, primary: true },
  { href: "/catalogo", label: "Catálogo", icon: Package, primary: true },
  { href: "/alertas", label: "Alertas", icon: Bell, primary: false },
  { href: "/reglas", label: "Reglas", icon: SlidersHorizontal, primary: false },
  { href: "/usuarios", label: "Usuarios", icon: Users, primary: false, adminOnly: true },
];

export function navFor(user: SessionUser | null): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === "admin");
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
