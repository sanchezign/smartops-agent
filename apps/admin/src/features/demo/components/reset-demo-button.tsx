"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useResetDemo } from "../hooks";

/**
 * "Reset demo" with its confirmation (the original sample data comes back for EVERY visitor).
 * Used by "Try the system" and by the empty To do of the demo (phase 16 M2, ADR-034, D14).
 */
export function ResetDemoButton({
  onDone,
  variant = "outline",
}: {
  onDone?: () => void;
  variant?: "outline" | "default";
}) {
  const t = useTranslations("demo");
  const [open, setOpen] = useState(false);
  const reset = useResetDemo(() => {
    setOpen(false);
    onDone?.();
  });
  return (
    <>
      <Button variant={variant} className="min-h-11" onClick={() => setOpen(true)}>
        <RotateCcw aria-hidden /> {t("reset")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("resetTitle")}</DialogTitle>
            <DialogDescription>{t("resetBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button className="min-h-11" disabled={reset.isPending} onClick={() => reset.mutate()}>
              {reset.isPending ? t("resetting") : t("resetConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
