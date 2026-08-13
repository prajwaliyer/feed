import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SiInstagram, SiRss, SiX } from "react-icons/si";
import type { FeedItem } from "@/hooks/use-feed";
import { Avatar } from "./avatar";
import { ArticleReader } from "./article-reader";

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
        <LoadingImage
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

function RssCard({ title, imageUrl, onOpen }: { title: string | null; imageUrl: string | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="mt-1.5 flex w-full items-center gap-3 rounded-lg border border-border p-2 text-left hover:bg-muted transition-colors"
    >
      {imageUrl && (
        <LoadingImage
          src={proxyUrl(imageUrl)}
          alt=""
          className="h-16 w-16 shrink-0 rounded-md object-cover"
          loading="lazy"
        />
      )}
      <p className="min-w-0 flex-1 text-sm font-medium leading-snug line-clamp-3">
        {title}
      </p>
    </button>
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

function SourcePlatformBadge({ sourceType }: { sourceType: string | null }) {
  if (sourceType?.startsWith("twitter")) {
    return <SiX className="h-2.5 w-2.5 text-muted-foreground" title="Twitter" />;
  }
  if (sourceType?.startsWith("instagram")) {
    return <SiInstagram className="h-2.5 w-2.5 text-muted-foreground" title="Instagram" />;
  }
  if (sourceType === "rss") {
    return <SiRss className="h-2.5 w-2.5 text-muted-foreground" title="RSS" />;
  }
  return (
    <svg className="h-2.5 w-2.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <title>Other</title>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z" />
    </svg>
  );
}

function LoadingImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {!loaded && (
        <div className="absolute inset-0 rounded-lg bg-muted animate-pulse" />
      )}
      <img
        {...props}
        onLoad={(e) => {
          setLoaded(true);
          props.onLoad?.(e);
        }}
        style={{ ...props.style, opacity: loaded ? 1 : 0, transition: "opacity 0.2s" }}
      />
    </div>
  );
}

interface ParsedContent {
  mainText: string;
  mainImages: string[];
  mainVideos: { src: string; poster?: string }[];
  retweetAuthor: string | null;
  quote: {
    author: string;
    text: string;
    images: string[];
    videos: { src: string; poster?: string }[];
  } | null;
}

// Two RSSHub retweet formats: "RT @handle: text" and "RT<en-space>Display Name<br/>text"
const RETWEET_HANDLE_REGEX = /^RT @(\w+):\s*/;
const RETWEET_NAME_REGEX = /^RT ([^<]+?)(?:<br\s*\/?>|$)/;
const RETWEET_TITLE_PREFIX_REGEX = /^RT[  ]@?\S+:?\s*/;

function parseContent(html: string | null): ParsedContent {
  if (!html) return { mainText: "", mainImages: [], mainVideos: [], retweetAuthor: null, quote: null };

  const handleMatch = html.match(RETWEET_HANDLE_REGEX);
  const nameMatch = !handleMatch ? html.match(RETWEET_NAME_REGEX) : null;
  const retweetMatch = handleMatch || nameMatch;
  const retweetAuthor = handleMatch ? `@${handleMatch[1]}` : nameMatch ? decodeHtmlEntities(nameMatch[1]).trim() : null;
  if (retweetMatch) {
    html = html.slice(retweetMatch[0].length);
  }

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
    retweetAuthor,
    quote,
  };
}

const DISMISS_THRESHOLD = 150;

