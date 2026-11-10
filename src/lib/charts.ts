/**
 * charts.ts — the visual every chat tool returns.
 *
 * Tools don't draw anything. They return a `ChartSpec`: plain JSON saying which
 * visual to show and with what data. The dashboard (src/components) renders it;
 * any other charting library could too, since nothing here imports one.
 *
 * Which visual, kept in one place:
 *   - line   → anything over time (x-axis is dates)
 *   - bar    → comparing things side by side in one period (products, SKUs)
 *   - table  → several numbers per item in a category (units sold next to inventory)
 *   - metric → single totals (total net revenue), shown as cards
 *
 * This file has no server-only imports, so the UI can import these types too.
 */

export type ChartType = "line" | "bar" | "table" | "metric";

/** Over time → line; side-by-side comparison → bar. */
export function chartTypeFor(xType: SeriesChartSpec["xType"]): "line" | "bar" {
  return xType === "time" ? "line" : "bar";
}

export type ValueFormat = "currency" | "number" | "percent" | "text";

export interface ChartSeries {
  /** Field name in each data row holding this series' value. Safe keys like "s0" so any library can use them. */
  key: string;
  /** Human-readable name for the legend and tooltip, e.g. "Online Store". */
  label: string;
}

interface BaseSpec {
  title: string;
  /** One line of context, e.g. the date range. */
  subtitle?: string;
}

/** Line and bar charts. */
export interface SeriesChartSpec extends BaseSpec {
  type: "line" | "bar";
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

export interface TableColumn {
  key: string;
  label: string;
  format: ValueFormat;
}

/** A table: one row per item (e.g. product), one column per number. */
export interface TableSpec extends BaseSpec {
  type: "table";
  columns: TableColumn[];
  /** Cells are keyed by column key. null = no value (shown as a dash). */
  rows: Array<Record<string, string | number | null>>;
  /** Optional totals row, keyed like the other rows. */
  totals?: Record<string, string | number | null>;
}

export interface MetricValue {
  key: string;
  label: string;
  value: number;
  format: "currency" | "number";
  /** Same metric in the previous period, when the data covers it. */
  previous?: number;
  /** (value − previous) ÷ previous; null when previous is 0. */
  change?: number | null;
  previousLabel?: string;
}

/** Metric cards: one card per single total. */
export interface MetricSpec extends BaseSpec {
  type: "metric";
  metrics: MetricValue[];
}

export type ChartSpec = SeriesChartSpec | TableSpec | MetricSpec;
