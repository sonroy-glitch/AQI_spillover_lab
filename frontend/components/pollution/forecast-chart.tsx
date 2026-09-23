"use client"

import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { aqiColor } from "@/lib/pollution/aqi"
import type { ForecastPoint } from "@/lib/pollution/types"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface TooltipPayloadItem {
  payload: ForecastPoint
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-foreground">
        {p.hour === 0 ? "Now" : `+${p.hour}h`}
      </p>
      <p className="mt-1 font-semibold" style={{ color: aqiColor(p.aqi) }}>
        AQI {p.aqi}
      </p>
      <p className="text-muted-foreground">
        Range {p.low}–{p.high}
      </p>
    </div>
  )
}

export function ForecastChart({
  forecast,
  title,
  horizon,
}: {
  forecast: ForecastPoint[]
  title: string
  horizon: number
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Forecast trend</CardTitle>
        <CardDescription className="truncate">{title} · next 24h</CardDescription>
      </CardHeader>
      <CardContent className="px-1 pb-2">
        <div className="h-[160px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={forecast} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.06} />
                </linearGradient>
              </defs>
              {/* confidence band: draw to `high`, then mask below `low` with card bg */}
              <Area
                type="monotone"
                dataKey="high"
                stroke="none"
                fill="url(#band)"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="low"
                stroke="none"
                fill="var(--card)"
                fillOpacity={1}
                isAnimationActive={false}
              />
              <XAxis
                dataKey="hour"
                tickFormatter={(h) => (h === 0 ? "now" : `+${h}h`)}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval={2}
              />
              <YAxis
                width={28}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                domain={["dataMin - 15", "dataMax + 15"]}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--border)" }} />
              {horizon > 0 ? (
                <ReferenceLine
                  x={horizon}
                  stroke="var(--primary)"
                  strokeDasharray="3 3"
                  strokeOpacity={0.7}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey="aqi"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}
