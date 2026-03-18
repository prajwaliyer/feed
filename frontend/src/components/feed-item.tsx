import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import type { FeedItem } from "@/hooks/use-feed";

const URL_REGEX = /(https?:\/\/[^\s<]+)/g;

function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_REGEX)].map((m) => m[1]);
}

function linkifyText(text: string): ReactNode[] {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) => {
    if (URL_REGEX.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 40)}
          {part.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").length > 40 ? "…" : ""}
        </a>
      );
    }
    return part;
  });
}

function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<{
    title: string | null;
    image: string | null;
    domain: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }

  if (preview === null) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block overflow-hidden rounded-lg border border-border hover:bg-muted transition-colors"
      onClick={(e) => e.stopPropagation()}
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          className="w-full object-cover"
          style={{ maxHeight: "180px" }}
          loading="lazy"
        />
      )}
      <div className="px-3 py-2">
        {preview.title && (
          <p className="text-sm font-medium truncate">{preview.title}</p>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <img
            src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
            alt=""
            className="h-3.5 w-3.5 rounded-sm"
            loading="lazy"
          />
          <span>{preview.domain || hostname}</span>
        </div>
      </div>
    </a>
  );
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatCount(n: number | null): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function decodeHtmlEntities(str: string): string {
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = str;
    return textarea.value;
  }
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "\u2026")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]*>/g, "")).trim();
}

function extractImages(html: string): string[] {
  const matches = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)];
  return matches.map((m) => decodeHtmlEntities(m[1])).filter((src) => !src.includes("emoji"));
}

function extractVideos(html: string): { src: string; poster?: string }[] {
  const videoTags = [...html.matchAll(/<video[^>]*>/g)];
  return videoTags.map((m) => {
    const tag = m[0];
    const srcMatch = tag.match(/src="([^"]+)"/);
    const posterMatch = tag.match(/poster="([^"]+)"/);
    return {
      src: srcMatch ? decodeHtmlEntities(srcMatch[1]) : "",
      poster: posterMatch ? decodeHtmlEntities(posterMatch[1]) : undefined,
    };
  }).filter((v) => v.src).map((v) => ({
    src: v.src,
    poster: v.poster,
  }));
}

function proxyUrl(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

interface ParsedContent {
  mainText: string;
  mainImages: string[];
  mainVideos: { src: string; poster?: string }[];
  quote: {
    author: string;
    text: string;
    images: string[];
    videos: { src: string; poster?: string }[];
  } | null;
}

function parseContent(html: string | null): ParsedContent {
  if (!html) return { mainText: "", mainImages: [], mainVideos: [], quote: null };

  const quoteMatch = html.match(/<div class="rsshub-quote">([\s\S]*)<\/div>\s*$/);

  let mainHtml = html;
  let quote: ParsedContent["quote"] = null;

  if (quoteMatch) {
    mainHtml = html.slice(0, quoteMatch.index);
    const quoteHtml = quoteMatch[1];

    const quoteText = stripHtml(quoteHtml);
    const authorMatch = quoteText.match(/^(.+?):\s*/);
    const author = authorMatch ? authorMatch[1].trim() : "";
    const text = authorMatch ? quoteText.slice(authorMatch[0].length).trim() : quoteText;

    quote = {
      author,
      text,
      images: extractImages(quoteHtml),
      videos: extractVideos(quoteHtml),
    };
  }

  return {
    mainText: stripHtml(mainHtml),
    mainImages: extractImages(mainHtml),
    mainVideos: extractVideos(mainHtml),
    quote,
  };
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const stateRef = useRef({ scale: 1, x: 0, y: 0, startDist: 0, startScale: 1, startX: 0, startY: 0, panStartX: 0, panStartY: 0, isPanning: false });

  const applyTransform = useCallback(() => {
    const s = stateRef.current;
    const img = imgRef.current;
    if (img) img.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`;
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const getDistance = (t1: React.Touch, t2: React.Touch) =>
    Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

  const getMidpoint = (t1: React.Touch, t2: React.Touch) => ({
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2,
  });

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const s = stateRef.current;
    if (e.touches.length === 2) {
      s.startDist = getDistance(e.touches[0], e.touches[1]);
      s.startScale = s.scale;
      const mid = getMidpoint(e.touches[0], e.touches[1]);
      s.panStartX = mid.x;
      s.panStartY = mid.y;
      s.startX = s.x;
      s.startY = s.y;
      s.isPanning = false;
    } else if (e.touches.length === 1 && s.scale > 1) {
      s.panStartX = e.touches[0].clientX;
      s.panStartY = e.touches[0].clientY;
      s.startX = s.x;
      s.startY = s.y;
      s.isPanning = true;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const s = stateRef.current;
    if (e.touches.length === 2) {
      const dist = getDistance(e.touches[0], e.touches[1]);
      s.scale = Math.max(1, Math.min(5, s.startScale * (dist / s.startDist)));
      const mid = getMidpoint(e.touches[0], e.touches[1]);
      s.x = s.startX + (mid.x - s.panStartX);
      s.y = s.startY + (mid.y - s.panStartY);
      applyTransform();
    } else if (e.touches.length === 1 && s.isPanning && s.scale > 1) {
      s.x = s.startX + (e.touches[0].clientX - s.panStartX);
      s.y = s.startY + (e.touches[0].clientY - s.panStartY);
      applyTransform();
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    const s = stateRef.current;
    s.isPanning = false;
    if (s.scale <= 1) {
      s.scale = 1;
      s.x = 0;
      s.y = 0;
      applyTransform();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 touch-none"
      onClick={onClose}
    >
      <img
        ref={imgRef}
        src={src}
        alt=""
        className="max-h-[90vh] max-w-[90vw] object-contain"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        draggable={false}
      />
    </div>
  );
}

function MediaGrid({ images, videos }: { images: string[]; videos: { src: string; poster?: string }[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const closeLightbox = useCallback(() => setLightboxSrc(null), []);

  if (images.length === 0 && videos.length === 0) return null;

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={closeLightbox} />}
      <div className="mt-2 space-y-1">
        {images.length > 0 && (
          <div className={`grid gap-1 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {images.slice(0, 4).map((src, i) => (
              <img
                key={i}
                src={proxyUrl(src)}
                alt=""
                className="w-full rounded-lg border border-border object-contain cursor-pointer"
                loading="lazy"
                onClick={() => setLightboxSrc(proxyUrl(src))}
              />
            ))}
          </div>
        )}
        {videos.map((vid, i) => (
          <video
            key={i}
            src={proxyUrl(vid.src)}
            poster={vid.poster ? proxyUrl(vid.poster) : undefined}
            controls
            playsInline
            preload="none"
            className="w-full rounded-lg border border-border"
            style={{ maxHeight: "300px" }}
          />
        ))}
      </div>
    </>
  );
}

