import { useState } from "react";
import { createPortal } from "react-dom";

type SourceType = "twitter_user" | "instagram_story";

interface AddSourceDialogProps {
  onAdded: () => void;
  defaultType?: SourceType;
}

const HANDLE_RULES: Record<SourceType, { label: string; placeholder: string; pattern: RegExp; error: string }> = {
  twitter_user: {
    label: "Twitter Username",
    placeholder: "elonmusk",
    pattern: /^[a-zA-Z0-9_]{1,15}$/,
    error: "Invalid Twitter username",
  },
  instagram_story: {
    label: "Instagram Username",
    placeholder: "cristiano",
    pattern: /^[a-zA-Z0-9._]{1,30}$/,
    error: "Invalid Instagram username",
  },
};

export function AddSourceDialog({ onAdded, defaultType = "twitter_user" }: AddSourceDialogProps) {
  const [open, setOpen] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>(defaultType);
  const [handle, setHandle] = useState("");
  const [multiplier, setMultiplier] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const rules = HANDLE_RULES[sourceType];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = handle.trim().replace(/^@/, "");

    if (!clean) {
      setError(`Please enter ${sourceType === "twitter_user" ? "a Twitter username" : "an Instagram username"}`);
      return;
    }
    if (!rules.pattern.test(clean)) {
      setError(rules.error);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: clean,
          type: sourceType,
          ...(multiplier && !isNaN(parseFloat(multiplier)) ? { customMultiplier: parseFloat(multiplier) } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add source");
      }

      setHandle("");
      setMultiplier("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          setSourceType(defaultType);
          setError("");
          setOpen(true);
        }}
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs transition-all hover:bg-primary/90"
      >
        Add Account
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setOpen(false)}>
            <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold">Add Account</h3>
              <div className="mt-4 flex gap-1.5">
                {(["twitter_user", "instagram_story"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setSourceType(t); setError(""); }}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      sourceType === t
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t === "twitter_user" ? "Twitter" : "Instagram"}
                  </button>
                ))}
              </div>
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div className="space-y-2">
                  <label htmlFor="handle" className="text-sm font-medium">
                    {rules.label}
                  </label>
                  <input
                    id="handle"
                    placeholder={rules.placeholder}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                    autoFocus
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="multiplier" className="text-sm font-medium">
                    Boost Multiplier <span className="text-muted-foreground font-normal">(optional, 0.1–10)</span>
                  </label>
                  <input
                    id="multiplier"
                    type="text"
                    inputMode="decimal"
                    placeholder="1"
                    value={multiplier}
                    onChange={(e) => setMultiplier(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
                >
                  {loading ? "Adding..." : "Add"}
                </button>
              </form>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
