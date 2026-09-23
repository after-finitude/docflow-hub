'use client'

import type { StreamEvent } from '@docflow/shared'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type Listener = (event: StreamEvent) => void

interface EventStream {
  live: boolean
  subscribe: (listener: Listener) => () => void
}

const EventStreamContext = createContext<EventStream | null>(null)

/** The browser does not retry a refused stream (non-200), so reconnect ourselves. */
const RECONNECT_MS = 5000

/**
 * One EventSource for the app, open while at least one component listens — so
 * the login page never connects — and kept across client navigation. While it is
 * down, listeners poll instead (spec 5.1) until it reconnects.
 */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>())
  const [subscribers, setSubscribers] = useState(0)
  const [live, setLive] = useState(false)
  const active = subscribers > 0

  useEffect(() => {
    if (!active) return
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      source = new EventSource('/api/events/stream')
      source.addEventListener('open', () => setLive(true))
      source.addEventListener('message', (message) => {
        const event = JSON.parse(message.data as string) as StreamEvent
        for (const listener of listeners.current) listener(event)
      })
      source.addEventListener('error', () => {
        setLive(false)
        if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, RECONNECT_MS)
      })
    }
    connect()
    return () => {
      clearTimeout(retry)
      source?.close()
      setLive(false)
    }
  }, [active])

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener)
    setSubscribers((count) => count + 1)
    return () => {
      listeners.current.delete(listener)
      setSubscribers((count) => count - 1)
    }
  }, [])

  const value = useMemo(() => ({ live, subscribe }), [live, subscribe])
  return <EventStreamContext value={value}>{children}</EventStreamContext>
}

/** Receive stream events; returns whether the stream is live (otherwise poll). */
export function useStreamEvents(listener: Listener): boolean {
  const stream = useContext(EventStreamContext)
  if (!stream) throw new Error('useStreamEvents requires EventStreamProvider')
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  })
  const { subscribe } = stream
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe])
  return stream.live
}
