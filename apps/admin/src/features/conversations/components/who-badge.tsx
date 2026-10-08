import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WHO_EMOJI, type WhoAnswers } from "../labels";

/**
 * Who is answering this chat. "A person is handling it" is what waits for a person, so it is
 * the yellow price-tag label (ADR-029); the bot is quiet (the inbox shows nothing for it), an
 * opted-out contact is red. The emoji is decorative; the text is read.
 */
export function WhoBadge({
  who,
  detail,
  detailOnlyFromTablet = false,
  className,
}: {
  who: WhoAnswers;
  detail?: string;
  /** Show the detail ("until 11:02 PM") only from tablets up (the chat header on a phone). */
  detailOnlyFromTablet?: boolean;
  className?: string;
}) {
  const t = useTranslations("conversations.who");
  if (who === "human") {
    return (
      <span
        className={cn(
          "tag-shape inline-flex h-6 items-center gap-1 bg-signal pr-2.5 text-xs font-semibold whitespace-nowrap text-signal-foreground",
          className,
        )}
      >
        {t(who)}
        {detail ? (
          <span className={cn("font-normal", detailOnlyFromTablet && "hidden sm:inline")}>
            {" "}
            {detail}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <Badge
      variant={who === "opted_out" ? "destructive" : "secondary"}
      className={cn("gap-1", className)}
    >
      <span aria-hidden>{WHO_EMOJI[who]}</span>
      {t(who)}
      {detail ? <span className="font-normal opacity-80"> {detail}</span> : null}
    </Badge>
  );
}
