/**
 * Mesh ticks. Bulk work is polled on an interval. An urgent dirty kicks the
 * same runner on the next turn, and a kick during an in-progress tick reruns
 * after that tick yields instead of waiting for the next poll.
 */

export const BULK_MESH_INTERVAL_MS = 50

export function createMeshTickScheduler(run: () => Promise<void> | void) {
  let running = false
  let rerun = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const pump = async () => {
    timer = null
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      do {
        rerun = false
        await run()
      } while (rerun)
    } finally {
      running = false
    }
  }

  return {
    kick() {
      if (running) {
        rerun = true
        return
      }
      if (timer != null) return
      timer = setTimeout(() => {
        void pump()
      }, 0)
    }
  }
}
