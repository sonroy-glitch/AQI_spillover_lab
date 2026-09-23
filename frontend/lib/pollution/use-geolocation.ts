"use client"

import { useCallback, useState } from "react"

export type GeolocationStatus = "idle" | "locating" | "granted" | "error"

export interface GeolocationState {
  status: GeolocationStatus
  error: string | null
}

/** Browser geolocation errors are numeric codes; these read better in a tooltip. */
function messageFor(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission denied. Allow it in your browser's site settings."
    case err.POSITION_UNAVAILABLE:
      return "Your position is unavailable right now."
    case err.TIMEOUT:
      return "Timed out while locating you."
    default:
      return err.message || "Could not get your location."
  }
}

/**
 * Wraps navigator.geolocation in a one-shot request.
 *
 * Note: browsers only expose this in a secure context — https, or localhost in
 * development. Over plain http on a LAN address the API is simply absent, which
 * is reported here as an error rather than hanging.
 */
export function useGeolocation(onLocated: (coords: { lat: number; lng: number }) => void) {
  const [state, setState] = useState<GeolocationState>({ status: "idle", error: null })

  const locate = useCallback(() => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setState({
        status: "error",
        error: window?.isSecureContext === false
          ? "Geolocation needs a secure context (https or localhost)."
          : "This browser doesn't support geolocation.",
      })
      return
    }

    setState({ status: "locating", error: null })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState({ status: "granted", error: null })
        onLocated({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      (err) => setState({ status: "error", error: messageFor(err) }),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    )
  }, [onLocated])

  const reset = useCallback(() => setState({ status: "idle", error: null }), [])

  return { ...state, locate, reset }
}
