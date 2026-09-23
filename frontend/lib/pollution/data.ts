import type { City } from "./types"

/**
 * Static shell data. Everything that changes — conditions, heatmap grids, wind,
 * risk zones, alerts — comes from the Flask backend via `/api/forecast`
 * (see ../../../backend/app.py). Keep this list in sync with CITIES there;
 * the backend also serves it at `/api/cities`.
 */
export const CITIES: City[] = [
  { id: "delhi", name: "New Delhi", country: "India", center: [28.6139, 77.209], zoom: 11 },
  { id: "los-angeles", name: "Los Angeles", country: "USA", center: [34.0522, -118.2437], zoom: 11 },
  { id: "beijing", name: "Beijing", country: "China", center: [39.9042, 116.4074], zoom: 11 },
  { id: "london", name: "London", country: "UK", center: [51.5074, -0.1278], zoom: 11 },
  { id: "mexico-city", name: "Mexico City", country: "Mexico", center: [19.4326, -99.1332], zoom: 11 },
  { id: "jakarta", name: "Jakarta", country: "Indonesia", center: [-6.2088, 106.8456], zoom: 11 },
]

export const HORIZONS = [0, 6, 12, 18, 24] as const
