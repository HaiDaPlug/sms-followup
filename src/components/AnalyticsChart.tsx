"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsBookingRow, AnalyticsConversionRow } from "@/lib/analytics/getAnalyticsData";
import type { LifetimeStats } from "@/lib/analytics/lifetime";
import { ATTRIBUTION_WINDOWS, type AttributionDays } from "@/lib/analytics/attributionWindow";
import { stockholmDayKey } from "@/lib/analytics/dayKeys";
import { TrendChart, SERIES, type SeriesKey, type TrendPoint } from "./analytics/TrendChart";
import { IconAlert, IconInfo, IconPulse, IconRefresh, IconSearch, IconX } from "./ui/icons";
import { formatDate, formatNumber, formatPercent, formatTime, plural } from "./ui/format";

interface SeriesPoint {
  day: string;
  bookings: number;
  sms: number;
}

interface Props {
  initialSeries: SeriesPoint[];
  initialBookings: AnalyticsBookingRow[];
  initialConversions: AnalyticsConversionRow[];
  initialActiveBookingsCount: number;
  initialSmsSentCount: number;
  initialSmsPatientCount: number;
  initialConversionRate: number | null;
  initialDays: number;
  initialAttributionDays: AttributionDays;
  initialConversionsOutsideWindow: number;
  initialLifetime: LifetimeStats;
}

const PERIOD_OPTIONS = [
  { label: "30 dagar", days: 30 },
  { label: "90 dagar", days: 90 },
  { label: "180 dagar", days: 180 },
  { label: "365 dagar", days: 365 },
];

type Granularity = "day" | "week";
type DetailTab = "bookings" | "conversions";

const DETAIL_PAGE = 50;

// ── Date bucketing ───────────────────────────────────────────────────────────

function utcDate(dayKey: string) {
  return new Date(`${dayKey}T00:00:00Z`);
}

function shortDay(dayKey: string) {
  return utcDate(dayKey).toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "UTC" });
}

