import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const DISMISS_THRESHOLD = 150;

export function ImageLightbox({
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
