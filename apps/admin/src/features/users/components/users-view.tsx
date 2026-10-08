"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MoreVertical, Unlock, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/states";
import { RowList, rowClass } from "@/components/list-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { api } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/store";
import { useApiQuery } from "@/hooks/use-api";
import { useFormat } from "@/lib/use-format";
import { userErrorKey } from "../errors";

export interface PanelUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator";
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  lockedUntil: string | null;
}

const ROLES = ["operator", "admin"] as const;

function useUserAction<T>(
  build: (input: T) => { path: string; method?: string; body?: unknown },
  success: string,
) {
  const queryClient = useQueryClient();
  const t = useTranslations("users.errors");
  const tIssues = useTranslations("users.passwordIssues");
  return useMutation({
    mutationFn: (input: T) => {
      const { path, method = "POST", body } = build(input);
      return api.request<unknown>(`/admin/users${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    onSuccess: () => toast.success(success),
    onError: (error) => {
      const { key, params, issues, details } = userErrorKey(error);
      const lines = [...(issues ?? []).map((i) => tIssues(i)), ...(details ?? [])];
      toast.error(lines.length > 0 ? lines.join(" ") : t(key, params));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function UsersView() {
  const me = useAuthStore((s) => s.user);
  const query = useApiQuery<{ users: PanelUser[] }>(["users"], "/admin/users", {
    enabled: me?.role === "admin",
  });
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<PanelUser | null>(null);
  const t = useTranslations("users");
  const tPages = useTranslations("pages");

  if (me?.role !== "admin") return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title={tPages("users")}
        description={t("description")}
        actions={
          <Button className="min-h-11" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden /> {t("newUser")}
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <RowList aria-label={t("listLabel")}>
          {query.data.users.map((u) => (
            <li key={u.id}>
              <UserRow user={u} isMe={u.id === me.id} onReset={() => setResetting(u)} />
            </li>
          ))}
        </RowList>
      )}
      {creating ? <CreateUserDialog onClose={() => setCreating(false)} /> : null}
      {resetting ? (
        <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
      ) : null}
    </>
  );
}

function UserRow({ user, isMe, onReset }: { user: PanelUser; isMe: boolean; onReset(): void }) {
  const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();
  const t = useTranslations("users");
  const { formatRelative } = useFormat();
  const patch = useUserAction(
    (body: { role?: PanelUser["role"]; active?: boolean }) => ({
      path: `/${user.id}`,
      method: "PATCH",
      body,
    }),
    t("updated"),
  );
  const unlock = useUserAction(() => ({ path: `/${user.id}/unlock` }), t("unlocked"));
  const revoke = useUserAction(
    () => ({ path: `/${user.id}/revoke-sessions` }),
    t("sessionsClosed"),
  );
  const otherRole = user.role === "admin" ? "operator" : "admin";

  return (
    <div className={rowClass(false, false)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{user.name}</span>
          {isMe ? <Badge variant="outline">{t("you")}</Badge> : null}
          <Badge variant={user.role === "admin" ? "default" : "secondary"}>
            {t(`roles.${user.role}`)}
          </Badge>
          {!user.active ? <Badge variant="outline">{t("deactivated")}</Badge> : null}
          {locked ? <Badge variant="destructive">{t("locked")}</Badge> : null}
        </span>
        <span className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span className="break-all">{user.email}</span>
          <span>
            {user.lastLoginAt
              ? t("lastLogin", { when: formatRelative(user.lastLoginAt) })
              : t("neverLoggedIn")}
          </span>
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            aria-label={t("actionsFor", { name: user.name })}
          >
            <MoreVertical aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isMe ? (
            <DropdownMenuItem disabled>{t("ownRoleHint")}</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => patch.mutate({ role: otherRole })}>
                {otherRole === "admin" ? t("changeToAdmin") : t("changeToOperator")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => patch.mutate({ active: !user.active })}>
                {user.active ? t("deactivate") : t("reactivate")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onReset}>
            <KeyRound aria-hidden /> {t("newPassword")}
          </DropdownMenuItem>
          {locked ? (
            <DropdownMenuItem onSelect={() => unlock.mutate(undefined)}>
              <Unlock aria-hidden /> {t("unlock")}
            </DropdownMenuItem>
          ) : null}
          {!isMe ? (
            <DropdownMenuItem onSelect={() => revoke.mutate(undefined)}>
              <LogOut aria-hidden /> {t("revokeSessions")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PasswordField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange(v: string): void;
}) {
  const t = useTranslations("users");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("password")}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t("passwordHelp")}
      </p>
    </div>
  );
}

function CreateUserDialog({ onClose }: { onClose(): void }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    role: "operator" as PanelUser["role"],
    password: "",
  });
  const ids = { name: useId(), email: useId(), password: useId() };
  const t = useTranslations("users");
  const create = useUserAction(() => ({ path: "", body: form }), t("created"));
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createBody")}</DialogDescription>
        </DialogHeader>
        <form
          id="create-user"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined, { onSuccess: onClose });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.name}>{t("name")}</Label>
            <Input
              id={ids.name}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.email}>{t("email")}</Label>
            <Input
              id={ids.email}
              type="email"
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <RadioGroup
            value={form.role}
            onValueChange={(role) => setForm({ ...form, role: role as PanelUser["role"] })}
            aria-label={t("role")}
            className="flex gap-4"
          >
            {ROLES.map((r) => (
              <Label key={r} className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value={r} /> {t(`roles.${r}`)}
              </Label>
            ))}
          </RadioGroup>
          <PasswordField
            id={ids.password}
            value={form.password}
            onChange={(password) => setForm({ ...form, password })}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form="create-user" className="min-h-11" disabled={create.isPending}>
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: PanelUser; onClose(): void }) {
  const [password, setPassword] = useState("");
  const id = useId();
  const t = useTranslations("users");
  const reset = useUserAction(
    () => ({ path: `/${user.id}/reset-password`, body: { password } }),
    t("passwordChanged"),
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("resetTitle", { name: user.name })}</DialogTitle>
          <DialogDescription>{t("resetBody")}</DialogDescription>
        </DialogHeader>
        <form
          id="reset-password"
          onSubmit={(e) => {
            e.preventDefault();
            reset.mutate(undefined, { onSuccess: onClose });
          }}
        >
          <PasswordField id={id} value={password} onChange={setPassword} />
        </form>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form="reset-password"
            className="min-h-11"
            disabled={reset.isPending}
          >
            {t("changePassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
