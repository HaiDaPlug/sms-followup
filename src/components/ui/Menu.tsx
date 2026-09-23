"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconMore } from "./icons";

/**
 * Overflow ("⋯") menu. Portaled and fixed-positioned so a clipped table or
 * panel never cuts it off; flips above the trigger when there is no room
 * below. Arrow keys move between items, Escape closes and returns focus.
 */

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: React.ReactNode;
      tone?: "danger";
      disabled?: boolean;
      hint?: string;
    }
  | { divider: true }
  | { heading: string };

export function Menu({
  items,
  label = "Fler åtgärder",
  trigger,
  triggerClassName = "icon-btn",
  disabled = false,
}: {
  items: MenuItem[];
  label?: string;
  trigger?: React.ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setPos(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // Position after the menu has rendered, so its real size is known.
  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current;
    const m = menuRef.current;
    if (!t || !m) return;
    const r = t.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    const gap = 6;
    const above = r.bottom + gap + mh > window.innerHeight - 8 && r.top - gap - mh > 8;
    const top = above ? r.top - gap - mh : r.bottom + gap;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    setPos({ top, left, above });
    const first = m.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    first?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    }
    function onScrollOrResize() { close(false); }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, close]);

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger ?? <IconMore />}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={`menu${pos?.above ? " from-bottom" : ""}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? "visible" : "hidden",
            }}
            onKeyDown={onMenuKey}
          >
            {items.map((item, i) => {
              if ("divider" in item) return <div key={`d${i}`} className="menu-sep" role="separator" />;
              if ("heading" in item) return <div key={`h${i}`} className="menu-label">{item.heading}</div>;
              return (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`menu-item${item.tone === "danger" ? " danger" : ""}`}
                  aria-disabled={item.disabled || undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    close(false);
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.hint && <span className="muted" style={{ fontSize: 12 }}>{item.hint}</span>}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
