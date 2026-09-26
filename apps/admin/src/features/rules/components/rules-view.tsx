"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/features/auth/api";
import { useAuthStore } from "@/features/auth/store";
import { useApiQuery } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-client";
import { parseNumberInput, toNumberInput } from "@/lib/number-input";
import { DAY_NAME, fromRows, toRows, type BusinessHours, type DayRow } from "../business-hours";
import { parseKeywords, parsePhones, SECTIONS, type Field, type Section } from "../fields";

type Settings = Record<string, unknown>;
type Draft = Record<string, unknown>;

/** Setting value → what the input shows. */
function toDraft(field: Field, value: unknown): unknown {
  switch (field.kind) {
    case "switch":
      return value === true;
    case "number":
      return toNumberInput(value as number | null);
    case "keywords":
      return ((value as string[] | undefined) ?? []).join(", ");
    case "phones":
      return ((value as string[] | undefined) ?? []).join("\n");
    case "hours":
      return {
        enabled: value !== null && value !== undefined,
        rows: toRows((value as BusinessHours) ?? null),
      };
  }
}

/** What the input shows → the value to store, or a message for the person. */
function fromDraft(
  field: Field,
  draft: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  switch (field.kind) {
    case "switch":
      return { ok: true, value: draft === true };
    case "number": {
      const raw = String(draft ?? "");
      if (field.nullable && raw.trim() === "") return { ok: true, value: null };
      return parseNumberInput(raw, field);
    }
    case "keywords":
      return parseKeywords(String(draft));
    case "phones":
      return parsePhones(String(draft));
    case "hours": {
      const h = draft as { enabled: boolean; rows: DayRow[] };
      return h.enabled ? fromRows(h.rows) : { ok: true, value: null };
    }
  }
}

export function RulesView() {
  const query = useApiQuery<{ settings: Settings }>(["settings"], "/admin/settings");
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  return (
    <>
      <PageHeader
        title="Reglas"
        description="Cómo se comporta el sistema, sin tocar código. Los cambios aplican al instante y quedan registrados."
      />
      {!isAdmin ? (
        <p className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <Lock className="size-4 shrink-0" aria-hidden />
          Podés ver las reglas; cambiarlas es solo para administradores.
        </p>
      ) : null}
      {query.isPending ? (
        <LoadingState rows={4} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {SECTIONS.map((section) => (
            <SectionCard
              key={section.id}
              section={section}
              settings={query.data.settings}
              readOnly={!isAdmin}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SectionCard({
  section,
  settings,
  readOnly,
}: {
  section: Section;
  settings: Settings;
  readOnly: boolean;
}) {
  const initial = () =>
    Object.fromEntries(section.fields.map((f) => [f.key, toDraft(f, settings[f.key])]));
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: async (changes: [string, unknown][]) => {
      for (const [key, value] of changes) {
        await api.request(`/admin/settings/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
      }
    },
    onSuccess: () => toast.success("Guardado."),
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.code === "VALIDATION_ERROR"
          ? `El valor no es válido: ${error.message}`
          : "No se pudo guardar.",
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const onSave = () => {
    const nextErrors: Record<string, string> = {};
    const changes: [string, unknown][] = [];
    for (const field of section.fields) {
      const parsed = fromDraft(field, draft[field.key]);
      if (!parsed.ok) {
        nextErrors[field.key] = parsed.message;
        continue;
      }
      if (JSON.stringify(parsed.value) !== JSON.stringify(settings[field.key] ?? null)) {
        changes.push([field.key, parsed.value]);
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (changes.length === 0) return void toast.info("No hay cambios para guardar.");
    save.mutate(changes);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{section.title}</h2>
        </CardTitle>
        <CardDescription>{section.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {section.fields.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={draft[field.key]}
            error={errors[field.key]}
            readOnly={readOnly}
            onChange={(value) => setDraft((d) => ({ ...d, [field.key]: value }))}
          />
        ))}
        {readOnly ? null : (
          <div className="flex justify-end">
            <Button className="min-h-11" onClick={onSave} disabled={save.isPending}>
              {save.isPending ? "Guardando…" : `Guardar "${section.title}"`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FieldControl({
  field,
  value,
  error,
  readOnly,
  onChange,
}: {
  field: Field;
  value: unknown;
  error?: string;
  readOnly: boolean;
  onChange(value: unknown): void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [helpId, error ? errorId : null].filter(Boolean).join(" ");
  const help = (
    <>
      <p id={helpId} className="text-xs text-muted-foreground">
        {field.help}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );

  if (field.kind === "switch") {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id}>{field.label}</Label>
          {help}
        </div>
        <Switch
          id={id}
          checked={value === true}
          disabled={readOnly}
          aria-describedby={describedBy}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }
  if (field.kind === "hours") {
    return (
      <HoursEditor
        value={value as { enabled: boolean; rows: DayRow[] }}
        readOnly={readOnly}
        onChange={onChange}
        help={help}
      />
    );
  }
  if (field.kind === "number") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{field.label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            inputMode={field.integer ? "numeric" : "decimal"}
            className="min-h-11 w-32"
            value={String(value ?? "")}
            disabled={readOnly}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.suffix ? (
            <span className="text-sm text-muted-foreground">{field.suffix}</span>
          ) : null}
        </div>
        {help}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{field.label}</Label>
      <Textarea
        id={id}
        rows={field.kind === "phones" ? 3 : 2}
        value={String(value ?? "")}
        disabled={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      {help}
    </div>
  );
}

function HoursEditor({
  value,
  readOnly,
  onChange,
  help,
}: {
  value: { enabled: boolean; rows: DayRow[] };
  readOnly: boolean;
  onChange(value: unknown): void;
  help: React.ReactNode;
}) {
  const id = useId();
  const setRow = (day: number, patch: Partial<DayRow>) =>
    onChange({ ...value, rows: value.rows.map((r) => (r.day === day ? { ...r, ...patch } : r)) });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id}>Usar horario de atención</Label>
          {help}
        </div>
        <Switch
          id={id}
          checked={value.enabled}
          disabled={readOnly}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      {value.enabled ? (
        <fieldset className="flex flex-col divide-y rounded-lg border" disabled={readOnly}>
          <legend className="sr-only">Días y horas</legend>
          {value.rows.map((row) => (
            <div key={row.day} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <label className="flex min-h-11 w-32 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={row.enabled}
                  onChange={(e) => setRow(row.day, { enabled: e.target.checked })}
                />
                {DAY_NAME[row.day]}
              </label>
              {row.enabled ? (
                <span className="flex items-center gap-2 text-sm">
                  <Input
                    type="time"
                    aria-label={`${DAY_NAME[row.day]}: abre`}
                    className="min-h-11 w-28"
                    value={row.open}
                    onChange={(e) => setRow(row.day, { open: e.target.value })}
                  />
                  a
                  <Input
                    type="time"
                    aria-label={`${DAY_NAME[row.day]}: cierra`}
                    className="min-h-11 w-28"
                    value={row.close}
                    onChange={(e) => setRow(row.day, { close: e.target.value })}
                  />
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">Cerrado</span>
              )}
            </div>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
