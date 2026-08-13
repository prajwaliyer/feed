import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import type { FeedItem } from "@/hooks/use-feed";
import { Avatar } from "./avatar";

function proxyUrl(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

// Feed content is untrusted external HTML - sanitize before rendering, and
// route images through our proxy (source sites often block hotlinking/CORS)
// while forcing links to open in a new tab like the rest of the app.
function sanitizeArticleHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target"],
    FORBID_TAGS: ["style", "script", "iframe", "form"],
  });

  const container = document.createElement("div");
  container.innerHTML = clean;

  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) img.setAttribute("src", proxyUrl(src));
    img.removeAttribute("srcset");
    img.setAttribute("loading", "lazy");
  });

  container.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });

  return container.innerHTML;
}

// Narration audio is generated server-side (Piper TTS) and cached per item,
// so playback is just a normal <audio> element streaming from our backend.
type AudioState = "idle" | "loading" | "playing" | "paused" | "error";

function HeadphonesIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" />
      <rect x="14" y="5" width="4" height="14" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function ArticleReader({ item, onClose }: { item: FeedItem; onClose: () => void }) {
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Guards the poll loop below: set whenever narration is stopped/the reader
  // closes, so an in-flight poll doesn't touch state (or start playback)
  // after the user has moved on.
  const cancelledRef = useRef(false);

  // Stop narration when the reader closes/unmounts, rather than leaving it
  // playing in the background after the article is gone.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      cancelledRef.current = true;
      audio?.pause();
    };
  }, []);

  const stopAudio = () => {
    cancelledRef.current = true;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setAudioState("idle");
  };

  const handleListen = async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audioState === "playing") {
      audio.pause();
      setAudioState("paused");
      return;
    }
    if (audioState === "paused") {
      await audio.play();
      setAudioState("playing");
      return;
    }
    if (audioState === "loading") return;

    cancelledRef.current = false;
    setAudioState("loading");
    try {
      // Generation runs in a background thread on the backend (can take a
      // couple minutes for a long article), so this just kicks it off and
      // polls a cheap status endpoint rather than holding one request open
      // long enough to risk hitting a proxy/edge timeout.
      const genRes = await fetch(`/api/items/${item.id}/audio/generate`, { method: "POST" });
      if (!genRes.ok) throw new Error("generate failed");

      for (;;) {
        if (cancelledRef.current) return;
        const statusRes = await fetch(`/api/items/${item.id}/audio/status`);
        const { status } = await statusRes.json();
        if (status === "ready") break;
        if (status === "error") throw new Error("tts failed");
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (cancelledRef.current) return;

      audio.src = `/api/items/${item.id}/audio`;
      await audio.play();
      if (cancelledRef.current) {
        audio.pause();
        return;
      }
      setAudioState("playing");
    } catch {
      if (!cancelledRef.current) setAudioState("error");
    }
  };

  const html = item.content ? sanitizeArticleHtml(item.content) : "";

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <audio
        ref={audioRef}
        onEnded={() => setAudioState("idle")}
        onError={() => setAudioState("error")}
        className="hidden"
      />
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur-sm" style={{ paddingTop: "calc(0.625rem + env(safe-area-inset-top))" }}>
        <button
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted transition-colors"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 19" />
          </svg>
        </button>
        <Avatar src={item.sourceIcon} name={item.sourceName} className="h-6 w-6 rounded-full shrink-0" fallbackClassName="text-xs" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{item.sourceName}</span>
        {html && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={handleListen}
              disabled={audioState === "loading"}
              title={
                audioState === "loading" ? "Generating narration…" :
                audioState === "playing" ? "Pause" :
                audioState === "paused" ? "Resume" :
                audioState === "error" ? "Failed - tap to retry" : "Listen"
              }
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-60"
            >
              {audioState === "loading" ? <SpinnerIcon /> :
               audioState === "playing" ? <PauseIcon /> :
               audioState === "paused" ? <PlayIcon /> : <HeadphonesIcon />}
            </button>
            {audioState !== "idle" && audioState !== "error" && (
              <button
                onClick={stopAudio}
                title="Stop"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <StopIcon />
              </button>
            )}
          </div>
        )}
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            Original
          </a>
        )}
      </div>

      <div className="mx-auto max-w-xl px-4 py-6">
        <h1 className="text-2xl font-bold leading-tight text-foreground">{item.title}</h1>
        <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          {item.author && <span>{item.author}</span>}
          {item.author && item.publishedAt && <span>·</span>}
          {item.publishedAt && <span>{formatDate(item.publishedAt)}</span>}
        </div>

        {item.imageUrl && (
          <img
            src={proxyUrl(item.imageUrl)}
            alt=""
            className="mt-4 w-full rounded-lg border border-border object-cover"
          />
        )}

        {html ? (
          <div className="article-content mt-5" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="mt-5 text-sm text-muted-foreground">No content available for this article.</p>
        )}
      </div>
    </div>,
    document.body
  );
}
