"use client";

import { MoreVertical, Pause, Play, UserCheck, UserX } from "lucide-react";
import { useId, useState } from "react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useAuthStore } from "@/features/auth/store";
import { useConversationAction } from "../hooks";
import type { ConversationHeader } from "../types";

const PAUSE_OPTIONS = [
  { value: "30", label: "30 minutos" },
  { value: "120", label: "2 horas" },
  { value: "480", label: "8 horas" },
  { value: "none", label: "Hasta que lo reactive" },
] as const;

/** Pause / resume the bot for this chat, and record an opt-out / opt-in by hand. */
export function ChatActions({ conversation }: { conversation: ConversationHeader }) {
  const user = useAuthStore((s) => s.user);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [consent, setConsent] = useState<"opt-out" | "opt-in" | null>(null);
  const id = conversation.id;
  const contactId = conversation.contact.id;

  const pause = useConversationAction(
    (minutes: number | null) => ({ path: `/admin/conversations/${id}/pause`, body: { minutes } }),
    "Bot pausado: ahora atendés vos.",
  );
  const resume = useConversationAction(
    () => ({ path: `/admin/conversations/${id}/resume` }),
    "El bot vuelve a responder.",
  );

  const optedOut = conversation.contact.optOutAt !== null;
  return (
    <div className="flex flex-wrap gap-2">
      {conversation.mode === "human" ? (
        <Button
          className="min-h-11"
          disabled={resume.isPending}
          onClick={() => resume.mutate(undefined)}
        >
          <Play aria-hidden /> Reactivar el bot
        </Button>
      ) : (
        <Button variant="outline" className="min-h-11" onClick={() => setPauseOpen(true)}>
          <Pause aria-hidden /> Pausar el bot
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="size-11" aria-label="Más acciones">
            <MoreVertical aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {optedOut ? (
            user?.role === "admin" ? (
              <DropdownMenuItem onSelect={() => setConsent("opt-in")}>
                <UserCheck aria-hidden /> Registrar alta (vuelve a recibir mensajes)
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                Registrar un alta es solo para administradores
              </DropdownMenuItem>
            )
          ) : (
            <DropdownMenuItem onSelect={() => setConsent("opt-out")}>
              <UserX aria-hidden /> Registrar baja (no enviarle más mensajes)
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <PauseDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        pending={pause.isPending}
        onConfirm={(minutes) => pause.mutate(minutes, { onSuccess: () => setPauseOpen(false) })}
      />
      {consent ? (
        <ConsentDialog action={consent} contactId={contactId} onClose={() => setConsent(null)} />
      ) : null}
    </div>
  );
}

function PauseDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  pending: boolean;
  onConfirm(minutes: number | null): void;
}) {
  const [value, setValue] = useState<string>("120");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pausar el bot en este chat</DialogTitle>
          <DialogDescription>
            Mientras esté pausado el bot no le responde. Las listas de precios se siguen procesando
            y el equipo sigue recibiendo avisos.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={value} onValueChange={setValue} aria-label="Duración" className="gap-2">
          {PAUSE_OPTIONS.map((o) => (
            <Label
              key={o.value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={o.value} /> {o.label}
            </Label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            className="min-h-11"
            disabled={pending}
            onClick={() => onConfirm(value === "none" ? null : Number(value))}
          >
            Pausar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConsentDialog({
  action,
  contactId,
  onClose,
}: {
  action: "opt-out" | "opt-in";
  contactId: string;
  onClose(): void;
}) {
  const [reason, setReason] = useState("");
  const [source, setSource] = useState<"manual" | "off_whatsapp">("off_whatsapp");
  const reasonId = useId();
  const mutation = useConversationAction(
    () => ({
      path: `/admin/contacts/${contactId}/${action}`,
      body: { reason: reason.trim(), source },
    }),
    action === "opt-out" ? "Baja registrada: no se le envían más mensajes." : "Alta registrada.",
  );
  const optOut = action === "opt-out";
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{optOut ? "Registrar baja" : "Registrar alta"}</DialogTitle>
          <DialogDescription>
            {optOut
              ? "El sistema deja de enviarle mensajes automáticos, plantillas y avisos. Si te escribe, una persona igual puede responderle."
              : "Solo si el contacto pidió volver a recibir mensajes (por ejemplo, por teléfono). Queda registrado quién lo hizo y por qué."}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={source}
          onValueChange={(v) => setSource(v as typeof source)}
          aria-label="Cómo lo pidió"
          className="gap-2"
        >
          <Label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="off_whatsapp" /> Lo pidió fuera de WhatsApp
          </Label>
          <Label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="manual" /> Otro motivo
          </Label>
        </RadioGroup>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>Motivo (obligatorio)</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              optOut ? "Ej.: llamó y pidió que no le escribamos" : "Ej.: lo pidió por mail el 27/9"
            }
          />
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={optOut ? "destructive" : "default"}
            className="min-h-11"
            disabled={reason.trim().length < 3 || mutation.isPending}
            onClick={() => mutation.mutate(undefined, { onSuccess: onClose })}
          >
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
