import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoryGroup } from "@/hooks/use-stories";
import { Avatar } from "./avatar";

const IMAGE_DURATION = 5000; // ms per image before auto-advancing
const DISMISS_THRESHOLD = 120; // px of downward drag to close

function proxyUrl(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

interface StoryViewerProps {
  groups: StoryGroup[];
  initialGroup: number;
  onClose: () => void;
  onSeen: (itemId: number) => void;
}

export function StoryViewer({
  groups,
  initialGroup,
  onClose,
  onSeen,
}: StoryViewerProps) {
  const [groupIndex, setGroupIndex] = useState(initialGroup);
  const [itemIndex, setItemIndex] = useState(0);
  const [progress, setProgress] = useState(0); // 0..1 of current item
  const [paused, setPaused] = useState(false);

  const group = groups[groupIndex];
  const item = group?.items[itemIndex];

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef({ startX: 0, startY: 0, dy: 0, active: false });
  const [dragY, setDragY] = useState(0);

  // Mark the current story seen as soon as it's shown.
  useEffect(() => {
    if (item && !item.isRead) onSeen(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  const goToGroup = useCallback(
    (idx: number) => {
      if (idx < 0) {
        onClose();
        return;
      }
      if (idx >= groups.length) {
        onClose();
        return;
      }
      setGroupIndex(idx);
      setItemIndex(0);
    },
    [groups.length, onClose]
  );

  const next = useCallback(() => {
    if (!group) return;
    if (itemIndex < group.items.length - 1) {
      setItemIndex((i) => i + 1);
    } else {
      goToGroup(groupIndex + 1);
    }
  }, [group, itemIndex, groupIndex, goToGroup]);

  const prev = useCallback(() => {
    if (itemIndex > 0) {
      setItemIndex((i) => i - 1);
    } else {
      goToGroup(groupIndex - 1);
    }
  }, [itemIndex, groupIndex, goToGroup]);

  // Reset progress when the shown item changes.
  useEffect(() => {
    elapsedRef.current = 0;
    setProgress(0);
  }, [groupIndex, itemIndex]);

  // Drive the progress bar / auto-advance. Videos advance on their own `ended`
  // event and report progress via `timeupdate`, so the rAF loop only runs for
  // images.
  useEffect(() => {
    if (!item || item.type === "video") return;
    if (paused) return;

    startRef.current = performance.now() - elapsedRef.current;

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      elapsedRef.current = elapsed;
      const p = Math.min(elapsed / IMAGE_DURATION, 1);
      setProgress(p);
      if (p >= 1) {
        next();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [item, paused, next]);

  // Pause/resume video with the paused flag.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused, item?.id]);

  // Keyboard controls (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [next, prev, onClose]);

  const handlePointerDown = (e: React.PointerEvent) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      dy: 0,
      active: true,
    };
    setPaused(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dy = e.clientY - d.startY;
    if (dy > 0) {
      d.dy = dy;
      setDragY(dy);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    setPaused(false);

    const dx = e.clientX - d.startX;
    const dy = d.dy;
    setDragY(0);

    // Swipe down to dismiss.
    if (dy > DISMISS_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
      onClose();
      return;
    }
    // Horizontal swipe between accounts.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) goToGroup(groupIndex + 1);
      else goToGroup(groupIndex - 1);
      return;
    }
    // Tap: left third = back, right two-thirds = forward.
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      if (e.clientX < window.innerWidth / 3) prev();
      else next();
    }
  };

  if (!group || !item) return null;

  const backdropOpacity = Math.max(0, 1 - dragY / (DISMISS_THRESHOLD * 2.5));

  return createPortal(
    <div className="fixed inset-0 z-[70] touch-none select-none">
      <div
        className="absolute inset-0 bg-black transition-opacity"
        style={{ opacity: backdropOpacity }}
      />

      <div
        className="relative mx-auto flex h-full max-w-md flex-col"
        style={{
          transform: `translateY(${dragY}px)`,
          transition: dragY === 0 ? "transform 0.2s ease" : "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Progress bars */}
        <div
          className="absolute left-0 right-0 top-0 z-20 flex gap-1 px-3"
          style={{ marginTop: "calc(env(safe-area-inset-top) + 8px)" }}
        >
          {group.items.map((_, i) => (
            <div
              key={i}
              className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30"
            >
              <div
                className="h-full rounded-full bg-white"
                style={{
                  width:
                    i < itemIndex
                      ? "100%"
                      : i === itemIndex
                        ? `${progress * 100}%`
                        : "0%",
                }}
              />
            </div>
          ))}
        </div>

        {/* Header */}
        <div
          className="absolute left-0 right-0 top-0 z-20 flex items-center gap-2 px-3"
          style={{ marginTop: "calc(env(safe-area-inset-top) + 20px)" }}
        >
          <Avatar
            src={group.sourceIcon}
            name={group.sourceName}
            className="h-8 w-8 rounded-full border border-white/40"
            fallbackClassName="text-xs"
          />
          <span className="text-sm font-semibold text-white drop-shadow">
            {group.sourceName}
          </span>
          {item.publishedAt && (
            <span className="text-xs text-white/70">
              {timeAgo(item.publishedAt)}
            </span>
          )}
          <button
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            className="ml-auto flex h-8 w-8 items-center justify-center text-white"
            aria-label="Close"
          >
            <svg
              className="h-6 w-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Media */}
        <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black">
          {item.type === "video" && item.videoUrl ? (
            <video
              key={item.id}
              ref={videoRef}
              src={proxyUrl(item.videoUrl)}
              poster={item.imageUrl ? proxyUrl(item.imageUrl) : undefined}
              className="max-h-full max-w-full object-contain"
              autoPlay
              playsInline
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration) setProgress(v.currentTime / v.duration);
              }}
              onEnded={next}
            />
          ) : item.imageUrl ? (
            <img
              key={item.id}
              src={proxyUrl(item.imageUrl)}
              alt=""
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}

function timeAgo(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}
