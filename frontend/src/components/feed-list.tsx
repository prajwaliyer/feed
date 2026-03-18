import { useCallback, useRef, useState } from "react";
import { useFeed } from "@/hooks/use-feed";
import { FeedItemCard } from "./feed-item";

type FeedTab = "foryou" | "all";

const FEED_TABS: { label: string; value: FeedTab }[] = [
  { label: "For You", value: "foryou" },
  { label: "All", value: "all" },
];

const PULL_THRESHOLD = 60;

function getScrollTop() {
  return Math.max(
    window.scrollY ?? 0,
    document.documentElement.scrollTop ?? 0,
    document.body.scrollTop ?? 0
  );
}

interface FeedListProps {
  starred?: boolean;
}

export function FeedList({ starred }: FeedListProps) {
  const [activeTab, setActiveTab] = useState<FeedTab>("foryou");
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const startedAtTop = useRef(false);

  const feedParams = starred
    ? { starred: true }
    : activeTab === "all"
      ? {}
      : { minRatio: 3 };

  const { items, isLoading, isLoadingMore, hasMore, loadMore, mutate } =
    useFeed(feedParams);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const lastItemRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (isLoadingMore) return;
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      });
      if (node) observerRef.current.observe(node);
    },
    [isLoadingMore, hasMore, loadMore]
  );

  const handleToggleStar = async (id: number, starred: boolean) => {
    await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isStarred: starred }),
    });
    mutate();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (refreshing) return;
    touchStartY.current = e.touches[0].clientY;
    startedAtTop.current = getScrollTop() <= 0;
    pulling.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (refreshing || !startedAtTop.current) return;
    const dy = e.touches[0].clientY - touchStartY.current;
    if (dy > 10 && getScrollTop() <= 0) {
      pulling.current = true;
      setPullDistance(Math.min(dy * 0.4, 100));
    } else if (dy <= 0) {
      pulling.current = false;
      setPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    if (!pulling.current) {
      setPullDistance(0);
      return;
    }
    pulling.current = false;
    if (pullDistance >= PULL_THRESHOLD) {
      setRefreshing(true);
      setPullDistance(40);
      const minWait = new Promise((r) => setTimeout(r, 1000));
      await Promise.all([mutate(), minWait]);
      setRefreshing(false);
    }
    setPullDistance(0);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="h-[env(safe-area-inset-top)]" />
        <div className="pt-2" />

        {!starred && (
          <div className="flex gap-1.5 px-4 pb-2 overflow-x-auto">
            {FEED_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab === tab.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Pull to refresh indicator inside header */}
        <div
          className="overflow-hidden flex items-center justify-center"
          style={{ height: pullDistance > 0 || refreshing ? `${refreshing ? 40 : pullDistance}px` : 0 }}
        >
          <div
            className={`h-5 w-5 rounded-full border-2 border-primary border-t-transparent ${refreshing ? "animate-spin" : ""}`}
            style={
              refreshing
                ? undefined
                : {
                    opacity: Math.min(pullDistance / PULL_THRESHOLD, 1),
                    transform: `rotate(${pullDistance * 4}deg)`,
                  }
            }
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-20 text-center text-muted-foreground">
          <p className="text-lg font-medium">No items yet</p>
          <p className="mt-1 text-sm">
            {starred
              ? "Star some items to see them here"
              : activeTab !== "foryou"
                ? "No tweets match this filter"
                : "Add sources and fetch to get started"}
          </p>
        </div>
      ) : (
        <>
          {items.map((item, index) => (
            <div key={item.id} ref={index === items.length - 1 ? lastItemRef : undefined}>
              <FeedItemCard item={item} onToggleStar={handleToggleStar} />
            </div>
          ))}
          {isLoadingMore && (
            <div className="flex items-center justify-center py-4">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
