"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PatientActions } from "@/components/PatientActions";
import { PatientDrawer, type DrawerLog } from "@/components/PatientDrawer";
import { PatientSearch } from "@/components/PatientSearch";
import { ScheduleSmsDialog } from "@/components/ScheduleSmsDialog";
import { FollowUpTrack, FollowUpTrackLegend } from "@/components/FollowUpTrack";
import { useToast } from "@/components/ToastProvider";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconArrowLeft, IconArrowRight, IconSend, IconUsers, IconX } from "@/components/ui/icons";
import { daysSince, formatDate, formatNumber } from "@/components/ui/format";
import { PATIENT_STATUS, statusMeta } from "@/components/ui/status";
import { isRealSend } from "@/lib/sms/outcome";
import { requestSend } from "@/lib/sms/sendClient";
import type { TrackState, TrackStep } from "@/lib/patients/followupTrack";
import type { StepOption } from "@/types/clinic";

/** One step of a patient's follow-up track, aligned by index with `steps`. */
export type CompactTrack = { s: TrackState; at?: string };

/** Everything a list row needs — and nothing more, since every patient ships. */
export type PatientListRow = {
  id: string;
  /** First + last name when known, else the full name. */
  name: string;
  fullName: string;
  phone: string | null;
  normalizedPhone: string | null;
  email: string | null;
  lastBookingAt: string | null;
  treatment: string | null;
  doNotContact: boolean;
  status: string;
  sentCount: number;
  track: CompactTrack[];
};

type Sort = "oldest" | "recent";
type ViewParams = { status: string; sort: Sort; q: string; page: number };
type BulkState = "idle" | "sending" | "done";

const PAGE_SIZE = 50;

// Filter tabs, in the order staff reach for them. "No valid booking" only
// appears when it has members, so an empty edge case doesn't cost a tab.
const FILTERS = [
  "all",
  "Ready",
  "Waiting",
  "Sent",
  "Future booking",
  "Delivery pending",
  "Needs review",
  "Missing phone",
  "Do not contact",
  "No valid booking",
];

// ── URL state ────────────────────────────────────────────────────────────────
// The URL stays the source of truth (dashboard links, back/forward, reload,
// shareable views), but it is written with the History API: Next syncs
// useSearchParams from it without a server round trip.

