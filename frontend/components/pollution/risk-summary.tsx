import { severityColor, SEVERITY_ORDER } from "@/lib/pollution/aqi"
import type { Severity } from "@/lib/pollution/types"

export function RiskSummary({ counts }: { counts: Record<Severity, number> }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {SEVERITY_ORDER.map((severity) => {
        const color = severityColor(severity)
        const count = counts[severity] ?? 0
        return (
          <div
            key={severity}
            className="flex flex-col items-center gap-1 rounded-lg border border-border bg-card px-2 py-3"
            style={{ boxShadow: count > 0 ? `inset 0 -2px 0 ${color}` : undefined }}
          >
            <span className="text-xl font-bold tabular-nums" style={{ color: count > 0 ? color : undefined }}>
              {count}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {severity}
            </span>
          </div>
        )
      })}
    </div>
  )
}
