import { Hammer } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";

/** Placeholder for sections that arrive in a later milestone of phase 9. */
export function ComingSoon({ title, description }: { title: string; description: string }) {
  const t = useTranslations("states");
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        icon={<Hammer className="size-8" aria-hidden />}
        title={t("underConstruction")}
        description={description}
      />
    </>
  );
}