function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: {
  images: string[];
  initialIndex: number;
  onClose: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const stripRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    scale: 1, x: 0, y: 0,
    startDist: 0, startScale: 1, startX: 0, startY: 0,
    panStartX: 0, panStartY: 0,
    isPanning: false, isDismissing: false, isSwiping: false,
    dismissStartY: 0, dismissY: 0,
    swipeStartX: 0, swipeX: 0,
    lastTapTime: 0, lastTapX: 0, lastTapY: 0,
    isAnimating: false,
  });

  const hasMultiple = images.length > 1;
  const IMAGE_GAP = 20;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  const slideOffset = useCallback((index: number) => {
    return -index * (window.innerWidth + IMAGE_GAP);
  }, [IMAGE_GAP]);

  const getActiveImg = useCallback((): HTMLImageElement | null => {
    return stripRef.current?.querySelector(`[data-index="${currentIndexRef.current}"]`) as HTMLImageElement | null;
  }, []);

  const applyStripOffset = useCallback((extra = 0) => {
    const strip = stripRef.current;
    if (strip) {
      strip.style.transform = `translateX(${slideOffset(currentIndexRef.current) + extra}px)`;
    }
  }, [slideOffset]);

  const applyTransform = useCallback(() => {
    const s = stateRef.current;
    const img = getActiveImg();
    if (img) img.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`;
  }, [getActiveImg]);

  const animateZoom = useCallback((toScale: number, toX: number, toY: number) => {
    const s = stateRef.current;
    const img = getActiveImg();
    if (!img || s.isAnimating) return;
    s.isAnimating = true;
    img.style.transition = "transform 0.3s cubic-bezier(0.2, 0, 0.2, 1)";
    s.scale = toScale;
    s.x = toX;
    s.y = toY;
    img.style.transform = `translate(${toX}px, ${toY}px) scale(${toScale})`;
    const onEnd = () => {
      img.style.transition = "";
      s.isAnimating = false;
      img.removeEventListener("transitionend", onEnd);
    };
    img.addEventListener("transitionend", onEnd);
  }, [getActiveImg]);

  const applyDismiss = useCallback(() => {
    const s = stateRef.current;
    const strip = stripRef.current;
    const backdrop = backdropRef.current;
    const opacity = Math.max(0, 1 - Math.abs(s.dismissY) / (DISMISS_THRESHOLD * 2));
    if (strip) {
      strip.style.transform = `translateX(${slideOffset(currentIndexRef.current)}px) translateY(${s.dismissY}px)`;
    }
    if (backdrop) backdrop.style.opacity = String(opacity);
  }, []);

  const goTo = useCallback((index: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const s = stateRef.current;
    // Reset zoom on current image before navigating
    const currentImg = getActiveImg();
    if (currentImg) {
      currentImg.style.transition = "";
      currentImg.style.transform = "";
    }
    s.scale = 1;
    s.x = 0;
    s.y = 0;
    s.swipeX = 0;
    strip.style.transition = "transform 0.25s ease-out";
    strip.style.transform = `translateX(${slideOffset(index)}px)`;
    const onEnd = () => {
      strip.style.transition = "";
      strip.removeEventListener("transitionend", onEnd);
    };
    strip.addEventListener("transitionend", onEnd);
    setCurrentIndex(index);
  }, [getActiveImg]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && currentIndexRef.current > 0) goTo(currentIndexRef.current - 1);
      if (e.key === "ArrowRight" && currentIndexRef.current < images.length - 1) goTo(currentIndexRef.current + 1);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, images.length, goTo]);

  const SWIPE_THRESHOLD = 80;

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
      s.isDismissing = false;
      s.isSwiping = false;
      s.startDist = getDistance(e.touches[0], e.touches[1]);
      s.startScale = s.scale;
      const mid = getMidpoint(e.touches[0], e.touches[1]);
      s.panStartX = mid.x;
      s.panStartY = mid.y;
      s.startX = s.x;
      s.startY = s.y;
      s.isPanning = false;
    } else if (e.touches.length === 1) {
      if (s.scale > 1) {
        s.panStartX = e.touches[0].clientX;
        s.panStartY = e.touches[0].clientY;
        s.startX = s.x;
        s.startY = s.y;
        s.isPanning = true;
        s.isDismissing = false;
        s.isSwiping = false;
      } else {
        s.swipeStartX = e.touches[0].clientX;
        s.dismissStartY = e.touches[0].clientY;
        s.swipeX = 0;
        s.dismissY = 0;
        s.isDismissing = false;
        s.isSwiping = false;
        s.isPanning = false;
      }
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
    } else if (e.touches.length === 1) {
      if (s.isPanning && s.scale > 1) {
        s.x = s.startX + (e.touches[0].clientX - s.panStartX);
        s.y = s.startY + (e.touches[0].clientY - s.panStartY);
        applyTransform();
      } else if (!s.isDismissing && !s.isSwiping && s.scale <= 1) {
        const dx = e.touches[0].clientX - s.swipeStartX;
        const dy = e.touches[0].clientY - s.dismissStartY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          if (hasMultiple && Math.abs(dx) > Math.abs(dy)) {
            s.isSwiping = true;
          } else {
            s.isDismissing = true;
          }
        }
      }
      if (s.isSwiping) {
        s.swipeX = e.touches[0].clientX - s.swipeStartX;
        applyStripOffset(s.swipeX);
      } else if (s.isDismissing) {
        s.dismissY = e.touches[0].clientY - s.dismissStartY;
        applyDismiss();
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    const s = stateRef.current;

    if (s.isSwiping) {
      s.isSwiping = false;
      if (Math.abs(s.swipeX) > SWIPE_THRESHOLD) {
        if (s.swipeX < 0 && currentIndex < images.length - 1) {
          goTo(currentIndex + 1);
          return;
        } else if (s.swipeX > 0 && currentIndex > 0) {
          goTo(currentIndex - 1);
          return;
        }
      }
      // Snap back
      s.swipeX = 0;
      const strip = stripRef.current;
      if (strip) {
        strip.style.transition = "transform 0.2s ease";
        applyStripOffset(0);
        setTimeout(() => { if (strip) strip.style.transition = ""; }, 200);
      }
      return;
    }

    if (s.isDismissing) {
      const movedDuringDismiss = Math.abs(s.dismissY) > 10;
      if (!movedDuringDismiss && e.touches.length === 0 && e.changedTouches.length === 1) {
        const now = Date.now();
        const touch = e.changedTouches[0];
        const dt = now - s.lastTapTime;
        const dx = Math.abs(touch.clientX - s.lastTapX);
        const dy = Math.abs(touch.clientY - s.lastTapY);

        if (dt < 300 && dx < 30 && dy < 30) {
          s.lastTapTime = 0;
          s.isDismissing = false;
          const img = getActiveImg();
          if (img) {
            const rect = img.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const toX = (cx - touch.clientX) * 2;
            const toY = (cy - touch.clientY) * 2;
            animateZoom(3, toX, toY);
          }
          return;
        }
        s.lastTapTime = now;
        s.lastTapX = touch.clientX;
        s.lastTapY = touch.clientY;
      }

      if (Math.abs(s.dismissY) > DISMISS_THRESHOLD) {
        onClose();
        return;
      }
      s.dismissY = 0;
      s.isDismissing = false;
      const strip = stripRef.current;
      const backdrop = backdropRef.current;
      if (strip) {
        strip.style.transition = "transform 0.2s ease";
        applyStripOffset(0);
        setTimeout(() => { if (strip) strip.style.transition = ""; }, 200);
      }
      if (backdrop) {
        backdrop.style.transition = "opacity 0.2s ease";
        backdrop.style.opacity = "1";
        setTimeout(() => { if (backdrop) backdrop.style.transition = ""; }, 200);
      }
      return;
    }

    // Double-tap while zoomed in → zoom back to 1x
    if (s.isPanning && e.touches.length === 0 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const moved = Math.abs(touch.clientX - s.panStartX) > 10 || Math.abs(touch.clientY - s.panStartY) > 10;
      if (!moved) {
        const now = Date.now();
        const dt = now - s.lastTapTime;
        const dx = Math.abs(touch.clientX - s.lastTapX);
        const dy = Math.abs(touch.clientY - s.lastTapY);

        if (dt < 300 && dx < 30 && dy < 30) {
          s.lastTapTime = 0;
          s.isPanning = false;
          animateZoom(1, 0, 0);
          return;
        }
        s.lastTapTime = now;
        s.lastTapX = touch.clientX;
        s.lastTapY = touch.clientY;
      }
    }

    // Double-tap to zoom in (no gesture detected — tap without movement)
    if (!s.isPanning && !s.isDismissing && !s.isSwiping && s.scale <= 1 &&
        e.touches.length === 0 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const now = Date.now();
      const dt = now - s.lastTapTime;
      const dx = Math.abs(touch.clientX - s.lastTapX);
      const dy = Math.abs(touch.clientY - s.lastTapY);

      if (dt < 300 && dx < 30 && dy < 30) {
        s.lastTapTime = 0;
        const img = getActiveImg();
        if (img) {
          const rect = img.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const toX = (cx - touch.clientX) * 2;
          const toY = (cy - touch.clientY) * 2;
          animateZoom(3, toX, toY);
        }
        return;
      }
      s.lastTapTime = now;
      s.lastTapX = touch.clientX;
      s.lastTapY = touch.clientY;
    }

    s.isPanning = false;
    if (s.scale <= 1) {
      s.scale = 1;
      s.x = 0;
      s.y = 0;
      const img = getActiveImg();
      if (img) img.style.transform = "";
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] touch-none">
      <div ref={backdropRef} className="absolute inset-0 bg-black" />
      <button
        onClick={onClose}
        className="absolute top-4 left-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"
        style={{ marginTop: "env(safe-area-inset-top)" }}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {hasMultiple && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5"
          style={{ marginTop: "env(safe-area-inset-top)" }}
        >
          {images.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === currentIndex ? "bg-white" : "bg-white/40"
              }`}
            />
          ))}
        </div>
      )}
      <div
        className="relative h-full w-full overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          ref={stripRef}
          className="flex h-full"
          style={{
            gap: `${IMAGE_GAP}px`,
            transform: `translateX(${-(initialIndex * (window.innerWidth + IMAGE_GAP))}px)`,
          }}
        >
          {images.map((src, i) => (
            <div
              key={i}
              className="flex h-full items-center justify-center shrink-0"
              style={{ width: "100vw" }}
            >
              <img
                data-index={i}
                src={src}
                alt=""
                className="max-h-full max-w-full object-contain"
                draggable={false}
              />
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

function SourceSettingsDialog({
  sourceId,
  sourceName,
  currentMultiplier,
  onSave,
  onClose,
}: {
  sourceId: number;
  sourceName: string | null;
  sourceIcon: string | null;
  currentMultiplier: string | null;
  onSave: (sourceId: number, multiplier: string | null) => void;
  onClose: () => void;
}) {
  const [multiplier, setMultiplier] = useState(currentMultiplier ?? "");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const val = multiplier.trim();
    const parsed = parseFloat(val);
    if (val && !isNaN(parsed) && parsed > 0) {
      onSave(sourceId, val);
    } else {
      onSave(sourceId, null);
    }
    setLoading(false);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">Edit Source</h3>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Twitter Handle</label>
            <input
              value={`@${sourceName ?? ""}`}
              disabled
              className="flex h-9 w-full rounded-md border border-input bg-muted px-3 py-1 text-sm text-muted-foreground shadow-xs"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="edit-multiplier" className="text-sm font-medium">
              Boost Multiplier <span className="text-muted-foreground font-normal">(optional, 0.1–10)</span>
            </label>
            <input
              id="edit-multiplier"
              type="text"
              inputMode="decimal"
              placeholder="1"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
              autoFocus
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </form>
      </div>
    </div>,
    document.body
  );
}

function MediaGrid({ images, videos }: { images: string[]; videos: { src: string; poster?: string }[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  if (images.length === 0 && videos.length === 0) return null;

  const proxiedImages = images.slice(0, 4).map((src) => proxyUrl(src));

  return (
    <>
      {lightboxIndex !== null && (
        <ImageLightbox images={proxiedImages} initialIndex={lightboxIndex} onClose={closeLightbox} />
      )}
      <div className="mt-2 space-y-1">
        {images.length > 0 && (
          <div className={`grid gap-1 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {proxiedImages.map((src, i) => (
              <LoadingImage
                key={i}
                src={src}
                alt=""
                className="w-full rounded-lg border border-border object-contain cursor-pointer"
                loading="lazy"
                onClick={() => setLightboxIndex(i)}
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
  onSetMultiplier: (sourceId: number, multiplier: string | null) => void;
}

export function FeedItemCard({ item, onToggleStar, onSetMultiplier }: FeedItemCardProps) {
  const [showSourceSettings, setShowSourceSettings] = useState(false);
  const [showReader, setShowReader] = useState(false);
  const { mainText, mainImages, mainVideos, retweetAuthor, quote } = parseContent(item.content);
  const displayText = mainText || item.title?.replace(RETWEET_TITLE_PREFIX_REGEX, "") || "";

  return (
    <article className="border-b border-border px-4 py-3">
      {showReader && <ArticleReader item={item} onClose={() => setShowReader(false)} />}
      {showSourceSettings && (
        <SourceSettingsDialog
          sourceId={item.sourceId}
          sourceName={item.sourceName}
          sourceIcon={item.sourceIcon}
          currentMultiplier={item.sourceMultiplier}
          onSave={onSetMultiplier}
          onClose={() => setShowSourceSettings(false)}
        />
      )}
      <div className="flex gap-3">
        {/* Avatar */}
        <div className="shrink-0 cursor-pointer" onClick={() => setShowSourceSettings(true)}>
          <Avatar
            src={item.sourceIcon}
            name={item.author}
            className="h-10 w-10 rounded-full"
            fallbackClassName="text-sm"
          />
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Header */}
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-sm">
              {item.author || item.sourceName}
            </span>
            <span className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground">
              @{item.sourceName}
              <span className="text-base text-muted-foreground">·</span>
              <SourcePlatformBadge sourceType={item.sourceType} />
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.publishedAt ? timeAgo(item.publishedAt) : ""}
            </span>
          </div>

          {/* Repost indicator */}
          {retweetAuthor && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="m2 9 3-3 3 3" />
                <path d="M13 18H7a2 2 0 0 1-2-2V6" />
                <path d="m22 15-3 3-3-3" />
                <path d="M11 6h6a2 2 0 0 1 2 2v10" />
              </svg>
              <span className="truncate">{item.author || item.sourceName} reposted</span>
            </div>
          )}

          {item.sourceType === "rss" ? (
            <RssCard title={item.title} imageUrl={item.imageUrl} onOpen={() => setShowReader(true)} />
          ) : retweetAuthor ? (
            /* Reposted content, nested like a real retweet card */
            <div className="mt-1.5 rounded-lg border border-border p-3">
              <p className="text-xs font-semibold text-foreground">{retweetAuthor}</p>
              {displayText && (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {linkifyText(displayText)}
                </p>
              )}
              {mainImages.length === 0 && extractUrls(displayText).slice(0, 1).map((url, i) => (
                <LinkPreview key={i} url={url} />
              ))}
              <MediaGrid images={mainImages} videos={mainVideos} />
            </div>
          ) : (
            <>
              {/* Main text */}
              {displayText && (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {linkifyText(displayText)}
                </p>
              )}

              {/* Link previews (hide when post has images) */}
              {mainImages.length === 0 && extractUrls(displayText).slice(0, 1).map((url, i) => (
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
            </>
          )}

          {/* Actions */}
          <div className="mt-2 flex items-center gap-4">
            {item.sourceType !== "rss" && (
              <>
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
              </>
            )}

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
