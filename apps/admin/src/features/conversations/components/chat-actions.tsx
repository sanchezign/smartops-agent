"use client";

import { MoreVertical, Pause, Play, UserCheck, UserX } from "lucide-react";
import { useTranslations } from "next-intl";
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
  { value: "30", label: "pause30" },
  { value: "120", label: "pause120" },
  { value: "480", label: "pause480" },
  { value: "none", label: "pauseNone" },
] as const;

/** Pause / resume the bot for this chat, and record an opt-out / opt-in by hand. */
export function ChatActions({ conversation }: { conversation: ConversationHeader }) {
  const user = useAuthStore((s) => s.user);
  const t = useTranslations("conversations.actions");
  const [pauseOpen, setPauseOpen] = useState(false);
  const [consent, setConsent] = useState<"opt-out" | "opt-in" | null>(null);
  const id = conversation.id;
  const contactId = conversation.contact.id;

  const pause = useConversationAction(
    (minutes: number | null) => ({ path: `/admin/conversations/${id}/pause`, body: { minutes } }),
    t("paused"),
  );
  const resume = useConversationAction(
    () => ({ path: `/admin/conversations/${id}/resume` }),
    t("resumed"),
  );

  const optedOut = conversation.contact.optOutAt !== null;
  return (
    // A fragment: the chat header (a grid) places the main action and the "more" menu in its own
    // cells (phase 14 #8); dialogs are portals.
    <>
      {conversation.mode === "human" ? (
        <Button
          className="col-start-3 row-start-2 min-h-10 justify-self-end"
          disabled={resume.isPending}
          onClick={() => resume.mutate(undefined)}
        >
          <Play aria-hidden /> {t("resume")}
        </Button>
      ) : (
        <Button
          variant="outline"
          className="col-start-3 row-start-2 min-h-10 justify-self-end"
          onClick={() => setPauseOpen(true)}
        >
          <Pause aria-hidden /> {t("pause")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="col-start-3 row-start-1 size-10 justify-self-end"
            aria-label={t("more")}
          >
            <MoreVertical aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {optedOut ? (
            user?.role === "admin" ? (
              <DropdownMenuItem onSelect={() => setConsent("opt-in")}>
                <UserCheck aria-hidden /> {t("optInAction")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>{t("optInAdminOnly")}</DropdownMenuItem>
            )
          ) : (
            <DropdownMenuItem onSelect={() => setConsent("opt-out")}>
              <UserX aria-hidden /> {t("optOutAction")}
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
    </>
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
  const t = useTranslations("conversations.actions");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pauseTitle")}</DialogTitle>
          <DialogDescription>{t("pauseBody")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={value}
          onValueChange={setValue}
          aria-label={t("duration")}
          className="gap-2"
        >
          {PAUSE_OPTIONS.map((o) => (
            <Label
              key={o.value}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={o.value} /> {t(o.label)}
            </Label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            className="min-h-11"
            disabled={pending}
            onClick={() => onConfirm(value === "none" ? null : Number(value))}
          >
            {t("pauseConfirm")}
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
  const t = useTranslations("conversations.actions");
  const mutation = useConversationAction(
    () => ({
      path: `/admin/contacts/${contactId}/${action}`,
      body: { reason: reason.trim(), source },
    }),
    action === "opt-out" ? t("optOutDone") : t("optInDone"),
  );
  const optOut = action === "opt-out";
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{optOut ? t("optOutTitle") : t("optInTitle")}</DialogTitle>
          <DialogDescription>{optOut ? t("optOutBody") : t("optInBody")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={source}
          onValueChange={(v) => setSource(v as typeof source)}
          aria-label={t("howAsked")}
          className="gap-2"
        >
          <Label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="off_whatsapp" /> {t("offWhatsapp")}
          </Label>
          <Label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 has-[[data-state=checked]]:border-primary">
            <RadioGroupItem value="manual" /> {t("otherReason")}
          </Label>
        </RadioGroup>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>{t("reason")}</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={optOut ? t("optOutPlaceholder") : t("optInPlaceholder")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant={optOut ? "destructive" : "default"}
            className="min-h-11"
            disabled={reason.trim().length < 3 || mutation.isPending}
            onClick={() => mutation.mutate(undefined, { onSuccess: onClose })}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
