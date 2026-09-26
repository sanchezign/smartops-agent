import { z } from "zod";

/** Login form. The password policy lives in the API: here only "not empty". */
export const loginSchema = z.object({
  email: z.email("Ingresá un email válido").max(254),
  password: z.string().min(1, "Ingresá tu contraseña").max(1024),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** API error code → text for the person (the API messages are for logs, in English). */
export function loginErrorText(code: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "Email o contraseña incorrectos.";
    case "RATE_LIMITED":
      return "Demasiados intentos. Esperá unos minutos y probá de nuevo.";
    case "FORBIDDEN":
      return "La solicitud fue rechazada por seguridad. Recargá la página.";
    default:
      return "No se pudo iniciar sesión. Probá de nuevo en un momento.";
  }
}
