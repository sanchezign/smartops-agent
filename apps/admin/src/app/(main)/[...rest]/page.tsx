import { notFound } from "next/navigation";

/**
 * Any address the panel does not have lands here and shows the panel's own "not found"
 * (app/(main)/not-found.tsx) inside the shell, with its navigation — not a bare page (phase 14).
 */
export default function Page() {
  notFound();
}
