"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A small accessible dialog: role="dialog" + aria-modal, labelled by its title, closes on Escape and on a click outside,
 * moves focus into itself and puts it back where it was. No dependency.
 */
export function Modal({ title, onClose, children, wide = false, tone = "clank" }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; tone?: "clank" | "danger" }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab" && node) {
        const f = [...node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (f.length === 0) return;
        const first = f[0] as HTMLElement;
        const last = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      before?.focus?.();
    };
  }, []);
  // Portalled to <body>: the panels that open dialogs have a chamfered clip-path, which would clip a fixed child to the panel.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`plate ${tone === "danger" ? "" : "plate-clank"} max-h-[92dvh] w-full overflow-y-auto p-4 outline-none sm:p-5 ${wide ? "max-w-2xl" : "max-w-sm"}`}
        style={{ ["--chamfer" as string]: "12px" }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className={`font-display text-lg tracking-wider uppercase ${tone === "danger" ? "text-danger" : "text-clank-300"}`}>{title}</h2>
          <button type="button" onClick={onClose} className="-mt-1 -mr-1 rounded p-1 text-steel-300 hover:text-paper" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
