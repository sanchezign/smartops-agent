import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WHO_EMOJI, type WhoAnswers } from "../labels";

/** 🤖 / 👤 / ⛔ — who is answering this chat. The emoji is decorative; the text is read. */
export function WhoBadge({
  who,
  detail,
  className,
}: {
  who: WhoAnswers;
  detail?: string;
  className?: string;
}) {
  const t = useTranslations("conversations.who");
  return (
    <Badge
      variant={who === "opted_out" ? "destructive" : who === "human" ? "default" : "secondary"}
      className={cn("gap-1", className)}
    >
      <span aria-hidden>{WHO_EMOJI[who]}</span>
      {t(who)}
      {detail ? <span className="font-normal opacity-80"> {detail}</span> : null}
    </Badge>
  );
}