interface FeedItemCardProps {
  item: FeedItem;
  onToggleStar: (id: number, starred: boolean) => void;
}

export function FeedItemCard({ item, onToggleStar }: FeedItemCardProps) {
  const { mainText, mainImages, mainVideos, quote } = parseContent(item.content);
  const displayText = mainText || item.title || "";

  return (
    <article className="border-b border-border px-4 py-3">
      <div className="flex gap-3">
        {/* Avatar */}
        <div className="shrink-0">
          {item.sourceIcon ? (
            <img
              src={proxyUrl(item.sourceIcon)}
              alt=""
              className="h-10 w-10 rounded-full bg-muted"
              loading="lazy"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-bold">
              {(item.author || "?")[0].toUpperCase()}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Header */}
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-sm">
              {item.author || item.sourceName}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              @{item.sourceName}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.publishedAt ? timeAgo(item.publishedAt) : ""}
            </span>
          </div>

          {/* Main text */}
          {displayText && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {linkifyText(displayText)}
            </p>
          )}

          {/* Link previews */}
          {extractUrls(displayText).slice(0, 1).map((url, i) => (
            <LinkPreview key={i} url={url} />
          ))}

          {/* Main media */}
          <MediaGrid images={mainImages} videos={mainVideos} />

          {/* Quote tweet */}
          {quote && (
            <div className="mt-2 rounded-lg border border-border p-3">
              {quote.author && (
                <p className="text-xs font-semibold text-foreground">{quote.author}</p>
              )}
              {quote.text && (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground leading-relaxed">
                  {quote.text}
                </p>
              )}
              <MediaGrid images={quote.images} videos={quote.videos} />
            </div>
          )}

          {/* Actions */}
          <div className="mt-2 flex items-center gap-4">
            {/* Likes */}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" />
              </svg>
              {formatCount(item.likeCount)}
            </span>

            {/* Replies */}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              {formatCount(item.replyCount)}
            </span>

            {/* Share */}
            {item.url && (
              <button
                onClick={async () => {
                  const url = item.url;
                  if (!url) return;
                  const copyFallback = () => {
                    const textarea = document.createElement("textarea");
                    textarea.value = url;
                    textarea.style.position = "fixed";
                    textarea.style.opacity = "0";
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand("copy");
                    document.body.removeChild(textarea);
                  };
                  if (typeof navigator.share === "function") {
                    try {
                      await navigator.share({ url });
                    } catch {
                      copyFallback();
                    }
                  } else {
                    copyFallback();
                  }
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </button>
            )}

            {/* Open link */}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                Open
              </a>
            )}

            {/* Star */}
            <button
              onClick={() => onToggleStar(item.id, !item.isStarred)}
              className="ml-auto p-1 text-muted-foreground hover:text-yellow-500 transition-colors"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill={item.isStarred ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
