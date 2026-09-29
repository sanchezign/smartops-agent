"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Approve / reject bar shared by every resolver. Sticky at the bottom on phones (thumb reach,
 * above the bottom navigation); rejecting asks for an optional note (it goes to the audit log).
 */
export function ResolveActions({
  approveLabel,
  rejectLabel,
  onApprove,
  onReject,
  pending,
  disabled,
  error,
}: {
  approveLabel: string;
  rejectLabel?: string;
  onApprove(): void;
  onReject(note: string): void;
  pending: boolean;
  disabled?: boolean;
  error?: string | null;
}) {
  const t = useTranslations("reviews.actions");
  const [note, setNote] = useState("");
  const reject = rejectLabel ?? t("reject");
  const [open, setOpen] = useState(false);
  const noteId = useId();

  return (
    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:backdrop-blur-none">
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              className="h-auto min-h-11 whitespace-normal"
              disabled={pending}
            >
              <X aria-hidden /> {reject}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{reject}</DialogTitle>
              <DialogDescription>{t("rejectHint")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={noteId}>{t("note")}</Label>
              <Textarea
                id={noteId}
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("notePlaceholder")}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" className="min-h-11">
                  {t("back")}
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                className="min-h-11"
                disabled={pending}
                onClick={() => {
                  onReject(note.trim());
                  setOpen(false);
                }}
              >
                {t("confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          className="h-auto min-h-11 whitespace-normal"
          onClick={onApprove}
          disabled={pending || disabled}
        >
          <Check aria-hidden /> {pending ? t("saving") : approveLabel}
        </Button>
      </div>
    </div>
  );
}
