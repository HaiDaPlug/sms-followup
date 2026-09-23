"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

const ReactECharts = dynamic(() => import("echarts-for-react"), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: 300, borderRadius: 10 }} />,
});

/*
 * ECharts draws on a canvas, and a canvas cannot resolve CSS custom
 * properties: `color: "var(--text-muted)"` is silently dropped. Every color
 * the chart paints is therefore a literal, mirrored from the tokens in
 * globals.css (--series-*, --text-muted, --hairline, --border-dark).
 *
 * Three overlapping lines on one axis — all counts per day or week:
 *   Bokningar      solid teal + soft area — the outcome the page is about
 *   SMS skickade   solid violet
 *   SMS-matchade   dashed orange — a subset of Bokningar, drawn like one
 */
export const SERIES = {
  sms:      { name: "SMS skickade",           color: "#4a3aa7", dashed: false },
  bookings: { name: "Bokningar",              color: "#1c9686", dashed: false },
  matched:  { name: "SMS-matchade bokningar", color: "#e0662f", dashed: true },
} as const;

export type SeriesKey = keyof typeof SERIES;

const INK_MUTED = "#5d6d67";
const GRID = "#efece6";
const AXIS = "#d3cec2";
const FONT = "'Source Sans 3', ui-sans-serif, system-ui, sans-serif";

export type TrendPoint = {
  /** Category label on the axis, e.g. "3 sep." */
  label: string;
  /** Full label for the tooltip header, e.g. "tisdag 3 september" */
  title: string;
  sms: number;
  bookings: number;
  matched: number;
};

/** "#4a3aa7" → "rgba(74,58,167,a)". */
function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function lineSeries(key: SeriesKey, data: number[], z: number, withArea: boolean) {
  const { name, color, dashed } = SERIES[key];
  return {
    name,
    type: "line",
    data,
    z,
    // Smooth, but never above a real peak: monotone along x keeps each curve
    // between its neighbouring points, and the grid clips anything below 0.
    smooth: 0.35,
    smoothMonotone: "x",
    showSymbol: false,
    symbol: "circle",
    symbolSize: 9,
    lineStyle: { width: 2, color, cap: "round", join: "round", type: dashed ? [5, 4] : "solid" },
    itemStyle: { color, borderColor: "#ffffff", borderWidth: 2 },
    areaStyle: withArea
      ? {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: rgba(color, 0.16) },
              { offset: 1, color: rgba(color, 0) },
            ],
          },
        }
      : undefined,
    emphasis: { focus: "none", scale: true, lineStyle: { width: 2 } },
  };
}

export function TrendChart({
  points,
  hidden,
  height = 300,
}: {
  points: TrendPoint[];
  hidden: Set<SeriesKey>;
  height?: number;
}) {
  const option = useMemo(() => {
    const titles = points.map((p) => p.title);
    return {
      animationDuration: 500,
      animationEasing: "cubicOut",
      textStyle: { fontFamily: FONT },
      grid: { left: 4, right: 14, top: 14, bottom: 4, containLabel: true },
      // Legend is drawn in HTML in the panel header; this one only carries
      // the show/hide state for the series.
      legend: {
        show: false,
        selected: {
          [SERIES.sms.name]: !hidden.has("sms"),
          [SERIES.bookings.name]: !hidden.has("bookings"),
          [SERIES.matched.name]: !hidden.has("matched"),
        },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: "#b9b2a3", width: 1, type: "solid" }, z: 0 },
        backgroundColor: "rgba(16,33,27,0.94)",
        borderWidth: 0,
        padding: [10, 14],
        extraCssText: "box-shadow: 0 12px 30px rgba(4,30,22,0.28); border-radius: 10px;",
        textStyle: { color: "#ffffff", fontSize: 14, fontFamily: FONT },
        formatter: (params: unknown) => {
          const rows = params as Array<{ dataIndex: number; seriesName: string; value: number; color: string }>;
          if (!rows.length) return "";
          const header = titles[rows[0].dataIndex] ?? "";
          const body = rows
            .map((p) => {
              const dashed = p.seriesName === SERIES.matched.name;
              const key = dashed
                ? `<span style="display:inline-block;width:14px;height:2px;background:repeating-linear-gradient(90deg,${p.color} 0 4px,transparent 4px 7px)"></span>`
                : `<span style="display:inline-block;width:14px;height:2px;border-radius:1px;background:${p.color}"></span>`;
              return `<div style="display:flex;align-items:center;gap:10px;padding:2px 0;">
                ${key}
                <span style="color:rgba(255,255,255,0.72);flex:1">${p.seriesName}</span>
                <span style="font-weight:700;margin-left:14px;font-variant-numeric:tabular-nums">${p.value}</span>
              </div>`;
            })
            .join("");
          return `<div style="font-size:12px;color:rgba(255,255,255,0.55);margin-bottom:6px">${header}</div>${body}`;
        },
      },
      xAxis: {
        type: "category",
        data: points.map((p) => p.label),
        boundaryGap: false,
        // Drawn above the series: on quiet days every line sits at zero, and
        // without this the top line would paint the whole baseline orange.
        z: 10,
        axisLine: { lineStyle: { color: AXIS, width: 2 } },
        axisTick: { show: false },
        axisLabel: { color: INK_MUTED, fontSize: 12, hideOverlap: true, margin: 12 },
      },
      yAxis: {
        type: "value",
        min: 0,
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: INK_MUTED, fontSize: 12, margin: 10 },
        splitLine: { lineStyle: { color: GRID, width: 1 } },
      },
      // Drawing order: SMS at the back, bookings over it, the dashed subset on top.
      series: [
        lineSeries("sms", points.map((p) => p.sms), 2, false),
        lineSeries("bookings", points.map((p) => p.bookings), 3, true),
        lineSeries("matched", points.map((p) => p.matched), 4, false),
      ],
    };
  }, [points, hidden]);

  return <ReactECharts option={option} style={{ height }} notMerge opts={{ renderer: "canvas" }} />;
}
