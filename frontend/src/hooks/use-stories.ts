import useSWR from "swr";

export interface StoryMedia {
  id: number;
  type: "image" | "video";
  videoUrl: string | null;
  imageUrl: string | null;
  url: string | null;
  isRead: boolean;
  publishedAt: string | null;
}

export interface StoryGroup {
  sourceId: number;
  sourceName: string | null;
  sourceIcon: string | null;
  items: StoryMedia[];
  hasUnseen: boolean;
}

interface StoriesResponse {
  groups: StoryGroup[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useStories() {
  const { data, error, isLoading, mutate } = useSWR<StoriesResponse>(
    "/api/stories",
    fetcher,
    { refreshInterval: 5 * 60 * 1000 }
  );

  return {
    groups: data?.groups ?? [],
    error,
    isLoading,
    mutate,
  };
}
