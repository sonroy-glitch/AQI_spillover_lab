"use client"

import "leaflet/dist/leaflet.css"
import L from "leaflet"
import "leaflet.heat"
import { useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet"
import { GraduationCap, HardHat, Navigation, PersonStanding } from "lucide-react"

import { aqiColor, HEAT_GRADIENT, severityForAqi } from "@/lib/pollution/aqi"
import type { GridPoint, RiskZone, WindVector, ZoneType } from "@/lib/pollution/types"
import { SeverityBadge } from "@/components/pollution/severity-badge"
import { ZONE_META } from "@/components/pollution/zone-meta"

const ZONE_SVG: Record<ZoneType, string> = {
  school: renderToStaticMarkup(<GraduationCap size={15} strokeWidth={2.5} color="#0b0f14" />),
  stadium: renderToStaticMarkup(<PersonStanding size={15} strokeWidth={2.5} color="#0b0f14" />),
  worker_zone: renderToStaticMarkup(<HardHat size={15} strokeWidth={2.5} color="#0b0f14" />),
}

const ARROW_SVG = renderToStaticMarkup(
  <Navigation size={16} strokeWidth={2} color="#5eead4" fill="#5eead4" fillOpacity={0.85} />,
)

function intensityFor(aqi: number) {
  return Math.min(1, Math.max(0.05, aqi / 260))
}

/** Heat layer that smoothly interpolates between horizon snapshots. */
function HeatLayer({ grid }: { grid: GridPoint[] }) {
  const map = useMap()
  const layerRef = useRef<L.Layer | null>(null)
  const prevRef = useRef<number[] | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const heat = (L as any).heatLayer([], {
      radius: 34,
      blur: 26,
      max: 1,
      minOpacity: 0.35,
      gradient: HEAT_GRADIENT,
    })
    heat.addTo(map)
    layerRef.current = heat
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      map.removeLayer(heat)
    }
  }, [map])

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const heat = layerRef.current as any
    if (!heat) return

    const target = grid.map((p) => intensityFor(p.aqi))
    const start = prevRef.current ?? target
    const duration = 650
    const t0 = performance.now()

    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / duration)
      const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      const latlngs = grid.map((p, i) => {
        const v = start[i] + (target[i] - start[i]) * eased
        return [p.lat, p.lng, v] as [number, number, number]
      })
      heat.setLatLngs(latlngs)
      if (k < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        prevRef.current = target
      }
    }
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(tick)
  }, [grid])

  return null
}

function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    map.flyTo(center, zoom, { duration: 1.1 })
  }, [center, zoom, map])
  return null
}

function windIcon(direction: number, speed: number) {
  const scale = 0.7 + Math.min(1, speed / 30) * 0.6
  return L.divIcon({
    className: "risk-marker-icon",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<div style="transform: rotate(${direction}deg) scale(${scale}); transition: transform .4s ease; opacity:.9; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6));">${ARROW_SVG}</div>`,
  })
}

function zoneIcon(type: ZoneType, color: string, selected: boolean) {
  const size = selected ? 42 : 34
  const inner = selected ? 30 : 24
  return L.divIcon({
    className: "risk-marker-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
    html: `
      <div style="position:relative;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;">
        ${selected ? `<span class="aqi-pulse" style="position:absolute;inset:0;border-radius:9999px;background:${color}33;"></span>` : ""}
        <span style="position:relative;display:flex;align-items:center;justify-content:center;width:${inner}px;height:${inner}px;border-radius:9999px;background:${color};box-shadow:0 2px 8px rgba(0,0,0,.55), inset 0 0 0 2px rgba(255,255,255,.25);">
          ${ZONE_SVG[type]}
        </span>
      </div>`,
  })
}

interface PollutionMapProps {
  center: [number, number]
  zoom: number
  grid: GridPoint[]
  windVectors: WindVector[]
  riskZones: RiskZone[]
  horizon: number
  selectedZoneId: string | null
  onSelectZone: (id: string) => void
}

// Basemap tiles. Esri's Dark Gray Canvas is keyless, matches the dark UI and leaves
// the AQI heatmap as the only saturated thing on screen. CARTO's raster tiles now
// stamp "API KEY REQUIRED" across unkeyed requests, so they are opt-in via env.
const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ??
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"

const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION ??
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

export default function PollutionMap({
  center,
  zoom,
  grid,
  windVectors,
  riskZones,
  horizon,
  selectedZoneId,
  onSelectZone,
}: PollutionMapProps) {
  const windMarkers = useMemo(
    () =>
      windVectors.map((w, i) => (
        <Marker
          key={`wind-${i}`}
          position={[w.lat, w.lng]}
          icon={windIcon(w.direction, w.speed)}
          interactive={false}
          keyboard={false}
        />
      )),
    [windVectors],
  )

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      zoomControl
      className="h-full w-full"
      preferCanvas
    >
      <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
      <HeatLayer grid={grid} />
      <FlyTo center={center} zoom={zoom} />
      {windMarkers}
      {riskZones.map((zone) => {
        const color = aqiColor(zone.currentAQI)
        const fp =
          zone.forecast.find((p) => p.hour === horizon) ??
          zone.forecast[zone.forecast.length - 1]
        const predicted = horizon === 0 ? zone.currentAQI : fp.aqi
        const meta = ZONE_META[zone.type]
        return (
          <Marker
            key={zone.id}
            position={[zone.lat, zone.lng]}
            icon={zoneIcon(zone.type, color, selectedZoneId === zone.id)}
            eventHandlers={{ click: () => onSelectZone(zone.id) }}
          >
            <Popup>
              <div className="min-w-[200px] p-3 font-sans">
                <div className="flex items-center gap-2">
                  <meta.icon className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {meta.label}
                  </span>
                </div>
                <p className="mt-1 text-sm font-semibold text-foreground">{zone.name}</p>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Current AQI</p>
                    <p className="text-lg font-bold" style={{ color }}>
                      {zone.currentAQI}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-muted-foreground">
                      {horizon === 0 ? "Now" : `+${horizon}h`} forecast
                    </p>
                    <p className="text-lg font-bold" style={{ color: aqiColor(predicted) }}>
                      {predicted}
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <SeverityBadge severity={severityForAqi(predicted)} />
                </div>
              </div>
            </Popup>
          </Marker>
        )
      })}
    </MapContainer>
  )
}
