"use client";

import { Download, FileText, Loader2, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMediaBlob } from "../hooks";
import { MEDIA_UNAVAILABLE } from "../labels";
import type { ChatMedia } from "../types";

/**
 * A chat attachment (ADR-019): bytes fetched with the Bearer and shown from a blob: URL.
 * Photos load when they scroll into view; audio and documents only when tapped.
 */
export function MediaAttachment({ media, type }: { media: ChatMedia; type: string }) {
  if (media.status !== "stored") {
    return (
      <p className="text-sm text-muted-foreground italic">
        {MEDIA_UNAVAILABLE[media.status] ?? "Archivo no disponible"}
      </p>
    );
  }
  if (type === "image" || media.mimeType.startsWith("image/")) return <LazyImage media={media} />;
  if (type === "audio" || media.mimeType.startsWith("audio/")) return <AudioPlayer media={media} />;
  return <DocumentLink media={media} />;
}

function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);
  return { ref, inView };
}

function LazyImage({ media }: { media: ChatMedia }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const blob = useMediaBlob(media.id, inView);
  return (
    <div ref={ref} className="min-h-24 overflow-hidden rounded-lg bg-muted">
      {blob.url ? (
        <a href={blob.url} target="_blank" rel="noopener noreferrer">
          {/* A blob: URL of an authenticated download: next/image cannot optimize it (ADR-019). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={blob.url}
            alt={media.filename ? `Foto: ${media.filename}` : "Foto enviada por WhatsApp"}
            className="max-h-80 w-full object-contain"
          />
        </a>
      ) : blob.isError ? (
        <p className="p-3 text-sm text-muted-foreground">No se pudo cargar la foto.</p>
      ) : (
        <div
          role="status"
          className="flex h-24 items-center justify-center text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span className="sr-only">Cargando foto</span>
        </div>
      )}
    </div>
  );
}

function AudioPlayer({ media }: { media: ChatMedia }) {
  const [requested, setRequested] = useState(false);
  const blob = useMediaBlob(media.id, requested);
  if (!requested) {
    return (
      <Button variant="outline" className="min-h-11" onClick={() => setRequested(true)}>
        <Play aria-hidden /> Escuchar audio
      </Button>
    );
  }
  if (blob.isError)
    return <p className="text-sm text-muted-foreground">No se pudo cargar el audio.</p>;
  if (!blob.url) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Cargando audio…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <audio
        controls
        autoPlay
        src={blob.url}
        className="w-full max-w-72"
        aria-label="Audio del mensaje"
      />
      <a
        href={blob.url}
        download={media.filename ?? "audio.ogg"}
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
      >
        ¿No se escucha? Descargalo
      </a>
    </div>
  );
}

function DocumentLink({ media }: { media: ChatMedia }) {
  const [requested, setRequested] = useState(false);
  const blob = useMediaBlob(media.id, requested);
  const name = media.filename ?? "Documento";
  const anchor = useRef<HTMLAnchorElement | null>(null);
  // Once downloaded, open/save it with its name (a download, never a page of our origin).
  useEffect(() => {
    if (requested && blob.url) anchor.current?.click();
  }, [requested, blob.url]);
  return (
    <div className="flex items-center gap-2">
      <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {blob.url ? (
        <a
          ref={anchor}
          href={blob.url}
          download={name}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
        >
          <Download className="size-4" aria-hidden /> Abrir
        </a>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={requested && blob.isFetching}
          onClick={() => setRequested(true)}
        >
          <Download aria-hidden /> {requested && blob.isFetching ? "Descargando…" : "Descargar"}
        </Button>
      )}
      {blob.isError ? (
        <span className="text-xs text-destructive">No se pudo descargar.</span>
      ) : null}
    </div>
  );
}
