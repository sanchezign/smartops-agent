"use client";

import { LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
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
import { useDemoInfo } from "@/features/demo/hooks";
import { isPublicDemoAccount } from "@/features/demo/public-account";
import { useChangeLocale } from "@/features/locale/hooks";
import { LOCALE_NAMES, LOCALES, isAppLocale } from "@/i18n/locales";

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const locale = useLocale();
  const tLocale = useTranslations("locale");
  const t = useTranslations("userMenu");
  const changeLocale = useChangeLocale();
  // The public demo operator is shared by every visitor: no account-wide actions (phase 12).
  const shared = isPublicDemoAccount(useDemoInfo().data, user?.email);

  async function logout() {
    await api.logout();
    router.replace("/login");
  }

  async function logoutAll() {
    try {
      const sessions = await api.logoutAll();
      toast.success(t("loggedOutAll", { count: sessions }));
    } finally {
      router.replace("/login");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("account")}
          className="size-11 rounded-full"
        >
          <UserRound aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span>{user?.name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {user?.email} · {user ? t(`roles.${user.role}`) : ""}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("theme")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden /> {t("light")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden /> {t("dark")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden /> {t("system")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {tLocale("label")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isAppLocale(value)) void changeLocale(value);
          }}
        >
          {LOCALES.map((value) => (
            <DropdownMenuRadioItem key={value} value={value} lang={value}>
              {LOCALE_NAMES[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut aria-hidden /> {t("logout")}
        </DropdownMenuItem>
        {!shared && (
          <DropdownMenuItem onSelect={logoutAll}>
            <LogOut aria-hidden /> {t("logoutAll")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
