"use client"

import { useCallback, useMemo, useState } from "react"
import dynamic from "next/dynamic"
import useSWR from "swr"
import { Loader2 } from "lucide-react"

import { CITIES } from "@/lib/pollution/data"
import { aqiCategory, severityForAqi } from "@/lib/pollution/aqi"
import type {
  ForecastPoint,
  ForecastResponse,
  Place,
  SearchResult,
  Severity,
} from "@/lib/pollution/types"
import { useGeolocation } from "@/lib/pollution/use-geolocation"
import { TopBar } from "@/components/pollution/top-bar"
import { CurrentConditions } from "@/components/pollution/current-conditions"
import { ForecastChart } from "@/components/pollution/forecast-chart"
import { SpilloverAlerts } from "@/components/pollution/spillover-alerts"
import { RiskSummary } from "@/components/pollution/risk-summary"
import { MapLegend } from "@/components/pollution/map-legend"
import { ChatWidget } from "@/components/pollution/chat-widget"

const PollutionMap = dynamic(() => import("@/components/pollution/pollution-map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  ),
})

const fetcher = (url: string): Promise<ForecastResponse> =>
  fetch(url).then((r) => r.json())

function predictedAt(forecast: ForecastPoint[], horizon: number, current: number): number {
  if (horizon === 0) return current
  const fp = forecast.find((p) => p.hour === horizon) ?? forecast[forecast.length - 1]
  return fp.aqi
}

export function Dashboard() {
  // Either a preset city or the coordinates the browser reported.
  const [place, setPlace] = useState<Place>({ kind: "city", id: CITIES[0].id })
  const [horizon, setHorizon] = useState(0)
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)

  const query =
    place.kind === "coords"
      ? `lat=${place.lat.toFixed(4)}&lng=${place.lng.toFixed(4)}` +
        (place.name ? `&name=${encodeURIComponent(place.name)}` : "")
      : `city=${place.id}`

  const { data, isLoading, isValidating, mutate } = useSWR<ForecastResponse>(
    `/api/forecast?${query}&hours=${24}`,
    fetcher,
    { keepPreviousData: true, refreshInterval: 60_000 },
  )

  const handleSearchSelect = useCallback((result: SearchResult) => {
    setPlace({
      kind: "coords",
      lat: result.center[0],
      lng: result.center[1],
      name: result.label,
    })
    setSelectedZoneId(null)
  }, [])

  const geo = useGeolocation(
    useCallback((coords: { lat: number; lng: number }) => {
      setPlace({ kind: "coords", lat: coords.lat, lng: coords.lng })
      setSelectedZoneId(null)
    }, []),
  )

  // The backend names and centres a geolocated point; presets are known up front,
  // so the map can centre before the first response arrives.
  const presetCity = CITIES.find((c) => c.id === (place.kind === "city" ? place.id : "")) ?? CITIES[0]
  const resolved = data?.location
  const usingGeo = place.kind === "coords"
  const searchedName = place.kind === "coords" ? place.name : undefined
  const geoLocation =
    usingGeo && resolved
      ? searchedName
        ? { ...resolved, name: searchedName, country: "" }
        : resolved
      : null

  const center: [number, number] =
    usingGeo && resolved
      ? (resolved.center as [number, number])
      : usingGeo
        ? [place.lat, place.lng]
        : presetCity.center
  const zoom = usingGeo ? (resolved?.zoom ?? 12) : presetCity.zoom
  const placeLabel = usingGeo
    ? searchedName ??
      (resolved ? [resolved.name, resolved.country].filter(Boolean).join(", ") : "Your location")
    : `${presetCity.name}, ${presetCity.country}`

  const grid = data?.gridByHorizon[horizon] ?? []
  const selectedZone = data?.riskZones.find((z) => z.id === selectedZoneId) ?? null

  // City-average forecast trend when no specific zone is selected
  const cityForecast = useMemo<ForecastPoint[]>(() => {
    if (!data || data.riskZones.length === 0) return []
    const zones = data.riskZones
    return zones[0].forecast.map((_, idx) => {
      const pts = zones.map((z) => z.forecast[idx])
      const n = pts.length
      const avg = (key: keyof ForecastPoint) =>
        Math.round(pts.reduce((s, p) => s + (p[key] as number), 0) / n)
      return {
        hour: pts[0].hour,
        aqi: avg("aqi"),
        low: avg("low"),
        high: avg("high"),
      }
    })
  }, [data])

  const riskCounts = useMemo<Record<Severity, number>>(() => {
    const counts: Record<Severity, number> = { Low: 0, Moderate: 0, High: 0, Severe: 0 }
    data?.riskZones.forEach((z) => {
      const aqi = predictedAt(z.forecast, horizon, z.currentAQI)
      counts[severityForAqi(aqi)] += 1
    })
    return counts
  }, [data, horizon])

  const chartForecast = selectedZone?.forecast ?? cityForecast
  const chartTitle = selectedZone ? selectedZone.name : `${placeLabel} average`

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar
        cities={CITIES}
        cityId={usingGeo ? (geoLocation?.id ?? "__geo__") : presetCity.id}
        onCityChange={(id) => {
          if (id === geoLocation?.id) return
          setPlace({ kind: "city", id })
          geo.reset()
          setSelectedZoneId(null)
        }}
        geoLocation={geoLocation}
        isGeolocated={usingGeo && !searchedName}
        onSearchSelect={handleSearchSelect}
        onUseMyLocation={geo.locate}
        isLocating={geo.status === "locating"}
        locationError={geo.error}
        horizon={horizon}
        onHorizonChange={setHorizon}
        generatedAt={data?.generatedAt}
        onRefresh={() => mutate()}
        isLoading={isLoading || isValidating}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative h-[45vh] min-h-0 w-full lg:h-auto lg:flex-1">
          {data ? (
            <PollutionMap
              center={center}
              zoom={zoom}
              grid={grid}
              windVectors={data.windVectors}
              riskZones={data.riskZones}
              horizon={horizon}
              selectedZoneId={selectedZoneId}
              onSelectZone={(id) =>
                setSelectedZoneId((prev) => (prev === id ? null : id))
              }
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
          <MapLegend />
        </div>

        <aside className="flex min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-border bg-sidebar p-3 lg:w-[380px] lg:overflow-hidden lg:border-l lg:border-t-0">
          {data ? (
            <>
              <CurrentConditions conditions={data.conditions} />
              <ForecastChart forecast={chartForecast} title={chartTitle} horizon={horizon} />
              <div>
                <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Risk zones summary
                </h2>
                <RiskSummary counts={riskCounts} />
              </div>
              <SpilloverAlerts
                alerts={data.alerts}
                selectedZoneId={selectedZoneId}
                onSelectZone={(id) =>
                  setSelectedZoneId((prev) => (prev === id ? null : id))
                }
              />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </aside>
      </div>

      <ChatWidget
        context={{
          city: placeLabel,
          horizon,
          generatedAt: data?.generatedAt,
          conditions: data
            ? {
                aqi: data.conditions.aqi,
                category: aqiCategory(data.conditions.aqi).label,
                pm25: data.conditions.pm25,
                windSpeed: data.conditions.windSpeed,
                windDirection: data.conditions.windDirection,
                temperature: data.conditions.temperature,
                humidity: data.conditions.humidity,
              }
            : undefined,
          riskZones: data?.riskZones.map((z) => ({
            name: z.name,
            type: z.type,
            currentAQI: z.currentAQI,
          })),
        }}
      />
    </div>
  )
}
