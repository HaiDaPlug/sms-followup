"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { AnalyticsBookingRow, AnalyticsConversionRow } from "@/lib/analytics/getAnalyticsData";
import type { LifetimeStats } from "@/lib/analytics/lifetime";
import { ATTRIBUTION_WINDOWS, type AttributionDays } from "@/lib/analytics/attributionWindow";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

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

// Validated categorical pair (see scripts/validate_palette.js) — brand teal + a
// clearly separated violet, both >= 3:1 on the white chart surface.
const COLOR_BOOKINGS = "#1c9686";
const COLOR_SMS = "#4a3aa7";

function formatDay(day: string): string {
  const d = new Date(day);
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("sv-SE", {
    day: "numeric", month: "short", year: "numeric"
  });
}

// Clock time in clinic-local terms, for the moment a booking reached us.
// Pinned to Europe/Stockholm rather than the viewer's timezone so the value
// matches what staff see in BokaDirekt and in the logs, from any machine.
function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)} %`;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleTimeString("sv-SE", {
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm"
  });
}

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
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return; // superseded — keep the newer request's state
      console.error("Failed to load analytics period", error);
      setLoadError("Kunde inte ladda analysdata. Försök igen.");
    } finally {
      if (inFlight.current === controller) setLoading(false);
    }
  }

  const hasData = series.some((s) => s.bookings > 0 || s.sms > 0);

  const option = {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: "var(--border-dark)", width: 1 } },
      backgroundColor: "var(--surface)",
      borderColor: "var(--border)",
      borderWidth: 1,
      padding: 10,
      extraCssText: "box-shadow: 0 8px 24px rgba(13,31,26,0.14); border-radius: 8px;",
      textStyle: { color: "var(--text)", fontSize: 14 },
      formatter: (params: unknown) => {
        const rows = params as Array<{ axisValueLabel: string; seriesName: string; value: number; color: string }>;
        if (!rows.length) return "";
        const body = rows.map((p) => `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 0;">
            <span style="display:flex;align-items:center;gap:6px;color:var(--text-muted);font-size: 14px;">
              <span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${p.color};"></span>
              ${p.seriesName}
            </span>
            <span style="font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;">${p.value}</span>
          </div>`).join("");
        return `<div style="font-weight:600;font-size: 12px;color:var(--text-muted);margin-bottom:6px;letter-spacing:0.02em;">${rows[0].axisValueLabel}</div>${body}`;
      },
    },
    legend: {
      data: ["Bokningar", "SMS skickade"],
      bottom: 0,
      textStyle: { color: "var(--text-muted)", fontSize: 14 },
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 24,
    },
    grid: { left: 36, right: 16, top: 20, bottom: 44 },
    xAxis: {
      type: "category",
      data: series.map((s) => formatDay(s.day)),
      boundaryGap: false,
      axisLine: { lineStyle: { color: "var(--border)" } },
      axisTick: { show: false },
      axisLabel: { color: "var(--text-muted)", fontSize: 12 },
    },
    yAxis: {
      type: "value",
      name: "Antal",
      nameTextStyle: { color: "var(--text-muted)", fontSize: 12, align: "left" },
      axisLine: { show: false },
      axisLabel: { color: "var(--text-muted)", fontSize: 12 },
      splitLine: { lineStyle: { color: "var(--border)", type: "solid" } },
      minInterval: 1,
    },
    series: [
      {
        name: "Bokningar",
        type: "line",
        data: series.map((s) => s.bookings),
        showSymbol: false,
        symbol: "circle",
        symbolSize: 8,
        lineStyle: { width: 2, color: COLOR_BOOKINGS },
        itemStyle: { color: COLOR_BOOKINGS, borderColor: "var(--surface)", borderWidth: 2 },
        areaStyle: { color: COLOR_BOOKINGS, opacity: 0.08 },
        emphasis: { focus: "series" },
      },
      {
        name: "SMS skickade",
        type: "line",
        data: series.map((s) => s.sms),
        showSymbol: false,
        symbol: "circle",
        symbolSize: 8,
        lineStyle: { width: 2, color: COLOR_SMS },
        itemStyle: { color: COLOR_SMS, borderColor: "var(--surface)", borderWidth: 2 },
        areaStyle: { color: COLOR_SMS, opacity: 0.08 },
        emphasis: { focus: "series" },
      },
    ],
  };

  return (
    <div style={{ display: "grid", gap: 24 }}>

      {/* Filter row — scopes the stats, chart and both tables below it */}
      <div className="an-toolbar">
        <h3 className="section-title" style={{ marginBottom: 0 }}>Aktivitet över tid</h3>
        <div className="seg">
          {PERIOD_OPTIONS.map((o) => (
            <button
              key={o.days}
              type="button"
              className={days === o.days ? "active" : undefined}
              disabled={loading}
              onClick={() => load(o.days, attributionDays)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {loadError && <div className="notice error">{loadError}</div>}

      {/* Stats + chart — one card, so the numbers and the trend they summarize read as one unit */}
      <div className="card" style={{ padding: 0, opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}>
        <div className="an-stats">
          <div>
            <p className="metric">SMS skickade</p>
            <p className="metric-value" style={{ fontSize: 28, color: smsSentCount === 0 ? "var(--text-faint)" : "var(--text)" }}>{smsSentCount}</p>
          </div>
          <div>
            <p className="metric">Bokningar</p>
            <p className="metric-value" style={{ fontSize: 28, color: activeBookingsCount === 0 ? "var(--text-faint)" : "var(--text)" }}>{activeBookingsCount}</p>
          </div>
          <div>
            <p className="metric">SMS-matchade</p>
            <p className="metric-value" style={{ fontSize: 28, color: conversions.length === 0 ? "var(--text-faint)" : "var(--text)" }}>{conversions.length}</p>
          </div>
          <div>
            <p
              className="metric"
              title={`Andel av de kunder som fick SMS under perioden som bokade om inom ${attributionDays} dagar.`}
            >
              Konverteringsgrad <span style={{ color: "var(--text-faint)" }}>· {attributionDays} d</span>
            </p>
            <p
              className="metric-value"
              style={{ fontSize: 28, color: conversionRate === null ? "var(--text-faint)" : "var(--text)" }}
            >
              {conversionRate === null ? "—" : `${Math.round(conversionRate * 100)} %`}
            </p>
            {smsPatientCount > 0 && (
              <p className="metric" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                av {smsPatientCount} kunder
              </p>
            )}
          </div>
        </div>

        <div style={{ padding: "20px 16px 12px" }}>
          {!hasData ? (
            <div className="empty-state" style={{ padding: "56px 0" }}>
              Ingen aktivitet under perioden.
            </div>
          ) : (
            <ReactECharts option={option} style={{ height: 280 }} notMerge />
          )}
        </div>
      </div>

      {/* All-time performance — independent of the period selector above */}
      <div className="card" style={{ padding: 0, marginTop: 20 }}>
        <div style={{ padding: "16px 16px 0" }}>
          <h4 className="section-title" style={{ display: "flex", alignItems: "baseline", gap: 8, margin: 0 }}>
            Sedan start
            <span style={{ fontFamily: "var(--font-body)", fontWeight: 400, fontSize: 14, color: "var(--text-muted)" }}>
              alla bokningar, inkl. import
            </span>
          </h4>
        </div>

        <div className="an-stats">
          <div>
            <p className="metric">SMS skickade</p>
            <p className="metric-value" style={{ fontSize: 28, color: lifetime.smsSent === 0 ? "var(--text-faint)" : "var(--text)" }}>
              {lifetime.smsSent}
            </p>
          </div>
          <div>
            <p className="metric">Kunder kontaktade</p>
            <p className="metric-value" style={{ fontSize: 28, color: lifetime.patientsContacted === 0 ? "var(--text-faint)" : "var(--text)" }}>
              {lifetime.patientsContacted}
            </p>
          </div>
          <div>
            <p className="metric" title="Kunder som bokade om någon gång efter ett SMS, oavsett hur lång tid det tog.">
              Bokade igen
            </p>
            <p className="metric-value" style={{ fontSize: 28, color: lifetime.patientsRebooked === 0 ? "var(--text-faint)" : "var(--text)" }}>
              {lifetime.patientsRebooked}
            </p>
            {lifetime.eventualRate !== null && (
              <p className="metric" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {formatPercent(lifetime.eventualRate)} av kontaktade
              </p>
            )}
          </div>
          <div>
            <p className="metric" title={`Bokade om inom ${attributionDays} dagar efter utskicket — nära nog i tid för att rimligen tillskrivas SMS:et.`}>
              Inom {attributionDays} d
            </p>
            <p className="metric-value" style={{ fontSize: 28, color: lifetime.attributedPatients === 0 ? "var(--text-faint)" : "var(--text)" }}>
              {lifetime.attributedPatients}
            </p>
            {lifetime.attributedRate !== null && (
              <p className="metric" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {formatPercent(lifetime.attributedRate)} av kontaktade
              </p>
            )}
          </div>
        </div>

        <div style={{ padding: "14px 16px 18px", borderTop: "1px solid var(--border)" }}>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
            {lifetime.patientsContacted} kontaktade → {lifetime.patientsRebooked} bokade igen →{" "}
            {lifetime.attributedPatients} inom {attributionDays} dagar
          </p>
          {lifetime.patientsContacted > 0 && lifetime.patientsContacted < 50 && (
            <p style={{ fontSize: 14, color: "var(--text-faint)", margin: "6px 0 0" }}>
              Litet underlag — läs siffrorna som riktning, inte mätning.
            </p>
          )}
        </div>
      </div>

      {/* Per follow-up + time to rebooking */}
      <div className="analytics-bottom-grid">
        <div>
          <h4 className="section-title">Resultat per uppföljning</h4>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Varje ombokning krediteras den senaste uppföljningen före bokningen.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Uppföljning</th>
                  <th>Skickade</th>
                  <th>Kunder</th>
                  <th>Bokade igen</th>
                  <th>Andel</th>
                  <th>Inom {attributionDays} d</th>
                  <th>Median</th>
                </tr>
              </thead>
              <tbody>
                {lifetime.perStep.length === 0 ? (
                  <tr><td colSpan={7} className="muted">Inga uppföljningar konfigurerade.</td></tr>
                ) : (
                  lifetime.perStep.map((step) => (
                    <tr key={step.key}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {step.label}
                        {step.exists && !step.active && (
                          <span className="badge waiting" style={{ marginLeft: 6 }}>inaktiv</span>
                        )}
                      </td>
                      <td className="muted">{step.smsSent}</td>
                      <td className="muted">{step.patientsContacted}</td>
                      <td className="muted">{step.rebookedPatients}</td>
                      <td className="muted">{step.eventualRate === null ? "—" : formatPercent(step.eventualRate)}</td>
                      <td className="muted">{step.attributed}</td>
                      <td className="muted">{step.medianDays === null ? "—" : `${step.medianDays} d`}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h4 className="section-title">Tid till ombokning</h4>
          <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Hur lång tid det tog innan kunden bokade om efter ett SMS.
          </p>
          {lifetime.distribution.every((b) => b.count === 0) ? (
            <div className="empty-state">Inga ombokningar efter SMS ännu.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {lifetime.distribution.map((bucket) => {
                const max = Math.max(...lifetime.distribution.map((b) => b.count), 1);
                return (
                  <div key={bucket.label} style={{ display: "grid", gridTemplateColumns: "104px 1fr 34px", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{bucket.label}</span>
                    <span style={{ background: "var(--surface-sub)", borderRadius: 3, height: 10, overflow: "hidden" }}>
                      <span style={{
                        display: "block",
                        height: "100%",
                        width: `${(bucket.count / max) * 100}%`,
                        background: COLOR_BOOKINGS,
                        transition: "width 200ms",
                      }} />
                    </span>
                    <span style={{ fontSize: 14, color: bucket.count === 0 ? "var(--text-faint)" : "var(--text)", textAlign: "right" }}>
                      {bucket.count}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom: bookings + SMS-matched bookings */}
      <div className="analytics-bottom-grid">

        {/* Bookings table */}
        <div>
          <h4 className="section-title" style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            Bokningar under perioden
            <span style={{ fontFamily: "var(--font-body)", fontWeight: 400, fontSize: 14, color: "var(--text-muted)" }}>
              ({activeBookingsCount} st)
            </span>
          </h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bokad</th>
                  <th>Bokningstid</th>
                  <th>Patient</th>
                  <th>Tjänst</th>
                  <th>Behandlare</th>
                  <th>Källa</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(b.recorded_at)}
                      {formatTime(b.recorded_at) && (
                        <span style={{ fontSize: 12, opacity: 0.75, marginLeft: 6 }}>
                          {formatTime(b.recorded_at)}
                        </span>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDate(b.booking_at)}</td>
                    <td style={{ fontWeight: 500 }}>{b.patient_name ?? <span className="muted">—</span>}</td>
                    <td className="muted">{b.treatment ?? "—"}</td>
                    <td className="muted">{b.practitioner ?? "—"}</td>
                    <td>
                      <span className="badge" style={{ fontSize: 12 }}>
                        {b.via_webhook ? "webhook" : "csv"}
                      </span>
                    </td>
                    <td>
                      {b.cancelled
                        ? <span className="badge failed" style={{ fontSize: 12 }}>Avbokad</span>
                        : <span className="badge sent" style={{ fontSize: 12 }}>Aktiv</span>
                      }
                    </td>
                  </tr>
                ))}
                {bookings.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">Inga bokningar under perioden.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* SMS-matched bookings */}
        <div>
          <h4 className="section-title" style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            SMS-matchade bokningar
            <span style={{ fontFamily: "var(--font-body)", fontWeight: 400, fontSize: 14, color: "var(--text-muted)" }}>
              ({conversions.length} st)
            </span>
            {/* Scoped to this table and the conversion rate only — deliberately
                separate from the period selector above, which scopes everything. */}
            <span className="an-attribution" style={{ marginLeft: "auto" }}>
              <span className="an-attribution-label">Tillskrivs inom</span>
              <span className="seg seg-sm">
                {ATTRIBUTION_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={attributionDays === w ? "active" : undefined}
                    disabled={loading}
                    onClick={() => load(days, w)}
                    title={`Räkna en ombokning som SMS-driven om den skedde inom ${w} dagar efter utskicket`}
                  >
                    {w} d
                  </button>
                ))}
              </span>
            </span>
          </h4>
          {conversionsOutsideWindow > 0 && (
            <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 8px" }}>
              {conversionsOutsideWindow} ytterligare ombokning{conversionsOutsideWindow === 1 ? "" : "ar"} skedde
              efter mer än {attributionDays} dagar och räknas inte här.
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Bokad</th>
                  <th>SMS skickat</th>
                  <th>Dagar sedan SMS</th>
                </tr>
              </thead>
              <tbody>
                {conversions.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 500 }}>{c.patient_name ?? <span className="muted">—</span>}</td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(c.booking_effective_at)}
                      {formatTime(c.booking_effective_at) && (
                        <span style={{ fontSize: 12, opacity: 0.75, marginLeft: 6 }}>
                          {formatTime(c.booking_effective_at)}
                        </span>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(c.reminder_log_sent_at)}
                      {/* Named by the follow-up's trigger day; the position is
                          only meaningful against the step list of the day. */}
                      {c.step_day != null ? (
                        <span className="badge" style={{ fontSize: 12, marginLeft: 6 }}>{c.step_day} dagar</span>
                      ) : c.sequence_number != null && (
                        <span className="badge" style={{ fontSize: 12, marginLeft: 6 }}>steg {c.sequence_number}</span>
                      )}
                    </td>
                    <td>
                      <span className="badge sent" style={{ fontSize: 12 }}>{c.days_since_sms} dagar</span>
                    </td>
                  </tr>
                ))}
                {conversions.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty-state">Inga matchade bokningar under perioden.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

    </div>
  );
}
