import { Droplets, Gauge, Thermometer, Wind } from "lucide-react"

import { aqiCategory, compassLabel } from "@/lib/pollution/aqi"
import type { Conditions } from "@/lib/pollution/types"
import { Card } from "@/components/ui/card"

function Metric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Wind
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-secondary/50 px-3 py-2.5">
      <Icon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-semibold text-foreground">
          {value}
          {sub ? <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span> : null}
        </p>
      </div>
    </div>
  )
}

export function CurrentConditions({ conditions }: { conditions: Conditions }) {
  const cat = aqiCategory(conditions.aqi)
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div
        className="flex items-center gap-4 p-4"
        style={{ background: cat.tint }}
      >
        <div
          className="flex size-20 shrink-0 flex-col items-center justify-center rounded-xl"
          style={{ background: `${cat.color}26`, boxShadow: `inset 0 0 0 1px ${cat.color}55` }}
        >
          <span className="text-3xl font-bold leading-none" style={{ color: cat.color }}>
            {conditions.aqi}
          </span>
          <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            AQI
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Current conditions</p>
          <p className="text-lg font-semibold text-balance" style={{ color: cat.color }}>
            {cat.label}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            PM2.5 {conditions.pm25} µg/m³
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3">
        <Metric
          icon={Wind}
          label="Wind"
          value={`${conditions.windSpeed} km/h`}
          sub={compassLabel(conditions.windDirection)}
        />
        <Metric icon={Gauge} label="PM2.5" value={`${conditions.pm25}`} sub="µg/m³" />
        <Metric icon={Thermometer} label="Temp" value={`${conditions.temperature}°C`} />
        <Metric icon={Droplets} label="Humidity" value={`${conditions.humidity}%`} />
      </div>
    </Card>
  )
}
