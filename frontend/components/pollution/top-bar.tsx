"use client"

import { useEffect, useState } from "react"
import { LocateFixed, RefreshCw, Wind } from "lucide-react"

import type { City, ResolvedLocation, SearchResult } from "@/lib/pollution/types"
import { CitySearch } from "@/components/pollution/city-search"
import { HORIZONS } from "@/lib/pollution/data"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

function LastUpdated({ iso }: { iso?: string }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  if (!iso) return null
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  const label =
    seconds < 5 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      <span className="text-xs text-muted-foreground">
        Updated <span className="text-foreground">{label}</span>
      </span>
    </div>
  )
}

interface TopBarProps {
  cities: City[]
  cityId: string
  onCityChange: (id: string) => void
  horizon: number
  onHorizonChange: (h: number) => void
  generatedAt?: string
  onRefresh: () => void
  isLoading: boolean
  /** Set when the dashboard is showing a non-preset place (searched or geolocated). */
  geoLocation?: ResolvedLocation | null
  /** True only when that place came from the browser, not the search box. */
  isGeolocated?: boolean
  onUseMyLocation: () => void
  isLocating: boolean
  locationError?: string | null
  onSearchSelect: (result: SearchResult) => void
}

export function TopBar({
  cities,
  cityId,
  onCityChange,
  horizon,
  onHorizonChange,
  generatedAt,
  onRefresh,
  isLoading,
  geoLocation,
  isGeolocated = false,
  onUseMyLocation,
  isLocating,
  locationError,
  onSearchSelect,
}: TopBarProps) {
  const customPlace = Boolean(geoLocation)
  // `backdrop-blur` makes this header its own stacking context, so the search
  // dropdown's z-index only counts inside it — the header itself has to sit above
  // Leaflet's panes (which go up to z-700).
  return (
    <header className="relative z-[1000] flex flex-col gap-3 border-b border-border bg-card/60 px-4 py-3 backdrop-blur-sm lg:flex-row lg:items-center lg:gap-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Wind className="size-5" />
        </div>
        <div>
          <h1 className="text-sm font-semibold leading-tight text-foreground">AeroCast</h1>
          <p className="text-[11px] leading-tight text-muted-foreground">
            Predictive Pollution Movement
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Select value={cityId} onValueChange={(v) => v && onCityChange(v)}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Select location">
              <SelectValue>
                {(value) => {
                  if (customPlace && value === geoLocation!.id) {
                    return geoLocation!.country
                      ? `${geoLocation!.name}, ${geoLocation!.country}`
                      : geoLocation!.name
                  }
                  const c = cities.find((city) => city.id === value)
                  return c ? `${c.name}, ${c.country}` : "Select location"
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {customPlace && (
                <SelectItem value={geoLocation!.id}>
                  {geoLocation!.name}
                  {geoLocation!.country ? `, ${geoLocation!.country}` : ""}
                  {isGeolocated ? " (your location)" : ""}
                </SelectItem>
              )}
              {cities.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}, {c.country}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <CitySearch onSelect={onSearchSelect} className="hidden w-52 md:block" />

          <Button
            type="button"
            variant={isGeolocated ? "default" : "outline"}
            size="sm"
            onClick={onUseMyLocation}
            disabled={isLocating}
            aria-label="Use my location"
            title={locationError ?? "Use my location"}
            className={cn("h-9 shrink-0 gap-1.5", !isGeolocated && "bg-transparent")}
          >
            <LocateFixed className={cn("size-4", isLocating && "animate-pulse")} />
            <span className="hidden sm:inline">
              {isLocating ? "Locating…" : isGeolocated ? "Located" : "My location"}
            </span>
          </Button>
        </div>

        <div className="flex flex-1 items-center gap-3">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">Forecast</span>
          <div className="flex-1">
            <Slider
              min={0}
              max={24}
              step={6}
              value={[horizon]}
              onValueChange={(v) => onHorizonChange(Array.isArray(v) ? v[0] : v)}
              aria-label="Forecast horizon in hours"
            />
            <div className="mt-1.5 flex justify-between">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => onHorizonChange(h)}
                  className={cn(
                    "text-[11px] tabular-nums transition-colors",
                    horizon === h
                      ? "font-semibold text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {h === 0 ? "now" : `+${h}h`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 lg:justify-end">
        {locationError && (
          <p className="max-w-[260px] text-[11px] leading-tight text-destructive" role="status">
            {locationError}
          </p>
        )}
        <LastUpdated iso={generatedAt} />
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="h-8 gap-1.5 bg-transparent"
        >
          <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </header>
  )
}
