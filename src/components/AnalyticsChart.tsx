"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

interface SeriesPoint {
  week: string;
  bookings: number;
  sms: number;
}

interface BookingRow {
  id: string;
  booking_at: string;
  patient_name: string | null;
  treatment: string | null;
  practitioner: string | null;
  location: string | null;
  source: string;
  cancelled: boolean;
  via_webhook: boolean;
}

interface Props {
  initialSeries: SeriesPoint[];
  initialBookings: BookingRow[];
  initialDays: number;
}

const PERIOD_OPTIONS = [
  { label: "30 dagar", days: 30 },
  { label: "90 dagar", days: 90 },
  { label: "180 dagar", days: 180 },
  { label: "365 dagar", days: 365 },
];

function formatWeek(week: string): string {
  const d = new Date(week);
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("sv-SE", {
    day: "numeric", month: "short", year: "numeric"
  });
}

export function AnalyticsChart({ initialSeries, initialBookings, initialDays }: Props) {
  const [days, setDays] = useState(initialDays);
  const [series, setSeries] = useState(initialSeries);
  const [bookings, setBookings] = useState(initialBookings);
  const [loading, setLoading] = useState(false);

  async function loadPeriod(d: number) {
    setDays(d);
    setLoading(true);
    const res = await fetch(`/api/analytics?days=${d}`);
    const data = await res.json() as { series: SeriesPoint[]; bookings: BookingRow[] };
    setSeries(data.series);
    setBookings(data.bookings);
    setLoading(false);
  }

  const option = {
    tooltip: {
      trigger: "axis",
      backgroundColor: "var(--surface)",
      borderColor: "var(--border)",
      textStyle: { color: "var(--text)", fontSize: 12 },
    },
    legend: {
      data: ["Bokningar", "SMS skickade"],
      bottom: 0,
      textStyle: { color: "var(--text-muted)", fontSize: 12 },
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
    },
    grid: { left: 40, right: 40, top: 16, bottom: 40 },
    xAxis: {
      type: "category",
      data: series.map((s) => formatWeek(s.week)),
      axisLine: { lineStyle: { color: "var(--border)" } },
      axisTick: { show: false },
      axisLabel: { color: "var(--text-muted)", fontSize: 11 },
    },
    yAxis: [
      {
        type: "value",
        name: "Bokningar",
        nameTextStyle: { color: "var(--text-muted)", fontSize: 11 },
        axisLabel: { color: "var(--text-muted)", fontSize: 11 },
        splitLine: { lineStyle: { color: "var(--border)", type: "dashed" } },
        minInterval: 1,
      },
      {
        type: "value",
        name: "SMS",
        nameTextStyle: { color: "var(--text-muted)", fontSize: 11 },
        axisLabel: { color: "var(--text-muted)", fontSize: 11 },
        splitLine: { show: false },
        minInterval: 1,
      },
    ],
    series: [
      {
        name: "Bokningar",
        type: "line",
        yAxisIndex: 0,
        data: series.map((s) => s.bookings),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2, color: "#4f8ef7" },
        itemStyle: { color: "#4f8ef7" },
        areaStyle: { color: "rgba(79,142,247,0.08)" },
      },
      {
        name: "SMS skickade",
        type: "line",
        yAxisIndex: 1,
        data: series.map((s) => s.sms),
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2, color: "#22c55e" },
        itemStyle: { color: "#22c55e" },
        areaStyle: { color: "rgba(34,197,94,0.08)" },
      },
    ],
  };

  return (
    <div style={{ display: "grid", gap: 24 }}>

      {/* Period selector */}
      <div style={{ display: "flex", gap: 6 }}>
        {PERIOD_OPTIONS.map((o) => (
          <button
            key={o.days}
            type="button"
            className={days === o.days ? "" : "secondary"}
            disabled={loading}
            onClick={() => loadPeriod(o.days)}
            style={{ fontSize: 12, padding: "4px 12px", minHeight: "unset" }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "20px 16px 12px",
        opacity: loading ? 0.5 : 1,
        transition: "opacity 150ms",
      }}>
        {series.length === 0 ? (
          <div className="empty-state" style={{ padding: "48px 0" }}>
            Ingen data för perioden.
          </div>
        ) : (
          <ReactECharts option={option} style={{ height: 280 }} />
        )}
      </div>

      {/* Bookings table */}
      <div>
        <div style={{ fontFamily: "var(--font-head)", fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>
          Bokningar under perioden
          <span style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
            ({bookings.length} st)
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
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
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDate(b.booking_at)}</td>
                  <td style={{ fontWeight: 500 }}>{b.patient_name ?? <span className="muted">—</span>}</td>
                  <td className="muted">{b.treatment ?? "—"}</td>
                  <td className="muted">{b.practitioner ?? "—"}</td>
                  <td>
                    <span className="badge" style={{ fontSize: 10.5 }}>
                      {b.via_webhook ? "webhook" : "csv"}
                    </span>
                  </td>
                  <td>
                    {b.cancelled
                      ? <span className="badge failed" style={{ fontSize: 10.5 }}>Avbokad</span>
                      : <span className="badge sent" style={{ fontSize: 10.5 }}>Aktiv</span>
                    }
                  </td>
                </tr>
              ))}
              {bookings.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">Inga bokningar under perioden.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
