"use client";

import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";
import { IconX } from "./icons";

/**
 * The one dialog in the app. Every popup used to hand-roll its own overlay,
 * header and close button, each with different Escape handling and none with
 * focus management; this replaces them.
 *
 * - Portaled to <body>, so transformed ancestors can't trap it.
 * - Escape and backdrop close only the topmost dialog, and only when
 *   `dismissible` (callers pass false while a request is in flight).
 * - Focus moves in on open ([data-autofocus] first, else the first field),
 *   Tab is trapped inside, and focus returns to the trigger on close.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Controls rendered at the right of the header, before the close button. */
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "dialog" | "drawer";
  dismissible?: boolean;
  /** Pad the body. Off for edge-to-edge lists. */
  padded?: boolean;
  footerClassName?: string;
};

const stack: string[] = [];
let scrollLocks = 0;
let savedOverflow = "";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal(props: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>{props.open && <ModalPanel key="modal" {...props} />}</AnimatePresence>,
    document.body
  );
}

function ModalPanel({
  onClose,
  title,
  description,
  headerExtra,
  footer,
  children,
  size = "md",
  variant = "dialog",
  dismissible = true,
  padded = false,
  footerClassName,
}: Props) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const downOnOverlay = useRef(false);
  const reduced = useReducedMotion();
  const isPresent = useIsPresent();
  const drawer = variant === "drawer";

  // Keep the latest handlers without re-running the mount effect.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  const presentRef = useRef(isPresent);
  presentRef.current = isPresent;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    stack.push(id);

    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLocks++;

    const raf = requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      const target =
        root.querySelector<HTMLElement>("[data-autofocus]") ??
        root.querySelector<HTMLElement>(
          ".modal-body input:not([disabled]):not([type=checkbox]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])"
        ) ??
        root;
      target.focus({ preventScroll: true });
    });

    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== id || !presentRef.current) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented || !dismissibleRef.current) return;
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
        if (items.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === root)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      const index = stack.lastIndexOf(id);
      if (index !== -1) stack.splice(index, 1);
      scrollLocks = Math.max(0, scrollLocks - 1);
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [id]);

  const panelMotion = drawer
    ? {
        initial: reduced ? { opacity: 0 } : { x: 48, opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: reduced ? { opacity: 0 } : { x: 48, opacity: 0 },
        transition: { duration: reduced ? 0.12 : 0.32, ease: [0.22, 1, 0.36, 1] as const },
      }
    : {
        initial: reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.975 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 },
        transition: { duration: reduced ? 0.12 : 0.26, ease: [0.22, 1, 0.36, 1] as const },
      };

  return (
    <motion.div
      className={`modal-overlay${drawer ? " is-drawer" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.1 : 0.2 }}
      onMouseDown={(e) => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnOverlay.current && dismissible) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`modal ${drawer ? "drawer" : size}`}
        {...panelMotion}
      >
        <div className="modal-head">
          <div className="modal-titles">
            <h2 id={titleId} className="modal-title">{title}</h2>
            {description && <div id={descId} className="modal-desc">{description}</div>}
          </div>
          {headerExtra && <div className="modal-head-extra">{headerExtra}</div>}
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={!dismissible}
            aria-label="Stäng"
            title="Stäng (Esc)"
          >
            <IconX />
          </button>
        </div>

        <div className={`modal-body${padded ? " padded" : ""}`}>{children}</div>

        {footer && <div className={`modal-foot${footerClassName ? ` ${footerClassName}` : ""}`}>{footer}</div>}
      </motion.div>
    </motion.div>
  );
}
