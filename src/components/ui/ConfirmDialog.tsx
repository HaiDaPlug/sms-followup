"use client";

import { Modal } from "./Modal";

/**
 * In-app replacement for window.confirm(): same yes/no gate, but styled,
 * keyboard-safe, and able to stay open with a spinner while the action runs.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Avbryt",
  tone = "danger",
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      padded
      dismissible={!busy}
      footerClassName="end"
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "danger-solid" : undefined}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: "var(--fs-body)", color: "var(--text-mid)", lineHeight: 1.55 }}>{description}</div>
    </Modal>
  );
}
