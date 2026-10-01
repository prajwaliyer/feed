import { useState, useCallback, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SiInstagram, SiRss, SiX } from "react-icons/si";
import type { FeedItem } from "@/hooks/use-feed";
import { Avatar } from "./avatar";
import { ArticleReader } from "./article-reader";
import { ImageLightbox } from "./image-lightbox";

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
