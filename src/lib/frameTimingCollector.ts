/**
 * Frame Timing Collector (Worker-side)
 *
 * Collects frame timing events and sends them to main thread via nonReactiveState
 * This runs in the worker context and updates the shared state
 */

import { NonReactiveState } from '../graphicsBackend'

export interface FrameTimingEvent {
  type: 'frameStart' | 'frameEnd' | 'cameraUpdate' | 'frameDisplay'
  timestamp: number
  duration?: number
}

export class FrameTimingCollector {
  private events: FrameTimingEvent[] = []
  private frozenEvents: FrameTimingEvent[] = []
  private lastSecondEvents: FrameTimingEvent[] = []

  private currentFrameStartTime: number | null = null
  private lastInteractionTime = 0
  private lastSecondUpdateTime = 0

  private readonly timeWindowMs = 5000 // Show last 5 seconds
  private readonly lastSecondWindowMs = 1000 // Show last 1 second
  private readonly maxEvents = 500 // Limit events to prevent memory issues
  private readonly lastSecondUpdateInterval = 1000 // Update once per second

  constructor(private nonReactiveState: NonReactiveState) {
    // Initialize timeline if not exists
    if (!this.nonReactiveState.renderer) {
      ;(this.nonReactiveState as any).renderer = { timeline: { live: [], frozen: [], lastSecond: [] } }
    }
    if (!this.nonReactiveState.renderer.timeline) {
      this.nonReactiveState.renderer.timeline = { live: [], frozen: [], lastSecond: [] }
    }

    // Start interval to update last second timeline
    setInterval(() => {
      this.updateLastSecondTimeline()
    }, this.lastSecondUpdateInterval)
  }

  markFrameStart() {
    this.currentFrameStartTime = performance.now()
    this.addEvent({
      type: 'frameStart',
      timestamp: this.currentFrameStartTime
    })
  }

  markFrameEnd() {
    if (!this.currentFrameStartTime) return

    const now = performance.now()
    const duration = now - this.currentFrameStartTime

    this.addEvent({
      type: 'frameEnd',
      timestamp: now,
      duration
    })

    this.currentFrameStartTime = null
  }

  markCameraUpdate(posIsFalsey: boolean) {
    if (!posIsFalsey) return

    const now = performance.now()
    this.lastInteractionTime = now

    this.addEvent({
      type: 'cameraUpdate',
      timestamp: now
    })

    // Update frozen timeline when interaction happens
    this.frozenEvents = [...this.events]
    this.trimEvents(this.frozenEvents)
    this.syncFrozenEvents()
  }

  markFrameDisplay() {
    this.addEvent({
      type: 'frameDisplay',
      timestamp: performance.now()
    })
  }

  private addEvent(event: FrameTimingEvent) {
    this.events.push(event)
    this.lastSecondEvents.push(event)
    this.trimEvents(this.events)
    this.trimLastSecondEvents()
    this.syncLiveEvents()
    // Note: lastSecond syncs separately via interval
  }

  private trimEvents(events: FrameTimingEvent[]) {
    const now = performance.now()
    const cutoff = now - this.timeWindowMs

    // Remove old events
    while (events.length > 0 && events[0].timestamp < cutoff) {
      events.shift()
    }

    // Limit total events to prevent memory issues
    if (events.length > this.maxEvents) {
      events.splice(0, events.length - this.maxEvents)
    }
  }

  private trimLastSecondEvents() {
    const now = performance.now()
    const cutoff = now - this.lastSecondWindowMs

    // Remove old events
    while (this.lastSecondEvents.length > 0 && this.lastSecondEvents[0].timestamp < cutoff) {
      this.lastSecondEvents.shift()
    }
  }

  private updateLastSecondTimeline() {
    const now = performance.now()

    // Only update if at least 1 second has passed
    if (now - this.lastSecondUpdateTime < this.lastSecondUpdateInterval) {
      return
    }

    this.lastSecondUpdateTime = now
    this.trimLastSecondEvents()
    this.syncLastSecondEvents()
  }

  private syncLiveEvents() {
    // Update nonReactiveState with current events
    // This will sync to main thread via workerProxy
    this.nonReactiveState.renderer.timeline.live = [...this.events]
  }

  private syncFrozenEvents() {
    this.nonReactiveState.renderer.timeline.frozen = [...this.frozenEvents]
  }

  private syncLastSecondEvents() {
    this.nonReactiveState.renderer.timeline.lastSecond = [...this.lastSecondEvents]
  }

  clear() {
    this.events = []
    this.frozenEvents = []
    this.lastSecondEvents = []
    this.syncLiveEvents()
    this.syncFrozenEvents()
    this.syncLastSecondEvents()
  }
}
