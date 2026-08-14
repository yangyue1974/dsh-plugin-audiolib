/**
 * Why the soundtrack is or is not playing, and how long to wait before trying
 * again.
 *
 * Pure by design: no clock, no network, no state. The soundtrack owns the
 * decision of *when* to act; this module owns only what the decision is.
 */

import type { AudiolibErrorKind, Quota } from './audiolib.js'

/** Why a paused soundtrack stopped. */
export type PauseReason = 'auth' | 'quota' | 'player' | 'config'

/** The single authority on why no music is playing. */
export type Health =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'retrying'
      /** Consecutive failures so far, starting at 1. */
      readonly attempts: number
      /** The newest failure, in the words the API or the player used. */
      readonly message: string
    }
  | {
      readonly kind: 'paused'
      readonly reason: PauseReason
      readonly message: string
      /**
       * Unix seconds after which a retry is allowed. `0` means the pause never
       * lifts on its own — something outside the process has to change first.
       */
      readonly untilUnix: number
    }

/** The first delay; each further attempt doubles it. */
const BASE_BACKOFF_MS = 1_000

/**
 * The ceiling the delay grows to. There is deliberately no attempt ceiling to
 * go with it: background music should resume by itself after a two-hour
 * outage, and one probe every thirty seconds costs nothing worth counting.
 */
export const MAX_BACKOFF_MS = 30_000

/** Beyond this the doubling has long since hit the cap; stop shifting. */
const CAPPED_AT_ATTEMPT = 6

/**
 * How long to wait before the retry that follows `attempts` failures.
 *
 * @param attempts - consecutive failures so far, starting at 1.
 * @returns the delay in milliseconds: 1s, 2s, 4s, 8s, 16s, then 30s forever.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 1) return BASE_BACKOFF_MS
  if (attempts >= CAPPED_AT_ATTEMPT) return MAX_BACKOFF_MS
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)
}

/**
 * The health a failed request produces.
 *
 * @param kind - the classification the API client attached.
 * @param message - what to show a human.
 * @param attempts - consecutive failures so far including this one.
 * @param quota - the newest quota snapshot, which is what dates a quota pause.
 * @returns the health the soundtrack should adopt.
 */
export function healthFromError(
  kind: AudiolibErrorKind,
  message: string,
  attempts: number,
  quota: Quota | undefined,
): Health {
  switch (kind) {
    case 'transient':
      return { kind: 'retrying', attempts, message }
    case 'quota':
      // The API already says when the period rolls over, so the plugin does
      // not have to guess; an undated rollover is one it must not guess at.
      return { kind: 'paused', reason: 'quota', message, untilUnix: quota?.periodEnd ?? 0 }
    case 'auth':
      return { kind: 'paused', reason: 'auth', message, untilUnix: 0 }
    case 'config':
      return { kind: 'paused', reason: 'config', message, untilUnix: 0 }
  }
}
