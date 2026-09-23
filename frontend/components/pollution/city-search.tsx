"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { SearchResult } from "@/lib/pollution/types"

interface CitySearchProps {
  onSelect: (result: SearchResult) => void
  className?: string
}

/** Compact "population" for ranking context, e.g. 8961989 -> "9.0M". */
function formatPopulation(n?: number | null): string {
  if (!n) return ""
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function CitySearch({ onSelect, className }: CitySearchProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = query.trim()

  useEffect(() => {
    if (trimmed.length < 2) {
      setResults([])
      setError(null)
      setBusy(false)
      return
    }

    // Debounce so a fast typist makes one request, not one per keystroke.
    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&count=8`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Search failed (${res.status})`)
        const data: SearchResult[] = await res.json()
        setResults(Array.isArray(data) ? data : [])
        setError(null)
        setActive(0)
        setOpen(true)
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        setResults([])
        setError("Search is unavailable right now.")
      } finally {
        setBusy(false)
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed])

  // Close on an outside click, the usual combobox behaviour.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [])

  const showPanel = open && (busy || results.length > 0 || Boolean(error) || trimmed.length >= 2)

  function choose(result: SearchResult) {
    onSelect(result)
    setQuery("")
    setResults([])
    setOpen(false)
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false)
      return
    }
    if (!results.length) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === "Enter") {
      e.preventDefault()
      choose(results[active] ?? results[0])
    }
  }

  const emptyMessage = useMemo(() => {
    if (busy || error) return null
    if (trimmed.length >= 2 && results.length === 0) return `No places matching “${trimmed}”.`
    return null
  }, [busy, error, trimmed, results.length])

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search any city…"
          aria-label="Search for a city"
          aria-expanded={showPanel}
          aria-controls="city-search-results"
          role="combobox"
          className={cn(
            "h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm",
            "placeholder:text-muted-foreground focus-visible:outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring/50",
            "[&::-webkit-search-cancel-button]:appearance-none",
          )}
        />
        {busy ? (
          <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("")
              setResults([])
              setOpen(false)
              inputRef.current?.focus()
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {showPanel && (
        <ul
          id="city-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-[1200] max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {error && <li className="px-2 py-2 text-xs text-destructive">{error}</li>}
          {emptyMessage && (
            <li className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</li>
          )}
          {results.map((r, i) => (
            <li key={`${r.id}-${r.label}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm",
                  i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <span className="truncate">
                  <span className="font-medium">{r.name}</span>
                  {(r.region || r.country) && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {[r.region, r.country].filter(Boolean).join(", ")}
                    </span>
                  )}
                </span>
                {r.population ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatPopulation(r.population)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
