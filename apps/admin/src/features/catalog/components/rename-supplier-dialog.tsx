"use client";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRenameSupplier } from "../hooks";

/** Rename a supplier (admin). Later lists that state the new name are matched to it. */
export function RenameSupplierDialog({
  supplier,
  onClose,
}: {
  supplier: { id: string; name: string };
  onClose(): void;
}) {
  const [name, setName] = useState(supplier.name);
  const nameId = useId();
  const t = useTranslations("catalog");
  const rename = useRenameSupplier(onClose);
  const valid = name.trim().length >= 2;
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
          <DialogDescription>{t("renameBody")}</DialogDescription>
        </DialogHeader>
        <form
          id="rename-supplier"
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) rename.mutate({ id: supplier.id, name: name.trim() });
          }}
        >
          <Label htmlFor={nameId}>{t("name")}</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form="rename-supplier"
            className="min-h-11"
            disabled={!valid || rename.isPending}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
