"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";
import { Menu, type MenuItem } from "./ui/Menu";
import {
  IconBan,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconHistory,
  IconRefresh,
  IconSend,
  IconTrash,
} from "./ui/icons";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";
import type { StepOption } from "@/types/clinic";

type SendState = "idle" | "sending" | "sent" | "failed";

/**
 * Row actions: a split "Skicka SMS" button (main part sends the automatic
 * next follow-up, the caret picks a specific one) and an overflow menu for
 * the less frequent actions. Every send keeps the six-state outcome contract:
 * a dry run is never shown as "Skickat".
 *
 * Scheduling and deleting open dialogs owned by the list, one of each for the
 * whole page, so fifty rows don't mount a hundred hidden dialogs.
 */
export function PatientActions({
  patientId,
  patientName,
  doNotContact = false,
  steps = [],
  onShowHistory,
  onSchedule,
  onDelete,
}: {
  patientId: string;
  patientName?: string;
  doNotContact?: boolean;
  steps?: StepOption[];
  onShowHistory?: () => void;
  onSchedule: () => void;
  onDelete: () => void;
}) {
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [dncBusy, setDncBusy] = useState(false);
  const [isDnc, setIsDnc] = useState(doNotContact);
  const toast = useToast();
  const router = useRouter();

  async function handleSend(stepId: string | null) {
    if (sendState !== "idle") return;
    setSendState("sending");
    setSendError(null);

    const outcome = await requestSend({
      patientId,
      stepId: stepId ?? undefined,
    });
    toast.outcome(outcome);

    // A dry run is deliberately NOT shown as "Skickat": it produced no SMS.
    if (isRealSend(outcome.kind)) {
      setSendState("sent");
      router.refresh();
      setTimeout(() => setSendState("idle"), 1200);
    } else if (outcome.kind === "dry_run") {
      setSendState("idle");
      router.refresh();
    } else {
      setSendError(outcome.message);
      setSendState("failed");
      setTimeout(() => { setSendState("idle"); setSendError(null); }, 6000);
    }
  }

  async function handleDnc() {
    if (dncBusy) return;
    setDncBusy(true);
    const endpoint = isDnc
      ? `/api/patients/${patientId}/reactivate`
      : `/api/patients/${patientId}/do-not-contact`;
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    setIsDnc(!isDnc);
    setDncBusy(false);
    window.location.reload();
  }

  const busy = sendState !== "idle";

  const stepItems: MenuItem[] = [
    { heading: "Skicka uppföljning" },
    {
      label: "Automatisk (nästa steg)",
      icon: <IconSend size={14} />,
      onSelect: () => handleSend(null),
    },
    ...steps.map<MenuItem>((s) => ({
      label: `${s.day} dagar`,
      hint: s.active ? undefined : "inaktiv",
      onSelect: () => handleSend(s.id),
    })),
  ];

  const moreItems: MenuItem[] = [
    { label: "Schemalägg SMS…", icon: <IconCalendar size={14} />, onSelect: onSchedule },
    ...(onShowHistory
      ? [{ label: "Visa detaljer och historik", icon: <IconHistory size={14} />, onSelect: onShowHistory } as MenuItem]
      : []),
    { divider: true },
    isDnc
      ? { label: dncBusy ? "Sparar…" : "Återaktivera", icon: <IconRefresh size={14} />, onSelect: handleDnc, disabled: dncBusy }
      : { label: dncBusy ? "Sparar…" : "Kontakta ej", icon: <IconBan size={14} />, onSelect: handleDnc, disabled: dncBusy },
    { label: "Ta bort patient…", icon: <IconTrash size={14} />, tone: "danger", onSelect: onDelete },
  ];

  const mainLabel =
    sendState === "sending" ? "Skickar…"
    : sendState === "sent" ? "Skickat"
    : sendState === "failed" ? "Misslyckades"
    : "Skicka SMS";

  return (
    <div className="pa">
      <div className="pa-row">
        <div className={`split${sendState === "sent" ? " is-sent" : sendState === "failed" ? " is-failed" : ""}`}>
          <button
            type="button"
            className="split-main sm"
            disabled={busy || isDnc}
            aria-busy={sendState === "sending"}
            onClick={() => handleSend(null)}
            title={isDnc ? "Kunden är markerad Kontakta ej" : "Skicka nästa uppföljning"}
          >
            {sendState === "sending" ? <span className="spinner" aria-hidden="true" />
              : sendState === "sent" ? <IconCheck size={14} />
              : <IconSend size={14} />}
            {mainLabel}
          </button>
          {steps.length > 0 && (
            <Menu
              items={stepItems}
              label="Välj uppföljning att skicka"
              trigger={<IconChevronDown size={14} />}
              triggerClassName="split-caret"
              disabled={busy || isDnc}
            />
          )}
        </div>

        <Menu items={moreItems} label={`Fler åtgärder${patientName ? ` för ${patientName}` : ""}`} />
      </div>

      {sendError && <p className="pa-msg error">{sendError}</p>}
    </div>
  );
}
