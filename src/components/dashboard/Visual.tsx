"use client";

/**
 * Draws one tool result. The tool already chose the visual (see charts.ts):
 * line = over time, bar = side-by-side comparison, table = several numbers per
 * item, metric = single totals. This component only renders what it's given.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricSpec, SeriesChartSpec, TableSpec } from "@/lib/charts";
import { formatAxis, formatValue, type VisualOutput } from "@/lib/dashboard-client";

/** Shopify-inspired palette; the first colour is the brand green. */
const COLORS = ["#008060", "#5C6AC4", "#47C1BF", "#F49342", "#DE3618", "#9C6ADE", "#EEC200", "#006FBB", "#50B83C", "#B76E00", "#637381", "#E0B3F5"];
const PREVIOUS_COLOR = "#8C9196";

export function Visual({ output }: { output: VisualOutput }) {
  const { chart, notes } = output;
  return (
    <div className="flex h-full flex-col">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold text-ink">{chart.title}</h3>
        {chart.subtitle && <p className="mt-0.5 text-[13px] text-muted">{chart.subtitle}</p>}
      </div>
      <div className="flex-1">
        {chart.type === "line" && <LineVisual spec={chart} />}
        {chart.type === "bar" && <BarVisual spec={chart} />}
        {chart.type === "table" && <TableVisual spec={chart} />}
        {chart.type === "metric" && <MetricVisual spec={chart} />}
      </div>
      {notes.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
          {notes.map((n) => (
            <li key={n} className="flex gap-1.5">
              <span aria-hidden className="select-none">ⓘ</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function tooltipValue(spec: SeriesChartSpec) {
  return (value: unknown) => formatValue(Number(value), spec.valueFormat);
}

function LineVisual({ spec }: { spec: SeriesChartSpec }) {
  const many = spec.data.length > 20;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={spec.data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#EBECEF" vertical={false} />
          <XAxis dataKey={spec.xLabelKey} tick={{ fontSize: 12, fill: "#6D7175" }} tickLine={false} axisLine={{ stroke: "#E1E3E5" }} minTickGap={16} />
          <YAxis tickFormatter={formatAxis} tick={{ fontSize: 12, fill: "#6D7175" }} tickLine={false} axisLine={false} width={48} />
          <Tooltip formatter={tooltipValue(spec)} contentStyle={tooltipStyle} labelStyle={{ fontWeight: 600, color: "#202223" }} />
          {spec.series.length > 1 && <Legend iconType="plainline" itemSorter={null} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />}
          {spec.series.map((s, i) => {
            const previous = s.label === "Previous period";
            return (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={previous ? PREVIOUS_COLOR : COLORS[i % COLORS.length]}
                strokeWidth={2}
                strokeDasharray={previous ? "5 4" : undefined}
                dot={many ? false : { r: 3 }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BarVisual({ spec }: { spec: SeriesChartSpec }) {
  // Horizontal bars: product names are long and read better down the side.
  const height = Math.max(200, spec.data.length * (spec.series.length > 1 ? 44 : 34) + 48);
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={spec.data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap={6}>
          <CartesianGrid stroke="#EBECEF" horizontal={false} />
          <XAxis type="number" tickFormatter={formatAxis} tick={{ fontSize: 12, fill: "#6D7175" }} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey={spec.xLabelKey} width={170} tick={{ fontSize: 12, fill: "#202223" }} tickLine={false} axisLine={false} />
          <Tooltip formatter={tooltipValue(spec)} contentStyle={tooltipStyle} cursor={{ fill: "#F6F6F7" }} />
          {spec.series.length > 1 && <Legend itemSorter={null} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />}
          {spec.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={s.label === "Previous period" ? "#C9CCCF" : COLORS[i % COLORS.length]}
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TableVisual({ spec }: { spec: TableSpec }) {
  const numeric = (f: string) => f !== "text";
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-[13px] tabular-nums">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            {spec.columns.map((c) => (
              <th key={c.key} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${numeric(c.format) ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i} className="border-b border-line/70 last:border-0 hover:bg-subtle">
              {spec.columns.map((c, j) => (
                <td key={c.key} className={`px-3 py-2 ${numeric(c.format) ? "text-right" : ""} ${j === 0 ? "font-medium text-ink" : "text-ink/80"}`}>
                  {formatValue(row[c.key], c.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {spec.totals && (
          <tfoot>
            <tr className="border-t border-line font-semibold text-ink">
              {spec.columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 ${numeric(c.format) ? "text-right" : ""}`}>
                  {spec.totals![c.key] === null || spec.totals![c.key] === "" ? "" : formatValue(spec.totals![c.key], c.format)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function MetricVisual({ spec }: { spec: MetricSpec }) {
  return (
    <div className={`grid gap-3 ${spec.metrics.length > 1 ? "sm:grid-cols-2 lg:grid-cols-3" : "max-w-sm"}`}>
      {spec.metrics.map((m) => {
        const up = (m.change ?? 0) > 0.0005;
        const down = (m.change ?? 0) < -0.0005;
        return (
          <div key={m.key} className="rounded-lg border border-line bg-subtle px-4 py-3.5">
            <p className="text-[13px] font-medium text-muted">{m.label}</p>
            <p className="mt-1 text-[28px] font-semibold leading-tight tracking-tight text-ink tabular-nums">{formatValue(m.value, m.format)}</p>
            {m.previous !== undefined && (
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold tabular-nums ${
                    up ? "bg-[#E3F1DF] text-[#108043]" : down ? "bg-[#FBEAE5] text-[#BF0711]" : "bg-[#EBECEF] text-muted"
                  }`}
                >
                  {m.change === null || m.change === undefined ? "new" : `${up ? "▲" : down ? "▼" : ""} ${Math.abs(m.change * 100).toFixed(1)}%`}
                </span>
                <span>
                  vs {formatValue(m.previous, m.format)} · {m.previousLabel}
                </span>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const tooltipStyle = { borderRadius: 8, border: "1px solid #E1E3E5", boxShadow: "0 4px 12px rgba(0,0,0,0.08)", fontSize: 12 };
