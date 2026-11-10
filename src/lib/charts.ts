/**
 * charts.ts — the chart description every chat tool returns.
 *
 * Tools don't draw anything. They return a `ChartSpec`: plain JSON saying what
 * kind of chart to draw and with what data. Any charting library (Recharts,
 * Chart.js, Vega, …) can render it, and nothing here imports a library.
 *
 * This file has no server-only imports, so the UI can import these types too.
 */

/**
 * The rule for picking a chart type, kept in one place:
 *   - anything over time (x-axis is dates) → line chart
 *   - comparing things side by side (x-axis is categories, e.g. products) → bar chart
 */
export type ChartType = "line" | "bar";

export function chartTypeFor(xType: ChartSpec["xType"]): ChartType {
  return xType === "time" ? "line" : "bar";
}

export interface ChartSeries {
  /** Field name in each data row holding this series' value. Safe keys like "s0" so any library can use them. */
  key: string;
  /** Human-readable name for the legend and tooltip, e.g. "Online Store". */
  label: string;
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  /** One line of context, e.g. the date range. */
  subtitle?: string;
  /** "time": x values are ISO dates in order. "category": x values are names (products, channels). */
  xType: "time" | "category";
  /** Field in each data row with the raw x value (ISO date or category name). */
  xKey: string;
  /** Field in each data row with the display text for the x value (e.g. "15 Sep"). */
  xLabelKey: string;
  /** Only for time charts: how wide each point is. */
  granularity?: "day" | "week" | "month";
  xAxisLabel: string;
  yAxisLabel: string;
  /** How to format values: "currency" for money, "number" for counts like units. */
  valueFormat: "currency" | "number";
  series: ChartSeries[];
  /**
   * One row per x value. Each row has xKey, xLabelKey and one field per series key.
   * Time charts also have `partial`: 1 when the date range only covers part of
   * that period (e.g. a week cut off by the start of the data), so the UI can
   * draw it differently, e.g. as a dashed segment.
   */
  data: Array<Record<string, string | number>>;
}
