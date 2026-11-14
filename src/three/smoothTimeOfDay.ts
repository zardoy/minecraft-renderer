/**
 * Game time arrives in steps: the server sends a time packet about once a second (20 ticks, ~0.3° of sun movement), so
 * anything driven by it directly (sun, shadows) jumps once a second. This turns the steps into continuous time:
 * between packets it keeps advancing at the rate measured from the last ones, and each new packet is blended in over a
 * short time instead of snapping. Pure arithmetic, no GPU cost.
 *
 * - frozen time (`doDaylightCycle` off) measures a rate of 0, so nothing drifts
 * - a jump (`/time set`, sleeping) is taken over at once
 * - extrapolation stops after a while without packets (lag spike, paused game) so it never runs away
 */

export const DAY_TICKS = 24_000
const MS_PER_TICK = 50
/** Rate bounds in ticks per ms: nothing is slower than frozen, nothing is faster than 3x speed. */
const MAX_RATE = 3 / MS_PER_TICK
/** A packet further than this from the prediction is a time change, not jitter. */
const JUMP_TICKS = 100
/** Stop extrapolating this long after the last packet. */
const MAX_EXTRAPOLATION_MS = 2500
/** A new packet's error is blended out over this long. */
const CORRECTION_MS = 600

/** Smallest signed difference a - b on the 24000 tick clock, in -12000..12000. */
export function tickDelta(a: number, b: number): number {
  return ((((a - b) % DAY_TICKS) + DAY_TICKS + DAY_TICKS / 2) % DAY_TICKS) - DAY_TICKS / 2
}

export class SmoothTimeOfDay {
  private reported = NaN
  private reportedAt = 0
  /** ticks per ms */
  private rate = 0
  private hasRate = false
  /** difference between the old prediction and the new packet, decays to 0 */
  private correction = 0
  private correctionAt = 0

  /** Feed every time update (ticks of the day, may be negative or >24000 for frozen time, see the world renderer). */
  update(time: number, nowMs: number): void {
    if (!Number.isFinite(time)) return
    if (Number.isNaN(this.reported)) {
      this.reported = time
      this.reportedAt = nowMs
      return
    }
    const predicted = this.get(nowMs)
    const dt = nowMs - this.reportedAt
    const delta = tickDelta(time, this.reported)
    if (Math.abs(tickDelta(time, predicted)) > JUMP_TICKS) {
      // time was set: take it over, keep the rate (a jump says nothing about the speed of time)
      this.correction = 0
    } else {
      if (dt >= 200 && dt <= 4000) {
        const measured = Math.min(MAX_RATE, Math.max(0, delta / dt))
        // ~0 is frozen time, not slow time
        const next = measured < 0.0005 ? 0 : measured
        this.rate = this.hasRate ? this.rate * 0.5 + next * 0.5 : next
        if (this.rate < 0.0005) this.rate = 0
        this.hasRate = true
      }
      this.correction = tickDelta(predicted, time)
      this.correctionAt = nowMs
    }
    this.reported = time
    this.reportedAt = nowMs
  }

  /** Continuous time of day in ticks (0..24000) at `nowMs`. */
  get(nowMs: number): number {
    if (Number.isNaN(this.reported)) return 0
    const sinceReport = Math.min(Math.max(0, nowMs - this.reportedAt), MAX_EXTRAPOLATION_MS)
    let time = this.reported + this.rate * sinceReport
    if (this.correction !== 0) {
      const left = 1 - Math.min(1, Math.max(0, (nowMs - this.correctionAt) / CORRECTION_MS))
      time += this.correction * left
    }
    return ((time % DAY_TICKS) + DAY_TICKS) % DAY_TICKS
  }

  /** ticks per second the time currently advances at (20 = normal, 0 = frozen) */
  get ticksPerSecond(): number {
    return this.rate * 1000
  }
}
