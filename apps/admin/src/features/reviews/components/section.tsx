import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t py-5 first:border-t-0 first:pt-0">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
