export type Severity = "Low" | "Moderate" | "High" | "Severe"

export type ZoneType = "school" | "stadium" | "worker_zone"

export type Horizon = 0 | 6 | 12 | 18 | 24

export interface GridPoint {
  lat: number
  lng: number
  aqi: number
  pm25: number
}

export interface WindVector {
  lat: number
  lng: number
  /** Direction the wind is blowing toward, in degrees (0 = North, 90 = East) */
  direction: number
  /** Wind speed in km/h */
  speed: number
}

export interface ForecastPoint {
  hour: number
  aqi: number
  /** Lower bound of the confidence band */
  low: number
  /** Upper bound of the confidence band */
  high: number
}

export interface RiskZone {
  id: string
  name: string
  type: ZoneType
  lat: number
  lng: number
  currentAQI: number
  forecast: ForecastPoint[]
}

export interface SpilloverAlert {
  zoneId: string
  zoneName: string
  type: ZoneType
  currentAQI: number
  predictedAQI: number
  horizonHours: number
  severity: Severity
}

export interface Conditions {
  aqi: number
  pm25: number
  windSpeed: number
  windDirection: number
  temperature: number
  humidity: number
}

export interface City {
  id: string
  name: string
  country: string
  center: [number, number]
  zoom: number
}

/** Where a forecast was taken — a preset city, or a geolocated point. */
export interface ResolvedLocation {
  id: string
  name: string
  country: string
  center: [number, number]
  zoom: number
  source: "preset" | "geolocation"
}

/** A hit from `/api/search?q=` (Open-Meteo forward geocoding). */
export interface SearchResult {
  id: string
  name: string
  region: string
  country: string
  label: string
  center: [number, number]
  zoom: number
  population?: number | null
  source: "search"
}

/** What the dashboard is currently showing: a preset city or raw coordinates. */
export type Place =
  | { kind: "city"; id: string }
  | { kind: "coords"; lat: number; lng: number; name?: string }

export interface ForecastResponse {
  cityId: string
  /** Present on responses from the backend; absent in older mock data. */
  location?: ResolvedLocation
  generatedAt: string
  conditions: Conditions
  /** Heatmap grid keyed by forecast horizon (hours) */
  gridByHorizon: Record<number, GridPoint[]>
  windVectors: WindVector[]
  riskZones: RiskZone[]
  alerts: SpilloverAlert[]
}
