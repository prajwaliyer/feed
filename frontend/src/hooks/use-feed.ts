import { useEffect, useRef } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";

interface FeedItem {
  id: number;
  sourceId: number;
  guid: string;
  title: string | null;
  content: string | null;
  url: string | null;
  author: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  likeCount: number | null;
  replyCount: number | null;
  engagementRatio: number | null;
  sourceName: string | null;
  sourceIcon: string | null;
}

interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useFeed(params?: {
  starred?: boolean;
  source?: number;
  minRatio?: number;
  important?: boolean;
}) {
  const { data, error, size, setSize, isValidating, mutate } =
    useSWRInfinite<FeedPage>(
      (pageIndex, previousPageData) => {
        if (previousPageData && !previousPageData.nextCursor) return null;

        const searchParams = new URLSearchParams();
        if (pageIndex > 0 && previousPageData?.nextCursor) {
          searchParams.set("cursor", previousPageData.nextCursor);
        }
        if (params?.starred) searchParams.set("starred", "true");
        if (params?.source) searchParams.set("source", params.source.toString());
        if (params?.minRatio) searchParams.set("minRatio", params.minRatio.toString());
        if (params?.important) searchParams.set("important", "true");

        return `/api/items?${searchParams.toString()}`;
      },
      fetcher,
      { revalidateFirstPage: false }
    );

  const { data: lastFetchData } = useSWR<{ lastFetch: number }>(
    "/api/last-fetch",
    fetcher,
    { refreshInterval: 30000 }
  );

  const prevFetchTime = useRef<number>(0);
  useEffect(() => {
    if (lastFetchData?.lastFetch && lastFetchData.lastFetch !== prevFetchTime.current) {
      if (prevFetchTime.current !== 0) {
        mutate();
      }
      prevFetchTime.current = lastFetchData.lastFetch;
    }
  }, [lastFetchData?.lastFetch, mutate]);

  const items = data ? data.flatMap((page) => page.items) : [];
  const isLoadingMore = size > 0 && data && typeof data[size - 1] === "undefined";
  const hasMore = data ? data[data.length - 1]?.nextCursor !== null : false;

  return {
    items,
    error,
    isLoading: !data && !error,
    isLoadingMore,
    isValidating,
    hasMore,
    loadMore: () => setSize(size + 1),
    mutate,
  };
}

export type { FeedItem };
