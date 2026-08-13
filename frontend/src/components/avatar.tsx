import { useState } from "react";

function proxyUrl(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

interface AvatarProps {
  src: string | null;
  name: string | null;
  className: string;
  imgClassName?: string;
  fallbackClassName?: string;
}

// Falls back to a letter avatar when there's no icon, or when the icon URL
// fails to load (e.g. an expired Instagram CDN link) instead of leaving a
// broken/blank image in place.
export function Avatar({
  src,
  name,
  className,
  imgClassName = "",
  fallbackClassName = "",
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = !src || src === failedSrc;

  if (broken) {
    return (
      <div
        className={`flex items-center justify-center bg-muted font-bold ${className} ${fallbackClassName}`}
      >
        {(name || "?")[0].toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={proxyUrl(src)}
      alt=""
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={`object-cover ${className} ${imgClassName}`}
    />
  );
}
