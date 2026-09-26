import { ApiError } from "@/lib/api-client";

/** User-management errors → plain language (phase 9 M6). Pure. */
export function userErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "No se pudo completar. Probá de nuevo.";
  if (error.code === "CONFLICT" && /last active admin/i.test(error.message))
    return "No puede quedar el sistema sin un administrador activo. Nombrá otro administrador primero.";
  if (error.code === "CONFLICT" && /email/i.test(error.message))
    return "Ya hay un usuario con ese email.";
  if (error.code === "FORBIDDEN")
    return "No podés cambiar tu propio rol ni desactivarte: lo tiene que hacer otro administrador.";
  if (error.code === "VALIDATION_ERROR") {
    const details = Array.isArray(error.details) ? (error.details as { message?: string }[]) : [];
    const messages = details.map((d) => d.message).filter(Boolean);
    return messages.length > 0 ? messages.join(" ") : "Revisá los datos.";
  }
  return `No se pudo completar${error.requestId ? ` (código ${error.requestId})` : ""}.`;
}