function readParams(sp: { get(name: string): string | null }): ViewParams {
  const page = parseInt(sp.get("page") ?? "1", 10);
  return {
    status: sp.get("status") ?? "all",
    sort: sp.get("sort") === "recent" ? "recent" : "oldest",
    q: sp.get("q") ?? "",
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

function hrefFor(p: ViewParams): string {
  const qs = new URLSearchParams();
  if (p.status !== "all") qs.set("status", p.status);
  if (p.sort !== "oldest") qs.set("sort", p.sort);
  if (p.q) qs.set("q", p.q);
  if (p.page > 1) qs.set("page", String(p.page));
  const s = qs.toString();
  return `/app/patients${s ? `?${s}` : ""}`;
}

function toTrack(steps: StepOption[], compact: CompactTrack[]): TrackStep[] {
  return steps.map((step, i) => ({
    id: step.id,
    day: step.day,
    active: step.active,
    state: compact[i]?.s ?? "upcoming",
    at: compact[i]?.at ?? null,
  }));
}

// ── Row ──────────────────────────────────────────────────────────────────────
// Memoized: ticking one checkbox re-renders one row, not fifty.

type RowProps = {
  row: PatientListRow;
  steps: StepOption[];
  selected: boolean;
  sentCount: number;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onSchedule: (id: string) => void;
  onDelete: (id: string) => void;
};

const Row = memo(function Row({ row, steps, selected, sentCount, onToggle, onOpen, onSchedule, onDelete }: RowProps) {
  const days = daysSince(row.lastBookingAt);
  const meta = statusMeta(row.status);
  const track = useMemo(() => toTrack(steps, row.track), [steps, row.track]);

  return (
    <tr className={selected ? "is-selected" : undefined}>
      <td>
        <input
          type="checkbox"
          className="cb"
          checked={selected}
          onChange={() => onToggle(row.id)}
          aria-label={`Markera ${row.name}`}
        />
      </td>

      <td>
        <button type="button" className="pt-name" onClick={() => onOpen(row.id)} title="Visa detaljer och SMS-historik">
          {row.name}
        </button>
        {/* Two lines, always: phone, then SMS count if any, else email.
            Everything is in the tooltip and the drawer. */}
        <span className="pt-sub" title={[row.phone, row.email].filter(Boolean).join(" · ") || undefined}>
          {row.phone ? (
            <span className="pt-phone">{row.phone}</span>
          ) : (
            <span className="pt-missing">Saknar telefon</span>
          )}
          {sentCount > 0 ? (
            <> · <span className="pt-sms-count">{sentCount} SMS skicka{sentCount !== 1 ? "de" : "t"}</span></>
          ) : row.email ? (
            <> · {row.email}</>
          ) : null}
        </span>
      </td>

      <td>
        {row.lastBookingAt ? (
          <div className="pt-date">
            {formatDate(row.lastBookingAt)}
            {days != null && <span> · {days} d</span>}
          </div>
        ) : (
          <span className="faint">—</span>
        )}
        {row.treatment && (
          <span className="pt-sub" style={{ maxWidth: 200 }} title={row.treatment}>
            {row.treatment}
          </span>
        )}
      </td>

      <td className="pt-col-track"><FollowUpTrack track={track} /></td>

      <td>
        <span className={`chip ${meta.chip}`} title={meta.hint}>{meta.label}</span>
      </td>

      <td>
        <PatientActions
          patientId={row.id}
          patientName={row.name}
          doNotContact={row.doNotContact}
          steps={steps}
          onShowHistory={() => onOpen(row.id)}
          onSchedule={() => onSchedule(row.id)}
          onDelete={() => onDelete(row.id)}
        />
      </td>
    </tr>
  );
});

// ── List ─────────────────────────────────────────────────────────────────────

export function PatientsClient({ rows, steps }: { rows: PatientListRow[]; steps: StepOption[] }) {
  const searchParams = useSearchParams();
  const params = readParams(searchParams);
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);

  // The field updates instantly; the URL follows a moment later.
  const [query, setQuery] = useState(params.q);
  const urlQ = useRef(params.q);
  useEffect(() => {
    // Back/forward changed the URL's query: bring the field along.
    if (params.q !== urlQ.current) {
      urlQ.current = params.q;
      setQuery(params.q);
    }
  }, [params.q]);

  const navigate = useCallback((next: Partial<ViewParams>, mode: "push" | "replace" = "push") => {
    const merged = { ...readParams(new URLSearchParams(window.location.search)), ...next };
    urlQ.current = merged.q;
    window.history[mode === "push" ? "pushState" : "replaceState"](null, "", hrefFor(merged));
  }, []);

  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (qTimer.current) clearTimeout(qTimer.current); }, []);
  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => navigate({ q: value.trim(), page: 1 }, "replace"), 300);
  }, [navigate]);

  // ── Derived view ──
  const prepared = useMemo(
    () =>
      rows.map((row) => ({
        row,
        days: daysSince(row.lastBookingAt) ?? 0,
        hay: [row.fullName, row.name, row.phone, row.email].filter(Boolean).join(" ").toLowerCase(),
      })),
    [rows]
  );

  const deferredQuery = useDeferredValue(query);
  const search = deferredQuery.trim().toLowerCase();
  const searched = useMemo(
    () => (search ? prepared.filter((p) => p.hay.includes(search)) : prepared),
    [prepared, search]
  );

  // Tab counts follow the search, so the tabs show where the matches are.
  const counts = useMemo(() => {
    const map = new Map<string, number>([["all", searched.length]]);
    for (const p of searched) map.set(p.row.status, (map.get(p.row.status) ?? 0) + 1);
    return map;
  }, [searched]);

  const filtered = useMemo(() => {
    const list = params.status === "all" ? [...searched] : searched.filter((p) => p.row.status === params.status);
    list.sort((a, b) => (params.sort === "recent" ? a.days - b.days : b.days - a.days));
    return list;
  }, [searched, params.status, params.sort]);

  // While a new query is still on its way into the URL, show its first page.
  const pageParam = query.trim() !== params.q ? 1 : params.page;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(pageParam, totalPages);
  const from = filtered.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const to = Math.min(currentPage * PAGE_SIZE, filtered.length);
  const pageRows = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((p) => p.row),
    [filtered, currentPage]
  );

  // ── Selection & bulk send ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkState, setBulkState] = useState<BulkState>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [bulkErrors, setBulkErrors] = useState<{ name: string; reason: string }[]>([]);

  const nameById = useMemo(() => new Map(rows.map((r) => [r.id, r.fullName])), [rows]);
  const pageIds = pageRows.map((r) => r.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const someSelected = selected.size > 0;

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(pageIds));
  }

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulkState("idle");
    setDoneMessage(null);
    setBulkErrors([]);
  }, []);

  async function sendToSelected() {
    if (bulkState !== "idle") return;
    const ids = [...selected];
    setBulkState("sending");
    setBulkErrors([]);
    setProgress({ done: 0, total: ids.length });

    let sent = 0;
    let skipped = 0;
    let dryRun = 0;
    const failures: { name: string; reason: string }[] = [];
    for (const id of ids) {
      const patientName = nameById.get(id) ?? id;
      const outcome = await requestSend({ patientId: id });
      if (isRealSend(outcome.kind)) {
        sent++;
      } else if (outcome.kind === "dry_run") {
        dryRun++;
      } else if (outcome.kind === "skipped") {
        // Not a failure, but not a send either — counted separately so the
        // summary cannot imply these patients were contacted.
        skipped++;
        failures.push({ name: patientName, reason: outcome.message });
      } else {
        failures.push({ name: patientName, reason: outcome.detail ?? outcome.message });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setBulkState("done");
    setBulkErrors(failures);
    const problems = failures.length - skipped;
    const parts = [`${sent} skickade`];
    if (dryRun > 0) parts.push(`${dryRun} i testläge`);
    if (skipped > 0) parts.push(`${skipped} hoppades över`);
    if (problems > 0) parts.push(`${problems} misslyckades`);
    const msg = parts.join(", ");
    setDoneMessage(msg);
    toast.push({
      tone: problems > 0 ? "error" : skipped > 0 ? "warning" : "success",
      title: msg,
      detail: failures.length > 0
        ? failures.slice(0, 3).map((f) => `${f.name}: ${f.reason}`).join(" · ")
        : null,
    });
    setSelected(new Set());
    setTimeout(() => { setBulkState("idle"); setDoneMessage(null); setBulkErrors([]); }, 10000);
  }

  // ── Drawer, schedule and delete — one of each for the whole list ──
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sentDelta, setSentDelta] = useState<Map<string, number>>(new Map());
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleKey, setScheduleKey] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const drawerRow = drawerId ? rowById.get(drawerId) ?? null : null;
  const scheduleRow = scheduleId ? rowById.get(scheduleId) ?? null : null;
  const deleteRow = deleteId ? rowById.get(deleteId) ?? null : null;

  const openDrawer = useCallback((id: string) => { setDrawerId(id); setDrawerOpen(true); }, []);
  const openSchedule = useCallback((id: string) => {
    setScheduleId(id);
    setScheduleKey((k) => k + 1);
    setScheduleOpen(true);
  }, []);
  const askDelete = useCallback((id: string) => setDeleteId(id), []);

  const onLogDeleted = useCallback((log: DrawerLog) => {
    if (log.status !== "sent" && log.status !== "delivered") return;
    setSentDelta((prev) => {
      const next = new Map(prev);
      if (drawerId) next.set(drawerId, (next.get(drawerId) ?? 0) - 1);
      return next;
    });
  }, [drawerId]);

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleteBusy(true);
    await fetch(`/api/patients/${deleteId}`, { method: "DELETE" });
    window.location.reload();
  }

  // ── Navigation helpers ──
  function goToPage(page: number) {
    navigate({ page });
    const top = panelRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function linkProps(next: Partial<ViewParams>) {
    return {
      href: hrefFor({ ...params, q: query.trim(), ...next }),
      onClick: (e: React.MouseEvent) => {
        // Let modified clicks open a new tab as with any link.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate({ q: query.trim(), ...next });
      },
    };
  }

  function clearFilters() {
    setQuery("");
    navigate({ status: "all", q: "", page: 1 });
  }

  const visibleFilters = FILTERS.filter(
    (f) => f !== "No valid booking" || (counts.get(f) ?? 0) > 0 || params.status === f
  );

  const rangeText = filtered.length === 0
    ? "Inga träffar"
    : `Visar ${formatNumber(from)}–${formatNumber(to)} av ${formatNumber(filtered.length)}`;

  const pager = totalPages > 1 && (
    <div className="row" style={{ gap: 6 }}>
      <button
        type="button"
        className="icon-btn sm bordered"
        aria-label="Föregående sida"
        disabled={currentPage <= 1}
        onClick={() => goToPage(currentPage - 1)}
      >
        <IconArrowLeft size={14} />
      </button>
      <span className="tnum" style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", minWidth: 72, textAlign: "center" }}>
        Sida {currentPage} / {totalPages}
      </span>
      <button
        type="button"
        className="icon-btn sm bordered"
        aria-label="Nästa sida"
        disabled={currentPage >= totalPages}
        onClick={() => goToPage(currentPage + 1)}
      >
        <IconArrowRight size={14} />
      </button>
    </div>
  );

  const showBulkBar = someSelected || bulkState !== "idle";
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <div className="panel rise" style={{ ["--i" as string]: 1 }} ref={panelRef}>
        <nav className="tabs pt-tabs" aria-label="Filtrera på status">
          {visibleFilters.map((filter) => {
            const count = counts.get(filter) ?? 0;
            const meta = filter === "all" ? null : PATIENT_STATUS[filter];
            const isActive = params.status === filter;
            return (
              <a
                key={filter}
                {...linkProps({ status: filter, page: 1 })}
                className={`tab${isActive ? " active" : ""}${count === 0 && !isActive ? " is-empty" : ""}`}
                aria-current={isActive ? "page" : undefined}
                title={meta ? `${meta.label} — ${meta.hint}` : "Alla kunder"}
              >
                {meta && <span className="tab-dot" style={{ background: meta.dot }} />}
                {meta ? (meta.short ?? meta.label) : "Alla"}
                <span className="tab-count">{formatNumber(count)}</span>
              </a>
            );
          })}
        </nav>

        <div className="pt-toolbar">
          <PatientSearch value={query} onChange={onQueryChange} />
          <span className="pt-toolbar-meta" aria-live="polite">
            {rangeText}
            {search && <> för &ldquo;{deferredQuery.trim()}&rdquo;</>}
          </span>
          <div className="pt-toolbar-end">
            <div className="seg" role="group" aria-label="Sortering">
              <a
                {...linkProps({ sort: "oldest", page: 1 })}
                className={params.sort === "oldest" ? "active" : undefined}
                aria-current={params.sort === "oldest" ? "true" : undefined}
                title="Längst sedan senaste besök först"
              >
                Äldst besök först
              </a>
              <a
                {...linkProps({ sort: "recent", page: 1 })}
                className={params.sort === "recent" ? "active" : undefined}
                aria-current={params.sort === "recent" ? "true" : undefined}
                title="Senaste besök först"
              >
                Senast besök först
              </a>
            </div>
            {pager}
          </div>
        </div>

        <div className="table-scroll">
          <table className="pt-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    className="cb"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = selectedOnPage > 0 && !allSelected; }}
                    onChange={toggleAll}
                    disabled={pageRows.length === 0}
                    aria-label={allSelected ? "Avmarkera alla på sidan" : "Markera alla på sidan"}
                    title={allSelected ? "Avmarkera alla" : "Markera alla"}
                  />
                </th>
                <th>Kund</th>
                <th>Senaste besök</th>
                <th className="pt-col-track" title="En markering per uppföljningssteg, med dag under">Uppföljningar</th>
                <th>Status</th>
                <th><span className="sr-only">Åtgärder</span></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  steps={steps}
                  selected={selected.has(row.id)}
                  sentCount={Math.max(0, row.sentCount + (sentDelta.get(row.id) ?? 0))}
                  onToggle={toggleOne}
                  onOpen={openDrawer}
                  onSchedule={openSchedule}
                  onDelete={askDelete}
                />
              ))}
            </tbody>
          </table>
        </div>

        {pageRows.length === 0 && (
          <div className="empty-state">
            <span className="empty-icon"><IconUsers /></span>
            <span className="empty-title">Inga kunder matchar</span>
            <span>Prova ett annat filter eller en annan sökning.</span>
            {(params.status !== "all" || query.trim()) && (
              <button type="button" className="secondary sm" style={{ marginTop: 10 }} onClick={clearFilters}>
                Rensa filter och sökning
              </button>
            )}
          </div>
        )}

        <div className="panel-foot">
          <FollowUpTrackLegend />
          <div className="row" style={{ gap: 14 }}>
            <span className="tnum">{rangeText}</span>
            {pager}
          </div>
        </div>
      </div>

      {/* Floating bulk-action bar — sticks to the bottom while scrolling the list */}
      {showBulkBar && (
        <div className="bulk-bar" role="region" aria-label="Massåtgärder">
          <span className="bulk-count">
            {bulkState === "idle"
              ? `${selected.size} ${selected.size === 1 ? "vald" : "valda"}`
              : bulkState === "sending"
                ? `Skickar ${progress.done}/${progress.total}`
                : "Klart"}
          </span>
          {bulkState === "sending" && (
            <span className="bulk-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          )}
          {bulkState === "done" && doneMessage && <span className="bulk-msg" aria-live="polite">{doneMessage}</span>}
          <span className="bulk-sep" aria-hidden="true" />
          {bulkState !== "done" && (
            <button
              type="button"
              className="accent sm"
              disabled={bulkState !== "idle" || !someSelected}
              onClick={sendToSelected}
            >
              {bulkState === "sending" ? <span className="spinner" aria-hidden="true" /> : <IconSend size={14} />}
              {bulkState === "sending" ? `Skickar ${progress.done}/${progress.total}…` : "Skicka SMS till valda"}
            </button>
          )}
          <button type="button" className="ghost sm" onClick={clearSelection} disabled={bulkState === "sending"}>
            <IconX size={14} /> {bulkState === "done" ? "Stäng" : "Avmarkera"}
          </button>
        </div>
      )}

      {bulkState === "done" && bulkErrors.length > 0 && (
        <div className="bulk-errors" role="status">
          <strong>{bulkErrors.length} {bulkErrors.length === 1 ? "kund" : "kunder"} fick inget SMS:</strong>
          <ul>
            {bulkErrors.map((e, i) => (
              <li key={`${e.name}-${i}`}><strong>{e.name}</strong> — {e.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {drawerRow && (
        <PatientDrawer
          key={drawerRow.id}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          patient={drawerRow}
          track={toTrack(steps, drawerRow.track)}
          onLogDeleted={onLogDeleted}
        />
      )}

      {scheduleRow && (
        <ScheduleSmsDialog
          key={scheduleKey}
          open={scheduleOpen}
          patientId={scheduleRow.id}
          patientName={scheduleRow.name}
          steps={steps}
          onClose={() => setScheduleOpen(false)}
          onScheduled={() => setScheduleOpen(false)}
        />
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="Ta bort patienten?"
        description={
          <>
            {deleteRow ? <strong>{deleteRow.name}</strong> : "Patienten"} tas bort permanent tillsammans med sin koppling
            till utskicken. Detta kan inte ångras.
          </>
        }
        confirmLabel="Ta bort permanent"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onClose={() => setDeleteId(null)}
      />
    </>
  );
}
