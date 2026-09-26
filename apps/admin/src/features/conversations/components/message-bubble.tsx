import { AlertCircle } from "lucide-react";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, outboundAuthor } from "../labels";
import type { ChatMessage } from "../types";
import { MediaAttachment } from "./media-attachment";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const outbound = message.direction === "outbound";
  const failed = message.status === "failed" || message.status === "canceled";
  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-1.5 rounded-2xl px-3 py-2 text-sm sm:max-w-[70%]",
          outbound
            ? message.author === "bot"
              ? "rounded-br-sm border bg-secondary"
              : "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border bg-card",
          failed && "opacity-70",
        )}
      >
        {outbound ? (
          <span
            className={cn(
              "text-xs font-medium",
              message.author === "human" ? "text-primary-foreground/80" : "text-muted-foreground",
            )}
          >
            {outboundAuthor(message)}
          </span>
        ) : null}
        {message.revokedAt ? (
          <p className="italic opacity-80">Mensaje eliminado</p>
        ) : (
          <>
            {message.media ? <MediaAttachment media={message.media} type={message.type} /> : null}
            {message.text ? (
              <p className="break-words whitespace-pre-wrap">{message.text}</p>
            ) : null}
            {message.transcript ? (
              <div className="rounded-lg bg-muted/60 px-2 py-1.5 text-foreground">
                <p className="text-xs font-medium text-muted-foreground">Transcripción</p>
                <p className="break-words whitespace-pre-wrap">{message.transcript}</p>
              </div>
            ) : null}
          </>
        )}
        <span
          className={cn(
            "flex items-center justify-end gap-1 text-[0.7rem]",
            message.author === "human" && outbound
              ? "text-primary-foreground/70"
              : "text-muted-foreground",
          )}
        >
          {message.editedAt ? "editado · " : null}
          <time dateTime={message.at}>{formatTime(message.at)}</time>
          {outbound && STATUS_LABEL[message.status] ? (
            <>
              {" · "}
              {failed ? <AlertCircle className="size-3" aria-hidden /> : null}
              {STATUS_LABEL[message.status]}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
