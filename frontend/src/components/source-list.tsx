import { useState, useRef, useEffect } from "react";
import useSWR from "swr";
import { AddSourceDialog } from "./add-source-dialog";

interface Source {
  id: number;
  type: string;
  name: string;
  url: string;
  iconUrl: string | null;
  isImportant: boolean;
  priority: string | null;
  customMultiplier: string | null;
  createdAt: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type TopTab = "twitter_user" | "other";

function OverflowMenu({
  source,
  onDelete,
  onSetMultiplier,
}: {
  source: Source;
  onDelete: (id: number) => void;
  onSetMultiplier: (id: number, multiplier: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const saveMultiplier = () => {
    if (!inputRef.current) return;
    const val = inputRef.current.value.trim();
    const parsed = parseFloat(val);
    if (val && !isNaN(parsed) && parsed > 0) {
      onSetMultiplier(source.id, val);
    } else if (!val && source.customMultiplier) {
      onSetMultiplier(source.id, null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        saveMultiplier();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [open]);

  const handleOpen = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setFlipUp(spaceBelow < 180);
    }
    setOpen(!open);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted transition-colors"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {open && (
        <div className={`absolute right-0 z-20 w-44 rounded-lg border border-border bg-popover py-1 shadow-lg ${flipUp ? "bottom-9" : "top-9"}`}>
          <div className="px-3 py-2">
            <label className="text-xs text-muted-foreground">Boost (0.1–10)</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                placeholder="1"
                defaultValue={source.customMultiplier ?? ""}
                onBlur={saveMultiplier}
                className="w-20 rounded border border-border bg-muted px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
              />
              {source.customMultiplier && (
                <button
                  onClick={() => { onSetMultiplier(source.id, null); setOpen(false); }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          <div className="my-1 border-t border-border" />

          <button
            onClick={() => { onDelete(source.id); setOpen(false); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-muted transition-colors"
          >
            <span>&#10005;</span>
            Remove Source
          </button>
        </div>
      )}
    </div>
  );
}

export function SourceList() {
  const { data: sources, mutate } = useSWR<Source[]>("/api/sources", fetcher);
  const [topTab, setTopTab] = useState<TopTab>("twitter_user");
  const [search, setSearch] = useState("");

  const handleDelete = async (id: number) => {
    await fetch(`/api/sources?id=${id}`, { method: "DELETE" });
    mutate();
  };

  const handleSetMultiplier = async (id: number, multiplier: string | null) => {
    await fetch(`/api/sources?id=${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customMultiplier: multiplier ? parseFloat(multiplier) : null }),
    });
    mutate();
  };

  const twitterSources = sources?.filter((s) => s.type === "twitter_user") ?? [];
  const otherSources = sources?.filter((s) => s.type !== "twitter_user") ?? [];

  const byTab = topTab === "other" ? otherSources : twitterSources;

  const sorted = [...byTab].sort((a, b) => {
    const aMultiplier = a.customMultiplier ? parseFloat(a.customMultiplier) : 1;
    const bMultiplier = b.customMultiplier ? parseFloat(b.customMultiplier) : 1;
    return bMultiplier - aMultiplier;
  });

  const filtered = search
    ? sorted.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="h-[env(safe-area-inset-top)]" />
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-lg font-semibold">Sources</h2>
          <AddSourceDialog onAdded={() => mutate()} />
        </div>

        <div className="px-4 pb-2">
          <input
            type="text"
            placeholder="Search accounts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
          />
        </div>

        <div className="flex gap-1.5 px-4 pb-2">
          {(["twitter_user", "other"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setTopTab(tab)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                topTab === tab
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {tab === "twitter_user" ? "Twitter" : "Other"}
            </button>
          ))}
        </div>

      </div>

      {!sources ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-20 text-center text-muted-foreground">
          <p className="text-lg font-medium">
            {topTab === "other" ? "No other sources yet" : "No Twitter accounts yet"}
          </p>
          <p className="mt-1 text-sm">
            Add a Twitter account to get started
          </p>
        </div>
      ) : (
        <ul>
          {filtered.map((source) => (
            <li
              key={source.id}
              className="flex items-center gap-3 border-b border-border px-4 py-3"
            >
              {source.iconUrl ? (
                <img
                  src={`/api/proxy?url=${encodeURIComponent(source.iconUrl)}`}
                  alt=""
                  className="h-10 w-10 rounded-full bg-muted"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-bold">
                  {source.name[0].toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="font-medium text-sm truncate">@{source.name}</p>
                  {source.customMultiplier && (
                    <span className={`shrink-0 text-[10px] ${parseFloat(source.customMultiplier) > 1 ? "text-green-500" : parseFloat(source.customMultiplier) < 1 ? "text-red-400" : "text-muted-foreground"}`}>
                      {source.customMultiplier}x
                    </span>
                  )}
                </div>
              </div>
              <OverflowMenu
                source={source}
                onDelete={handleDelete}
                onSetMultiplier={handleSetMultiplier}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
