import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WHO_LABEL, type WhoAnswers } from "../labels";

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
  const label = WHO_LABEL[who];
  return (
    <Badge
      variant={who === "opted_out" ? "destructive" : who === "human" ? "default" : "secondary"}
      className={cn("gap-1", className)}
    >
      <span aria-hidden>{label.emoji}</span>
      {label.text}
      {detail ? <span className="font-normal opacity-80"> {detail}</span> : null}
    </Badge>
  );
}
