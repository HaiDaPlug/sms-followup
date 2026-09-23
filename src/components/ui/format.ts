/**
 * Presentation-only date and number formatting, shared by the UI so every
 * page says "12 mars 2026" / "i dag 09:14" the same way. Clinic-local time.
 */

const TZ = "Europe/Stockholm";

export function formatDate(iso: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
    year: opts.year === false ? undefined : "numeric",
    timeZone: TZ,
  });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${formatDate(iso)} ${formatTime(iso)}`.trim();
}

function dayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** "i dag 09:14", "igår 16:02", "mån 09:00" within a week, else "3 sep". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  const key = dayKey(d);
  if (key === today) return `i dag ${formatTime(iso)}`;
  if (key === yesterday) return `igår ${formatTime(iso)}`;
  const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (ageDays > 0 && ageDays < 6) {
    return `${d.toLocaleDateString("sv-SE", { weekday: "short", timeZone: TZ })} ${formatTime(iso)}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return formatDate(iso, { year: !sameYear });
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export function formatNumber(n: number): string {
  return n.toLocaleString("sv-SE");
}

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${Math.round(rate * 100)} %`;
}

/** Swedish singular/plural: plural(1, "patient", "patienter"). */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
