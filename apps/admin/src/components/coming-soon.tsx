import { Hammer } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";

/** Placeholder for sections that arrive in a later milestone of phase 9. */
export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        icon={<Hammer className="size-8" aria-hidden />}
        title="Esta sección está en construcción"
        description={description}
      />
    </>
  );
}
