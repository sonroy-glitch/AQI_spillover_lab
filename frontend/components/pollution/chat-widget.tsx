"use client"

import { useEffect, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { Bot, Loader2, MessageCircle, Send, Sparkles, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export type ChatContext = {
  city: string
  horizon: number
  generatedAt?: string
  conditions?: {
    aqi: number
    category: string
    pm25: number
    windSpeed: number
    windDirection: number
    temperature: number
    humidity: number
  }
  riskZones?: { name: string; type: string; currentAQI: number }[]
}

const SUGGESTIONS = [
  "Is it safe to exercise outside right now?",
  "Why is pollution drifting toward the school zone?",
  "What does the AQI category mean for sensitive groups?",
  "How will the wind change air quality in the next 12 hours?",
]

export function ChatWidget({ context }: { context: ChatContext }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep a live ref to context so each request sends the latest dashboard state.
  const contextRef = useRef(context)
  contextRef.current = context

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages, context: contextRef.current },
      }),
    }),
  })

  const busy = status === "submitted" || status === "streaming"

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open, busy])

  function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    sendMessage({ text: trimmed })
    setInput("")
  }

  return (
    <>
      {/* Launcher */}
      <Button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close assistant" : "Open air quality assistant"}
        className="fixed bottom-5 right-5 z-[1100] size-14 rounded-full p-0 shadow-lg shadow-primary/30"
      >
        {open ? <X className="size-6" /> : <MessageCircle className="size-6" />}
      </Button>

      {/* Panel */}
      <div
        className={cn(
          "fixed bottom-24 right-5 z-[1100] flex w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl transition-all duration-200",
          open
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0",
        )}
        style={{ height: "min(560px, calc(100vh - 8rem))" }}
        role="dialog"
        aria-label="Air quality assistant"
        aria-hidden={!open}
      >
        {/* Header */}
        <header className="flex items-center gap-2 border-b border-border bg-sidebar px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Bot className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight text-foreground">AeroCast Assistant</p>
            <p className="truncate text-xs text-muted-foreground">
              Answering about {context.city}
            </p>
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Sparkles className="size-3.5" />
                </span>
                <p className="rounded-lg rounded-tl-none bg-secondary px-3 py-2 text-sm leading-relaxed text-secondary-foreground">
                  {`Hi! Ask me anything about the air quality, pollution forecast, or risk zones for ${context.city}.`}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => submit(s)}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => {
              const text = message.parts
                .filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p) => p.text)
                .join("")
              const isUser = message.role === "user"
              return (
                <div
                  key={message.id}
                  className={cn("flex items-start gap-2", isUser && "flex-row-reverse")}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                      isUser ? "bg-accent text-accent-foreground" : "bg-primary/15 text-primary",
                    )}
                  >
                    {isUser ? <span className="text-xs font-semibold">You</span> : <Bot className="size-3.5" />}
                  </span>
                  <p
                    className={cn(
                      "max-w-[78%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed",
                      isUser
                        ? "rounded-tr-none bg-primary text-primary-foreground"
                        : "rounded-tl-none bg-secondary text-secondary-foreground",
                    )}
                  >
                    {text || (busy ? "…" : "")}
                  </p>
                </div>
              )
            })
          )}

          {busy && messages[messages.length - 1]?.role === "user" && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Bot className="size-3.5" />
              </span>
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
          className="flex items-center gap-2 border-t border-border bg-sidebar px-3 py-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about air quality…"
            aria-label="Message"
            className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            type="submit"
            size="icon"
            className="size-10 shrink-0"
            disabled={busy || !input.trim()}
            aria-label="Send message"
          >
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </>
  )
}
