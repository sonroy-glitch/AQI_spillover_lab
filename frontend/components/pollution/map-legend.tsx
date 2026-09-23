import { AQI_CATEGORIES } from "@/lib/pollution/aqi"

export function MapLegend() {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-[1000] rounded-lg border border-border bg-card/85 p-3 backdrop-blur-sm">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Air Quality Index
      </p>
      <div className="flex flex-col gap-1.5">
        {AQI_CATEGORIES.map((c) => (
          <div key={c.label} className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ background: c.color }}
              aria-hidden="true"
            />
            <span className="text-xs text-foreground">{c.short}</span>
            <span className="ml-auto pl-3 text-[10px] tabular-nums text-muted-foreground">
              {c.range[0]}–{c.range[1] === 500 ? "500+" : c.range[1]}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
