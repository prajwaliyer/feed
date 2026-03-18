import { useState } from "react";
import { createPortal } from "react-dom";

interface AddSourceDialogProps {
  onAdded: () => void;
}

export function AddSourceDialog({ onAdded }: AddSourceDialogProps) {
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState("");
  const [multiplier, setMultiplier] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = handle.trim().replace(/^@/, "");

    if (!clean) {
      setError("Please enter a Twitter handle");
      return;
    }
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(clean)) {
      setError("Invalid Twitter handle");
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
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-xs transition-all hover:bg-primary/90"
      >
        Add Account
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={() => setOpen(false)}>
            <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold">Add Twitter Account</h3>
              <form onSubmit={handleSubmit} className="mt-4 space-y-4">
                <div className="space-y-2">
                  <label htmlFor="handle" className="text-sm font-medium">
                    Twitter Handle
                  </label>
                  <input
                    id="handle"
                    placeholder="@elonmusk"
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
