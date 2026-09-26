"use client";

import { LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/store";

const ROLE_LABEL = { admin: "Administrador", operator: "Operador" } as const;

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  async function logout() {
    await api.logout();
    router.replace("/login");
  }

  async function logoutAll() {
    try {
      const sessions = await api.logoutAll();
      toast.success(`Cerraste ${sessions} ${sessions === 1 ? "sesión" : "sesiones"}.`);
    } finally {
      router.replace("/login");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Tu cuenta" className="size-11 rounded-full">
          <UserRound aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span>{user?.name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {user?.email} · {user ? ROLE_LABEL[user.role] : ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Tema
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden /> Claro
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden /> Oscuro
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden /> Según el dispositivo
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut aria-hidden /> Cerrar sesión
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={logoutAll}>
          <LogOut aria-hidden /> Cerrar todas mis sesiones
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
