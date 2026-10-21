"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FEEDBACK_ENDPOINT } from "@/lib/config";
import type { Store } from "@/lib/types";

type Status = "idle" | "sending" | "sent" | "error";

const IS_DEV = process.env.NODE_ENV !== "production";
/** The form only appears on the live site once FEEDBACK_ENDPOINT is set. */
export const FEEDBACK_ENABLED = Boolean(FEEDBACK_ENDPOINT) || IS_DEV;

const inputClass =
  "w-full rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[15px] outline-none ring-emerald-500/30 transition placeholder:text-neutral-400 focus:border-emerald-500/50 focus:ring-4 dark:border-white/10 dark:bg-neutral-950";

/**
 * "Suggest an item" button + a two-field form (product, preferred store). Submissions go
 * to Formspree, which emails them to the site owner; the owner's address never appears in the page.
 */
export function FeedbackDialog({
  stores,
  trigger,
}: {
  stores: Store[];
  trigger: (open: () => void) => React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // Keep the native <dialog> in sync with isOpen (showModal gives focus trapping and Esc to close).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  if (!FEEDBACK_ENABLED) return null;
  const chains = [...new Set(stores.map((s) => s.chain))].sort();

  const open = () => {
    if (status !== "sending") setStatus("idle");
    setIsOpen(true);
  };
  const close = () => setIsOpen(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (fields._gotcha) return; // spam trap: only bots fill the hidden field
    if (!FEEDBACK_ENDPOINT) {
      setStatus("error");
      return;
    }
    setStatus("sending");
    try {
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ product: fields.product, store: fields.store, _subject: `Product suggestion: ${fields.product}` }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("sent");
      form.reset();
    } catch {
      setStatus("error");
    }
  }

  return (
    <>
      {trigger(open)}
      <dialog
        ref={dialogRef}
        aria-labelledby="feedback-title"
        onClose={close} // Esc key
        onClick={(e) => e.target === e.currentTarget && close()} // click outside the panel closes it
        className="m-0 mt-auto w-full max-w-none bg-transparent p-0 backdrop:bg-black/40 backdrop:backdrop-blur-sm sm:m-auto sm:max-w-md"
      >
        <div className="rounded-t-3xl bg-white p-5 text-neutral-900 shadow-2xl sm:rounded-3xl sm:p-6 dark:bg-neutral-900 dark:text-neutral-100">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id="feedback-title" className="text-lg font-semibold tracking-tight">
              Suggest an item
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="-mr-2 -mt-1 rounded-full p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {status === "sent" ? (
            <div className="rounded-2xl bg-emerald-50 p-5 text-center dark:bg-emerald-500/10">
              <p className="font-semibold text-emerald-800 dark:text-emerald-300">Thanks, suggestion sent!</p>
              <div className="mt-4 flex justify-center gap-2">
                <button type="button" onClick={() => setStatus("idle")} className="rounded-full px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-500/10">
                  Suggest another
                </button>
                <button type="button" onClick={close} className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {!FEEDBACK_ENDPOINT && (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  Preview only: set FEEDBACK_ENDPOINT in web/lib/config.ts to receive suggestions. This form is
                  hidden on the live site until then.
                </p>
              )}
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">Product name</span>
                <input name="product" required maxLength={120} placeholder="e.g. Salmon fillet" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">Preferred store</span>
                <select name="store" defaultValue="Any" className={inputClass}>
                  <option>Any</option>
                  {chains.map((chain) => (
                    <option key={chain}>{chain}</option>
                  ))}
                  <option>Other</option>
                </select>
              </label>
              {/* Spam trap: hidden from people, often filled in by bots. */}
              <input type="text" name="_gotcha" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />

              {status === "error" && (
                <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                  {FEEDBACK_ENDPOINT ? "Couldn't send that. Please try again in a moment." : "The form isn't set up yet."}
                </p>
              )}
              <button
                type="submit"
                disabled={status === "sending"}
                className="w-full rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-70"
              >
                {status === "sending" ? "Sending…" : "Send"}
              </button>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}
