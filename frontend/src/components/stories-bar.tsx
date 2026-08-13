import { useState } from "react";
import { useStories } from "@/hooks/use-stories";
import { StoryViewer } from "./story-viewer";
import { Avatar } from "./avatar";

export function StoriesBar() {
  const { groups, mutate } = useStories();
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (groups.length === 0) return null;

  const markSeen = async (itemId: number) => {
    // Optimistically flip the local cache so the ring greys out immediately.
    mutate(
      (curr) =>
        curr
          ? {
              groups: curr.groups.map((g) => ({
                ...g,
                items: g.items.map((it) =>
                  it.id === itemId ? { ...it, isRead: true } : it
                ),
                hasUnseen: g.items.some(
                  (it) => it.id !== itemId && !it.isRead
                ),
              })),
            }
          : curr,
      { revalidate: false }
    );
    try {
      await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: true }),
      });
    } catch {
      /* best effort */
    }
  };

  return (
    <>
      <div className="flex gap-3 overflow-x-auto border-b border-border px-4 py-3 no-scrollbar">
        {groups.map((group, i) => (
          <button
            key={group.sourceId}
            onClick={() => setOpenIndex(i)}
            className="flex w-16 shrink-0 flex-col items-center gap-1"
          >
            <span
              className={`rounded-full p-[2.5px] ${
                group.hasUnseen
                  ? "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600"
                  : "bg-muted"
              }`}
            >
              <span className="block rounded-full bg-background p-[2px]">
                <Avatar
                  src={group.sourceIcon}
                  name={group.sourceName}
                  className="h-14 w-14 rounded-full"
                  fallbackClassName="text-lg"
                />
              </span>
            </span>
            <span className="w-full truncate text-center text-[11px] text-muted-foreground">
              {group.sourceName}
            </span>
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <StoryViewer
          groups={groups}
          initialGroup={openIndex}
          onClose={() => setOpenIndex(null)}
          onSeen={markSeen}
        />
      )}
    </>
  );
}
