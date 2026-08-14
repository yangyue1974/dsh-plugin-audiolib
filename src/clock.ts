/** The real clock, kept out of `index.ts` so the wiring stays one screen. */

import { setTimeout as delay } from 'node:timers/promises'
import type { Clock } from './ports.js'

/** Time as the process sees it. */
export const systemClock: Clock = {
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    // An aborted wait resolves rather than throws: a cancelled retry is a
    // normal shutdown, not a failure the caller has to handle.
    await delay(ms, undefined, { signal }).catch(() => undefined)
  },
  now(): number {
    return Math.floor(Date.now() / 1_000)
  },
}
