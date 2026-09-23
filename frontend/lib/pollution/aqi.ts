import type { Severity } from "./types"

export interface AqiCategory {
  label: string
  short: string
  severity: Severity
  /** hex color for charts / heatmap / badges */
  color: string
  /** subtle background tint (rgba) */
  tint: string
  range: [number, number]
}

export const AQI_CATEGORIES: AqiCategory[] = [
  {
    label: "Good",
    short: "Good",
    severity: "Low",
    color: "#22c55e",
    tint: "rgba(34,197,94,0.16)",
    range: [0, 50],
  },
  {
    label: "Moderate",
    short: "Moderate",
    severity: "Moderate",
    color: "#eab308",
    tint: "rgba(234,179,8,0.16)",
    range: [51, 100],
  },
  {
    label: "Unhealthy for Sensitive Groups",
    short: "Sensitive",
    severity: "High",
    color: "#f97316",
    tint: "rgba(249,115,22,0.16)",
    range: [101, 150],
  },
  {
    label: "Unhealthy",
    short: "Unhealthy",
    severity: "High",
    color: "#ef4444",
    tint: "rgba(239,68,68,0.16)",
    range: [151, 200],
  },
  {
    label: "Very Unhealthy",
    short: "Very Unhealthy",
    severity: "Severe",
    color: "#a855f7",
    tint: "rgba(168,85,247,0.18)",
    range: [201, 500],
  },
]

export function aqiCategory(aqi: number): AqiCategory {
  for (const c of AQI_CATEGORIES) {
    if (aqi >= c.range[0] && aqi <= c.range[1]) return c
  }
  return AQI_CATEGORIES[AQI_CATEGORIES.length - 1]
}

export function aqiColor(aqi: number): string {
  return aqiCategory(aqi).color
}

export function severityForAqi(aqi: number): Severity {
  if (aqi <= 50) return "Low"
  if (aqi <= 100) return "Moderate"
  if (aqi <= 150) return "High"
  return aqi > 200 ? "Severe" : "High"
}

export const SEVERITY_ORDER: Severity[] = ["Low", "Moderate", "High", "Severe"]

export function severityColor(severity: Severity): string {
  switch (severity) {
    case "Low":
      return "#22c55e"
    case "Moderate":
      return "#eab308"
    case "High":
      return "#f97316"
    case "Severe":
      return "#a855f7"
  }
}

/** Gradient stops (0..1) for leaflet.heat, matching the AQI scale. */
export const HEAT_GRADIENT: Record<number, string> = {
  0.0: "#22c55e",
  0.25: "#eab308",
  0.5: "#f97316",
  0.75: "#ef4444",
  1.0: "#a855f7",
}

/** Compass label for a direction in degrees. */
export function compassLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  return dirs[Math.round(deg / 45) % 8]
}
