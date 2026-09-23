"use client"

import { ArrowRight, BellRing } from "lucide-react"

import { aqiColor } from "@/lib/pollution/aqi"
import type { SpilloverAlert } from "@/lib/pollution/types"
import { SeverityBadge } from "@/components/pollution/severity-badge"
import { ZONE_META } from "@/components/pollution/zone-meta"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export function SpilloverAlerts({
  alerts,
  selectedZoneId,
  onSelectZone,
}: {
  alerts: SpilloverAlert[]
  selectedZoneId: string | null
  onSelectZone: (id: string) => void
}) {
  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 p-0">
      <CardHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BellRing className="size-4 text-primary" />
          Spillover alerts
        </CardTitle>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {alerts.length}
        </span>
      </CardHeader>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2 p-3">
          {alerts.length === 0 ? (
            <li className="px-1 py-6 text-center text-sm text-muted-foreground">
              No active spillover alerts.
            </li>
          ) : (
            alerts.map((alert) => {
              const meta = ZONE_META[alert.type]
              const Icon = meta.icon
              const selected = selectedZoneId === alert.zoneId
              return (
                <li key={alert.zoneId}>
                  <button
                    type="button"
                    onClick={() => onSelectZone(alert.zoneId)}
                    className={cn(
                      "w-full rounded-lg border border-border bg-secondary/40 p-3 text-left transition-colors hover:bg-secondary",
                      selected && "border-primary/60 bg-secondary ring-1 ring-primary/40",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium text-foreground">
                          {alert.zoneName}
                        </span>
                      </div>
                      <SeverityBadge severity={alert.severity} />
                    </div>
                    <div className="mt-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        <span style={{ color: aqiColor(alert.currentAQI) }}>
                          {alert.currentAQI}
                        </span>
                        <ArrowRight className="size-3.5 text-muted-foreground" />
                        <span style={{ color: aqiColor(alert.predictedAQI) }}>
                          {alert.predictedAQI}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">+{alert.horizonHours}h</span>
                    </div>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </ScrollArea>
    </Card>
  )
}
