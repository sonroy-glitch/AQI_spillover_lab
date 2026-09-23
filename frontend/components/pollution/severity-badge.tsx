import { severityColor } from "@/lib/pollution/aqi"
import type { Severity } from "@/lib/pollution/types"
import { cn } from "@/lib/utils"

export function SeverityBadge({
  severity,
  className,
}: {
  severity: Severity
  className?: string
}) {
  const color = severityColor(severity)
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{
        color,
        backgroundColor: `${color}1f`,
        boxShadow: `inset 0 0 0 1px ${color}40`,
      }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {severity}
    </span>
  )
}
