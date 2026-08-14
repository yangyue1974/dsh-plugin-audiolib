/**
 * The boundaries the soundtrack talks through.
 *
 * `ambient.ts` imports nothing else that touches the network, the filesystem,
 * or the clock. That is what lets a test drive the whole state machine —
 * including a retry sequence — without waiting for any of them.
 */

import type { Track } from './audiolib.js'

/** Where tracks come from. */
export interface TrackSource {
  /**
   * Request one track.
   *
   * @param library - AudioLib library id.
   * @param signal - cancellation.
   * @returns the selected track.
   * @throws AudiolibError classified for the retry policy.
   */
  fetch(library: string, signal: AbortSignal): Promise<Track>
}

/**
 * A track ready to play. Opaque to the soundtrack, which only ever hands it
 * back to the same {@link Playback} or disposes it.
 */
export interface PreparedTrack {
  /** Release whatever preparation reserved. Safe to call more than once. */
  dispose(): Promise<void>
}

/** How tracks reach the speakers. */
export interface Playback {
  /**
   * Get a track ready. Nothing for a streaming player; a download for a
   * file-only one — which is what keeps the prefetch worth doing on `afplay`.
   *
   * @param track - the track to prepare.
   * @param signal - cancellation; an aborted preparation releases what it took.
   * @returns the handle to play or dispose.
   */
  prepare(track: Track, signal: AbortSignal): Promise<PreparedTrack>
  /**
   * Play to completion.
   *
   * @param prepared - a handle from this same playback's `prepare`.
   * @param signal - cancellation; an aborted signal resolves rather than throws,
   * because a stopped track is a normal outcome.
   * @throws when the player is missing or exits non-zero on its own.
   */
  play(prepared: PreparedTrack, signal: AbortSignal): Promise<void>
}

/** Time, injected so a backoff test waits for none of it. */
export interface Clock {
  /**
   * Wait.
   *
   * @param ms - how long.
   * @param signal - cancellation; an aborted wait resolves early.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** @returns the current time in Unix seconds. */
  now(): number
}