function longDay(dayKey: string) {
  return utcDate(dayKey).toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function weekStart(dayKey: string) {
  const d = utcDate(dayKey);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function isoWeek(dayKey: string) {
  const d = utcDate(dayKey);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // Thursday of that week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

function buildPoints(series: SeriesPoint[], matchedByDay: Map<string, number>, granularity: Granularity): TrendPoint[] {
  if (granularity === "day") {
    return series.map((s) => ({
      label: shortDay(s.day),
      title: longDay(s.day),
      sms: s.sms,
      bookings: s.bookings,
      matched: matchedByDay.get(s.day) ?? 0,
    }));
  }
  const weeks = new Map<string, TrendPoint>();
  for (const s of series) {
    const key = weekStart(s.day);
    const point = weeks.get(key) ?? {
      label: `v. ${isoWeek(s.day)}`,
      title: `Vecka ${isoWeek(s.day)} · från ${shortDay(key)}`,
      sms: 0,
      bookings: 0,
      matched: 0,
    };
    point.sms += s.sms;
    point.bookings += s.bookings;
    point.matched += matchedByDay.get(s.day) ?? 0;
    weeks.set(key, point);
  }
  return [...weeks.values()];
}

// ── Small presentational pieces ──────────────────────────────────────────────

/** Line key mirroring the chart: solid, or dashed for the SMS-matched subset. */
function SeriesKeyMark({ k }: { k: SeriesKey }) {
  const { color, dashed } = SERIES[k];
  return (
    <span
      className="stat-key"
      style={{
        width: 16,
        height: 2,
        borderRadius: 1,
        background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color,
      }}
    />
  );
}

/**
 * The chart's headline: what the period says, in one sentence, from the data
 * itself. Compares bookings in the two halves of the period; small absolute
 * differences read as stable so a couple of bookings never make a "trend".
 */
function trendHeadline(points: TrendPoint[], totals: { sms: number; bookings: number; matched: number }): string {
  if (totals.sms === 0 && totals.bookings === 0) return "Ingen aktivitet under perioden";
  if (totals.bookings === 0) return "SMS har gått ut, men inga bokningar har kommit in ännu";
  const mid = Math.floor(points.length / 2);
  const first = points.slice(0, mid).reduce((n, p) => n + p.bookings, 0);
  const second = points.slice(mid).reduce((n, p) => n + p.bookings, 0);
  const trend =
    second >= first * 1.25 && second - first >= 3 ? "Bokningarna ökade mot slutet av perioden"
    : second <= first * 0.75 && first - second >= 3 ? "Bokningarna minskade mot slutet av perioden"
    : "Bokningarna låg stabilt under perioden";
  return totals.matched > 0
    ? `${trend} — ${totals.matched} kom efter ett SMS`
    : trend;
}

function Stat({
  label,
  keyMark,
  value,
  zero,
  meta,
  children,
  title,
}: {
  label: string;
  keyMark?: SeriesKey;
  value: React.ReactNode;
  zero?: boolean;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat">
        <p className="stat-label" title={title}>
          {keyMark && <SeriesKeyMark k={keyMark} />}
          {label}
          {title && <IconInfo size={13} className="faint" />}
        </p>
        <p className={`stat-value${zero ? " is-zero" : ""}`}>{value}</p>
        {meta && <p className="stat-meta">{meta}</p>}
        {children}
      </div>
    </div>
  );
}

function RateBar({ rate, color = "var(--series-bookings)" }: { rate: number | null; color?: string }) {
  return (
    <span className="row" style={{ gap: 10, minWidth: 140 }}>
      <span className="bar-track" style={{ flex: 1, height: 8 }}>
        <span className="bar-fill" style={{ width: `${Math.round((rate ?? 0) * 100)}%`, background: color }} />
      </span>
      <span className="tnum" style={{ minWidth: 40, textAlign: "right", fontWeight: 600, color: rate === null ? "var(--text-faint)" : "var(--text)" }}>
        {formatPercent(rate)}
      </span>
    </span>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export function AnalyticsChart({
  initialSeries,
  initialBookings,
  initialConversions,
  initialActiveBookingsCount,
  initialSmsSentCount,
  initialSmsPatientCount,
  initialConversionRate,
  initialDays,
  initialAttributionDays,
  initialConversionsOutsideWindow,
  initialLifetime,
}: Props) {
  const [days, setDays] = useState(initialDays);
  const [attributionDays, setAttributionDays] = useState<AttributionDays>(initialAttributionDays);
  const [conversionsOutsideWindow, setConversionsOutsideWindow] = useState(
    initialConversionsOutsideWindow
  );
  const [series, setSeries] = useState(initialSeries);
  const [bookings, setBookings] = useState(initialBookings);
  const [conversions, setConversions] = useState(initialConversions);
  const [activeBookingsCount, setActiveBookingsCount] = useState(initialActiveBookingsCount);
  const [smsSentCount, setSmsSentCount] = useState(initialSmsSentCount);
  const [smsPatientCount, setSmsPatientCount] = useState(initialSmsPatientCount);
  const [conversionRate, setConversionRate] = useState(initialConversionRate);
  const [lifetime, setLifetime] = useState(initialLifetime);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{ d: number; a: AttributionDays } | null>(null);

  // Presentation-only state
  // Sends go out in daily batches, so beyond a month a daily line is mostly
  // spikes; weeks show the shape. Daily stays one click away.
  const [granularity, setGranularity] = useState<Granularity>(initialDays >= 90 ? "week" : "day");
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());
  const [detailTab, setDetailTab] = useState<DetailTab>("bookings");
  const [detailQuery, setDetailQuery] = useState("");
  const [detailLimit, setDetailLimit] = useState(DETAIL_PAGE);

  // Period switches can overlap: a slow 365-day request must not overwrite a
  // fast 30-day one that the user asked for afterwards.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  async function load(d: number, attribution: AttributionDays) {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setLoading(true);
    setLoadError(null);
    setLastRequest({ d, a: attribution });
    try {
      const res = await fetch(
        `/api/analytics?days=${d}&attributionDays=${attribution}`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`Analytics request failed with ${res.status}`);
      const data = await res.json() as {
        series: SeriesPoint[];
        bookings: AnalyticsBookingRow[];
        conversions: AnalyticsConversionRow[];
        activeBookingsCount: number;
        smsSentCount: number;
        smsPatientCount: number;
        conversionRate: number | null;
        conversionsOutsideWindow: number;
        lifetime: LifetimeStats;
      };
      // Longer periods read better in weeks; follow the period unless the
      // user picked a granularity for this same period themselves.
      if (d !== days) setGranularity(d >= 90 ? "week" : "day");
      setDays(d);
      setAttributionDays(attribution);
      setSeries(data.series);
      setBookings(data.bookings);
      setConversions(data.conversions);
      setActiveBookingsCount(data.activeBookingsCount);
      setSmsSentCount(data.smsSentCount);
      setSmsPatientCount(data.smsPatientCount);
      setConversionRate(data.conversionRate);
      setConversionsOutsideWindow(data.conversionsOutsideWindow);
      // Period-independent, but the attribution columns follow the picker.
      setLifetime(data.lifetime);
      setDetailLimit(DETAIL_PAGE);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return; // superseded — keep the newer request's state
      console.error("Failed to load analytics period", error);
      setLoadError("Kunde inte ladda analysdata. Försök igen.");
    } finally {
      if (inFlight.current === controller) setLoading(false);
    }
  }

  const matchedByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of conversions) {
      const key = stockholmDayKey(new Date(c.booking_effective_at));
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [conversions]);

  const points = useMemo(
    () => buildPoints(series, matchedByDay, granularity),
    [series, matchedByDay, granularity]
  );

  const totals = useMemo(() => ({
    sms: series.reduce((n, s) => n + s.sms, 0),
    bookings: series.reduce((n, s) => n + s.bookings, 0),
    matched: points.reduce((n, p) => n + p.matched, 0),
  }), [series, points]);

  const hasData = series.some((s) => s.bookings > 0 || s.sms > 0);

  function toggleSeries(k: SeriesKey) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  // Detail tables — client-side search and "show more" over the loaded period.
  const q = detailQuery.trim().toLowerCase();
  const filteredBookings = useMemo(
    () => !q ? bookings : bookings.filter((b) =>
      [b.patient_name, b.treatment, b.practitioner].some((v) => v?.toLowerCase().includes(q))
    ),
    [bookings, q]
  );
  const filteredConversions = useMemo(
    () => !q ? conversions : conversions.filter((c) => c.patient_name?.toLowerCase().includes(q)),
    [conversions, q]
  );
  const detailRows = detailTab === "bookings" ? filteredBookings.length : filteredConversions.length;

  const distributionMax = Math.max(...lifetime.distribution.map((b) => b.count), 1);
  const distributionTotal = lifetime.distribution.reduce((n, b) => n + b.count, 0);

  const funnel = [
    { label: "Kontaktade kunder", count: lifetime.patientsContacted, rate: lifetime.patientsContacted > 0 ? 1 : null, hint: "Fick minst ett SMS" },
    { label: "Bokade igen", count: lifetime.patientsRebooked, rate: lifetime.eventualRate, hint: "Bokade om någon gång efter ett SMS, oavsett hur lång tid det tog." },
    { label: `Inom ${attributionDays} dagar`, count: lifetime.attributedPatients, rate: lifetime.attributedRate, hint: `Bokade om inom ${attributionDays} dagar efter utskicket — nära nog i tid för att rimligen tillskrivas SMS:et.` },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>

      {/* ── Filter row — scopes everything below it ── */}
      <div className="filter-bar rise" style={{ marginBottom: 4 }}>
        <div className="filter-group">
          <span className="filter-label" id="period-label">Period</span>
          <div className="seg" role="group" aria-labelledby="period-label">
            {PERIOD_OPTIONS.map((o) => (
              <button
                key={o.days}
                type="button"
                className={days === o.days ? "active" : undefined}
                aria-pressed={days === o.days}
                disabled={loading}
                onClick={() => load(o.days, attributionDays)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* The attribution window decides how long after an SMS a rebooking
            still counts as SMS-driven. It drives the conversion rate, the
            SMS-matched list and the "inom X d" columns — not the chart's
            period, so it is labelled as its own question. */}
        <div className="filter-group">
          <span
            className="filter-label row"
            id="attr-label"
            style={{ gap: 5 }}
            title="Räkna en ombokning som SMS-driven om den skedde inom så här många dagar efter utskicket."
          >
            Tillskrivs inom <IconInfo size={13} />
          </span>
          <div className="seg" role="group" aria-labelledby="attr-label">
            {ATTRIBUTION_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={attributionDays === w ? "active" : undefined}
                aria-pressed={attributionDays === w}
                disabled={loading}
                onClick={() => load(days, w)}
                title={`Räkna en ombokning som SMS-driven om den skedde inom ${w} dagar efter utskicket`}
              >
                {w} d
              </button>
            ))}
          </div>
        </div>

        <span className="row muted" style={{ marginLeft: "auto", gap: 8, minHeight: 36 }} aria-live="polite">
          {loading ? <><span className="spinner" /> Uppdaterar…</> : null}
        </span>
      </div>

      {loadError && (
        <div className="notice error" role="alert">
          <IconAlert />
          <span style={{ flex: 1 }}>{loadError}</span>
          {lastRequest && (
            <button type="button" className="secondary sm" onClick={() => load(lastRequest.d, lastRequest.a)}>
              <IconRefresh size={14} /> Försök igen
            </button>
          )}
        </div>
      )}

      {/* ── Period KPIs — each keyed to its chart series ── */}
      <div
        className="grid cols-4 rise"
        style={{ ["--i" as string]: 1, opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}
      >
        <Stat
          label="SMS skickade"
          keyMark="sms"
          value={formatNumber(smsSentCount)}
          zero={smsSentCount === 0}
          meta={smsPatientCount > 0 ? `till ${formatNumber(smsPatientCount)} ${plural(smsPatientCount, "kund", "kunder")}` : "Inga utskick under perioden"}
        />
        <Stat
          label="Bokningar"
          keyMark="bookings"
          value={formatNumber(activeBookingsCount)}
          zero={activeBookingsCount === 0}
          meta="Aktiva, avbokade ej medräknade"
        />
        <Stat
          label="SMS-matchade bokningar"
          keyMark="matched"
          value={formatNumber(conversions.length)}
          zero={conversions.length === 0}
          meta={`Bokade inom ${attributionDays} d efter ett SMS`}
        />
        <Stat
          label="Konverteringsgrad"
          value={conversionRate === null ? "—" : `${Math.round(conversionRate * 100)} %`}
          zero={conversionRate === null}
          title={`Andel av de kunder som fick SMS under perioden som bokade om inom ${attributionDays} dagar.`}
          meta={smsPatientCount > 0 ? `av ${formatNumber(smsPatientCount)} kunder · inom ${attributionDays} d` : "Inga SMS under perioden"}
        >
          <span className="bar-track" style={{ height: 6, marginTop: 6 }} aria-hidden="true">
            <span className="bar-fill" style={{ width: `${Math.round((conversionRate ?? 0) * 100)}%` }} />
          </span>
        </Stat>
      </div>

      {/* ── Trend chart ── */}
      <section
        className="panel rise"
        style={{ ["--i" as string]: 2, opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}
        aria-labelledby="trend-title"
      >
        <div className="trend-head">
          <div style={{ minWidth: 0 }}>
            <p
              className="trend-eyebrow"
              title="Bokningar = nya bokningar per dag (avbokade ej medräknade). SMS-matchade = bokningar som kom inom tillskrivningsfönstret efter ett SMS."
            >
              Aktivitet över tid <IconInfo size={13} />
            </p>
            <h2 className="trend-title" id="trend-title">{trendHeadline(points, totals)}</h2>
            <p className="panel-sub tnum">
              {formatNumber(totals.bookings)} bokningar · {formatNumber(totals.sms)} SMS skickade ·{" "}
              {formatNumber(totals.matched)} SMS-matchade — senaste {days} dagarna, per {granularity === "day" ? "dag" : "vecka"}
            </p>
          </div>

          <div className="trend-controls">
            {/* Legend — doubles as a series toggle */}
            <div className="row wrap" style={{ gap: 2 }} role="group" aria-label="Visa eller dölj serier">
              {(Object.keys(SERIES) as SeriesKey[]).map((k) => {
                const off = hidden.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className="reset legend-item"
                    aria-pressed={!off}
                    onClick={() => toggleSeries(k)}
                    title={off ? "Visa serien" : "Dölj serien"}
                    style={{ opacity: off ? 0.4 : 1 }}
                  >
                    <SeriesKeyMark k={k} />
                    <span>{SERIES[k].name}</span>
                  </button>
                );
              })}
            </div>
            <div className="seg seg-sm" role="group" aria-label="Upplösning">
              {(["day", "week"] as Granularity[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={granularity === g ? "active" : undefined}
                  aria-pressed={granularity === g}
                  onClick={() => setGranularity(g)}
                >
                  {g === "day" ? "Dag" : "Vecka"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ padding: "4px 16px 14px" }}>
          {!hasData ? (
            <div className="empty-state" style={{ padding: "64px 0" }}>
              <span className="empty-icon"><IconPulse /></span>
              <span className="empty-title">Ingen aktivitet under perioden</span>
              <span>Välj en längre period för att se utskick och bokningar.</span>
            </div>
          ) : (
            <TrendChart points={points} hidden={hidden} />
          )}
        </div>
      </section>

      {/* ── SMS effect — all-time, independent of the period ── */}
      <div className="section-head" style={{ marginBottom: 0 }}>
        <div>
          <h2 className="section-title">Effekt av SMS</h2>
          <p className="section-sub">
            Sedan första utskicket{lifetime.firstSmsAt ? ` ${formatDate(lifetime.firstSmsAt)}` : ""} · alla bokningar, inkl. import · oberoende av vald period
          </p>
        </div>
      </div>

      <div className="grid-12" style={{ alignItems: "stretch" }}>
        {/* Funnel */}
        <section className="panel span-5">
          <div className="panel-head">
            <div>
              <h3 className="panel-title">Sedan start</h3>
              <p className="panel-sub">{formatNumber(lifetime.smsSent)} SMS skickade totalt</p>
            </div>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 18 }}>
            {funnel.map((stage, i) => (
              <div key={stage.label} title={stage.hint}>
                <div className="row-between" style={{ marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{stage.label}</span>
                  <span className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: "var(--fs-lg)" }}>{formatNumber(stage.count)}</strong>
                    {i > 0 && <span className="muted tnum" style={{ minWidth: 40, textAlign: "right" }}>{formatPercent(stage.rate)}</span>}
                  </span>
                </div>
                <span className="bar-track" style={{ height: 12 }}>
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.round((stage.rate ?? 0) * 100)}%`, opacity: 1 - i * 0.22 }}
                  />
                </span>
              </div>
            ))}
            <p className="muted" style={{ borderTop: "1px solid var(--hairline)", paddingTop: 14 }}>
              {formatNumber(lifetime.patientsContacted)} kontaktade → {formatNumber(lifetime.patientsRebooked)} bokade igen →{" "}
              {formatNumber(lifetime.attributedPatients)} inom {attributionDays} dagar
            </p>
            {lifetime.patientsContacted > 0 && lifetime.patientsContacted < 50 && (
              <p className="notice neutral" style={{ padding: "8px 12px" }}>
                <IconInfo /> Litet underlag — läs siffrorna som riktning, inte mätning.
              </p>
            )}
          </div>
        </section>

        {/* Time to rebooking */}
        <section className="panel span-7">
          <div className="panel-head">
            <div>
              <h3 className="panel-title">Tid till ombokning</h3>
              <p className="panel-sub">Hur lång tid det tog innan kunden bokade om efter ett SMS</p>
            </div>
          </div>
          <div className="panel-body">
            {distributionTotal === 0 ? (
              <div className="empty-state" style={{ padding: "32px 0" }}>
                <span className="empty-title">Inga ombokningar efter SMS ännu</span>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {lifetime.distribution.map((bucket) => (
                  <div
                    key={bucket.label}
                    style={{ display: "grid", gridTemplateColumns: "96px 1fr 76px", alignItems: "center", gap: 14 }}
                  >
                    <span className="muted" style={{ fontWeight: 600 }}>{bucket.label}</span>
                    <span className="bar-track" style={{ height: 18, borderRadius: 5 }}>
                      <span
                        className="bar-fill"
                        style={{ width: `${(bucket.count / distributionMax) * 100}%`, borderRadius: "0 4px 4px 0" }}
                      />
                    </span>
                    <span className="tnum" style={{ textAlign: "right" }}>
                      <strong style={{ color: bucket.count === 0 ? "var(--text-faint)" : "var(--text)" }}>{bucket.count}</strong>
                      <span className="muted" style={{ marginLeft: 6 }}>
                        {Math.round((bucket.count / distributionTotal) * 100)} %
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Per follow-up */}
        <section className="panel span-12">
          <div className="panel-head">
            <div>
              <h3 className="panel-title">Resultat per uppföljning</h3>
              <p className="panel-sub">Varje ombokning krediteras den senaste uppföljningen före bokningen.</p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Uppföljning</th>
                  <th className="num">Skickade</th>
                  <th className="num">Kunder</th>
                  <th className="num">Bokade igen</th>
                  <th>Andel som bokade igen</th>
                  <th className="num">Inom {attributionDays} d</th>
                  <th className="num">Median</th>
                </tr>
              </thead>
              <tbody>
                {lifetime.perStep.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty-state">Inga uppföljningar konfigurerade.</div></td></tr>
                ) : (
                  lifetime.perStep.map((step) => (
                    <tr key={step.key}>
                      <td>
                        <span className="row" style={{ gap: 8 }}>
                          <span className="strong">{step.label}</span>
                          {step.exists && !step.active && <span className="tag">inaktiv</span>}
                        </span>
                      </td>
                      <td className="num">{formatNumber(step.smsSent)}</td>
                      <td className="num">{formatNumber(step.patientsContacted)}</td>
                      <td className="num">{formatNumber(step.rebookedPatients)}</td>
                      <td style={{ minWidth: 200 }}><RateBar rate={step.eventualRate} /></td>
                      <td className="num">{formatNumber(step.attributed)}</td>
                      <td className="num">{step.medianDays === null ? "—" : `${step.medianDays} d`}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ── Period details ── */}
      <div className="section-head" style={{ marginBottom: 0 }}>
        <div>
          <h2 className="section-title">Detaljer för perioden</h2>
          <p className="section-sub">De enskilda bokningarna bakom siffrorna ovan — senaste {days} dagarna.</p>
        </div>
      </div>

      <section
        className="panel"
        style={{ opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}
      >
        <div className="tabs" style={{ padding: "0 12px" }} role="tablist" aria-label="Detaljlistor">
          <button
            type="button"
            role="tab"
            aria-selected={detailTab === "bookings"}
            className={`tab${detailTab === "bookings" ? " active" : ""}`}
            onClick={() => { setDetailTab("bookings"); setDetailLimit(DETAIL_PAGE); }}
          >
            <SeriesKeyMark k="bookings" /> Bokningar
            <span className="tab-count">{formatNumber(activeBookingsCount)}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailTab === "conversions"}
            className={`tab${detailTab === "conversions" ? " active" : ""}`}
            onClick={() => { setDetailTab("conversions"); setDetailLimit(DETAIL_PAGE); }}
          >
            <SeriesKeyMark k="matched" /> SMS-matchade
            <span className="tab-count">{formatNumber(conversions.length)}</span>
          </button>
        </div>

        <div className="pt-toolbar">
          <div className="search">
            <span className="search-icon"><IconSearch /></span>
            <input
              type="search"
              value={detailQuery}
              onChange={(e) => { setDetailQuery(e.target.value); setDetailLimit(DETAIL_PAGE); }}
              placeholder={detailTab === "bookings" ? "Sök kund, tjänst eller behandlare…" : "Sök kund…"}
              aria-label="Sök i listan"
            />
            {detailQuery && (
              <span className="search-trail">
                <button type="button" className="icon-btn sm" aria-label="Rensa sökningen" onClick={() => setDetailQuery("")}>
                  <IconX size={14} />
                </button>
              </span>
            )}
          </div>
          <span className="pt-toolbar-meta">
            {q ? `${formatNumber(detailRows)} träffar` : `${formatNumber(detailRows)} rader`}
          </span>
          {detailTab === "conversions" && (
            <span className="pt-toolbar-end muted">
              Tillskrivning: inom {attributionDays} dagar
            </span>
          )}
        </div>

        {detailTab === "conversions" && conversionsOutsideWindow > 0 && (
          <div className="notice info" style={{ margin: "14px 20px 0" }}>
            <IconInfo />
            <span>
              {conversionsOutsideWindow} ytterligare ombokning{conversionsOutsideWindow === 1 ? "" : "ar"} skedde
              efter mer än {attributionDays} dagar och räknas inte här.
            </span>
          </div>
        )}

        <div className="table-scroll" style={{ marginTop: detailTab === "conversions" && conversionsOutsideWindow > 0 ? 14 : 0 }}>
          {detailTab === "bookings" ? (
            <table>
              <thead>
                <tr>
                  <th>Registrerad</th>
                  <th>Besökstid</th>
                  <th>Kund</th>
                  <th>Tjänst</th>
                  <th>Behandlare</th>
                  <th>Källa</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredBookings.slice(0, detailLimit).map((b) => (
                  <tr key={b.id}>
                    <td className="tnum">
                      {formatDate(b.recorded_at)}
                      {formatTime(b.recorded_at) && <span className="faint" style={{ marginLeft: 6 }}>{formatTime(b.recorded_at)}</span>}
                    </td>
                    <td className="tnum">{formatDate(b.booking_at)}</td>
                    <td className="strong">{b.patient_name ?? <span className="faint">—</span>}</td>
                    <td className="truncate" style={{ maxWidth: 220 }} title={b.treatment ?? undefined}>{b.treatment ?? "—"}</td>
                    <td>{b.practitioner ?? "—"}</td>
                    <td><span className="tag">{b.via_webhook ? "Webhook" : "CSV"}</span></td>
                    <td>
                      {b.cancelled
                        ? <span className="badge sm failed">Avbokad</span>
                        : <span className="badge sm sent">Aktiv</span>}
                    </td>
                  </tr>
                ))}
                {filteredBookings.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <span className="empty-title">{q ? "Inga bokningar matchar sökningen" : "Inga bokningar under perioden"}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Kund</th>
                  <th>Bokad</th>
                  <th>SMS skickat</th>
                  <th>Uppföljning</th>
                  <th className="num">Dagar efter SMS</th>
                </tr>
              </thead>
              <tbody>
                {filteredConversions.slice(0, detailLimit).map((c) => (
                  <tr key={c.id}>
                    <td className="strong">{c.patient_name ?? <span className="faint">—</span>}</td>
                    <td className="tnum">
                      {formatDate(c.booking_effective_at)}
                      {formatTime(c.booking_effective_at) && (
                        <span className="faint" style={{ marginLeft: 6 }}>{formatTime(c.booking_effective_at)}</span>
                      )}
                    </td>
                    <td className="tnum">{formatDate(c.reminder_log_sent_at)}</td>
                    <td>
                      {/* Named by the follow-up's trigger day; the position is
                          only meaningful against the step list of the day. */}
                      {c.step_day != null ? (
                        <span className="tag">{c.step_day} dagar</span>
                      ) : c.sequence_number != null ? (
                        <span className="tag">steg {c.sequence_number}</span>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="num">
                      <span className="badge sm plain sent tnum">{c.days_since_sms} d</span>
                    </td>
                  </tr>
                ))}
                {filteredConversions.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">
                        <span className="empty-title">{q ? "Inga träffar" : "Inga matchade bokningar under perioden"}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {detailRows > detailLimit && (
          <div className="panel-foot" style={{ justifyContent: "center" }}>
            <button type="button" className="secondary sm" onClick={() => setDetailLimit((n) => n + DETAIL_PAGE)}>
              Visa {Math.min(DETAIL_PAGE, detailRows - detailLimit)} till
              <span className="muted" style={{ fontWeight: 400 }}>· {formatNumber(detailRows - detailLimit)} kvar</span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
