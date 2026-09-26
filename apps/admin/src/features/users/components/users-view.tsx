"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, MoreVertical, Unlock, UserPlus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/states";
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
import { formatRelative } from "@/lib/format";
import { userErrorMessage } from "../errors";

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

const ROLE_LABEL = { admin: "Administrador", operator: "Operador" } as const;

function useUserAction<T>(
  build: (input: T) => { path: string; method?: string; body?: unknown },
  success: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => {
      const { path, method = "POST", body } = build(input);
      return api.request<unknown>(`/admin/users${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    },
    onSuccess: () => toast.success(success),
    onError: (error) => toast.error(userErrorMessage(error)),
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

  if (me?.role !== "admin") return <ForbiddenState />;
  return (
    <>
      <PageHeader
        title="Usuarios"
        description="Quién entra al panel y qué puede hacer. Siempre queda al menos un administrador activo."
        actions={
          <Button className="min-h-11" onClick={() => setCreating(true)}>
            <UserPlus aria-hidden /> Nuevo usuario
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState rows={3} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card" aria-label="Usuarios">
          {query.data.users.map((u) => (
            <li key={u.id}>
              <UserRow user={u} isMe={u.id === me.id} onReset={() => setResetting(u)} />
            </li>
          ))}
        </ul>
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
  const patch = useUserAction(
    (body: { role?: PanelUser["role"]; active?: boolean }) => ({
      path: `/${user.id}`,
      method: "PATCH",
      body,
    }),
    "Usuario actualizado. Sus sesiones abiertas se cerraron.",
  );
  const unlock = useUserAction(() => ({ path: `/${user.id}/unlock` }), "Cuenta desbloqueada.");
  const revoke = useUserAction(
    () => ({ path: `/${user.id}/revoke-sessions` }),
    "Sesiones cerradas.",
  );
  const otherRole = user.role === "admin" ? "operator" : "admin";

  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{user.name}</span>
          {isMe ? <Badge variant="outline">Vos</Badge> : null}
          <Badge variant={user.role === "admin" ? "default" : "secondary"}>
            {ROLE_LABEL[user.role]}
          </Badge>
          {!user.active ? <Badge variant="outline">Desactivado</Badge> : null}
          {locked ? <Badge variant="destructive">Bloqueado</Badge> : null}
        </span>
        <span className="truncate text-sm text-muted-foreground">
          {user.email} ·{" "}
          {user.lastLoginAt ? `entró ${formatRelative(user.lastLoginAt)}` : "nunca entró"}
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            aria-label={`Acciones para ${user.name}`}
          >
            <MoreVertical aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isMe ? (
            <DropdownMenuItem disabled>Tu rol lo cambia otro administrador</DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => patch.mutate({ role: otherRole })}>
                Cambiar a {ROLE_LABEL[otherRole].toLowerCase()}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => patch.mutate({ active: !user.active })}>
                {user.active ? "Desactivar" : "Reactivar"}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onReset}>
            <KeyRound aria-hidden /> Nueva contraseña
          </DropdownMenuItem>
          {locked ? (
            <DropdownMenuItem onSelect={() => unlock.mutate(undefined)}>
              <Unlock aria-hidden /> Desbloquear
            </DropdownMenuItem>
          ) : null}
          {!isMe ? (
            <DropdownMenuItem onSelect={() => revoke.mutate(undefined)}>
              <LogOut aria-hidden /> Cerrar sus sesiones
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
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Contraseña</Label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Mínimo 15 caracteres. Una frase de varias palabras es lo mejor (por ejemplo, &ldquo;el mate
        de la tarde en la ferretería&rdquo;). Pasásela a la persona por un canal seguro.
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
  const create = useUserAction(() => ({ path: "", body: form }), "Usuario creado.");
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo usuario</DialogTitle>
          <DialogDescription>
            Un operador resuelve productos y conversaciones; un administrador, además, reglas,
            listas enteras y usuarios.
          </DialogDescription>
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
            <Label htmlFor={ids.name}>Nombre</Label>
            <Input
              id={ids.name}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.email}>Email</Label>
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
            aria-label="Rol"
            className="flex gap-4"
          >
            {(["operator", "admin"] as const).map((r) => (
              <Label key={r} className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value={r} /> {ROLE_LABEL[r]}
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
            Cancelar
          </Button>
          <Button type="submit" form="create-user" className="min-h-11" disabled={create.isPending}>
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: PanelUser; onClose(): void }) {
  const [password, setPassword] = useState("");
  const id = useId();
  const reset = useUserAction(
    () => ({ path: `/${user.id}/reset-password`, body: { password } }),
    "Contraseña cambiada. Sus sesiones abiertas se cerraron.",
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva contraseña para {user.name}</DialogTitle>
          <DialogDescription>
            Se cierran todas sus sesiones abiertas: va a tener que entrar de nuevo.
          </DialogDescription>
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
            Cancelar
          </Button>
          <Button
            type="submit"
            form="reset-password"
            className="min-h-11"
            disabled={reset.isPending}
          >
            Cambiar contraseña
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
