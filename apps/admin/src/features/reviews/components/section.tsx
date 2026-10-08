import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t-[1.5px] py-5 first:border-t-0 first:pt-0">
      <h2 className="font-title text-sm">{title}</h2>
      {children}
    </section>
  );
}
