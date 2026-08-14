/**
 * In-memory stand-ins for the three ports, plus the one helper that makes a
 * promise-driven state machine testable: a way to let every already-scheduled
 * callback run before asserting.
 */

import { AudiolibError, type Quota, type Track } from '../src/audiolib.js'
import type { Clock, Playback, PreparedTrack, TrackSource } from '../src/ports.js'
import type { AmbientLogger } from '../src/ambient.js'

/**
 * Let every already-scheduled promise callback and immediate run.
 *
 * Five rounds is comfortably more than the deepest await chain in the
 * soundtrack; asserting after fewer produces flakes that look like bugs.
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
}

/** A clock that records what it was asked to wait for and, by default, never waits. */
export class FakeClock implements Clock {
  /** Every delay requested, in order. */
  readonly slept: number[] = []
  /** Every delay an abort cut short, in order. */
  readonly interrupted: number[] = []
  /** Whether sleeps park until aborted instead of returning at once. */
  #holding = false
  #now = 1_000_000

  /**
   * Make every later sleep park until its signal aborts. Returning instantly is
   * what lets a backoff sequence run inside one `settle`, but it also means a
   * test can never be *inside* a backoff — which is the only place from which
   * cutting one short is observable.
   */
  holdSleeps(): void {
    this.#holding = true
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.slept.push(ms)
    if (signal.aborted) {
      this.interrupted.push(ms)
      return
    }
    if (!this.#holding) return
    await new Promise<void>(resolve => {
      signal.addEventListener('abort', () => {
        this.interrupted.push(ms)
        resolve()
      }, { once: true })
    })
  }

  now(): number {
    return this.#now
  }

  /**
   * Move the clock forward.
   *
   * @param seconds - how far.
   */
  advance(seconds: number): void {
    this.#now += seconds
  }
}

/** A track source that answers from a script of queued outcomes. */
export class FakeSource implements TrackSource {
  /** Every library asked for, in order. */
  readonly requested: string[] = []
  /** Attached to every track this source returns. */
  quota: Quota | undefined
  readonly #failures: Error[] = []
  /** Set while a gated fetch waits; calling it lets that fetch finish. */
  #release: (() => void) | undefined
  /** Whether the next fetch parks before answering. */
  #gateNext = false
  #served = 0

  /**
   * Queue failures for the next calls.
   *
   * @param error - what to throw.
   * @param times - how many consecutive calls fail with it.
   */
  failNext(error: Error, times = 1): void {
    for (let i = 0; i < times; i += 1) this.#failures.push(error)
  }

  /**
   * Make the next fetch park until {@link releaseFetch}, so a test can act
   * while a request is genuinely in flight rather than only around one.
   */
  gateNextFetch(): void {
    this.#gateNext = true
  }

  /** Let a gated fetch answer. */
  releaseFetch(): void {
    const release = this.#release
    this.#release = undefined
    release?.()
  }

  async fetch(library: string): Promise<Track> {
    // Recorded before the gate, so a test can see the call is outstanding.
    this.requested.push(library)
    if (this.#gateNext) {
      this.#gateNext = false
      await new Promise<void>(resolve => { this.#release = resolve })
    }
    const failure = this.#failures.shift()
    if (failure !== undefined) throw failure
    this.#served += 1
    return {
      title: `${library} #${this.#served}`,
      url: `https://cdn.test/${this.#served}.mp3`,
      durationSec: 180,
      quota: this.quota,
    }
  }
}

/** A prepared handle carrying the title, so assertions can name tracks. */
interface FakePrepared extends PreparedTrack {
  readonly title: string
}

/** A playback whose tracks end only when the test says so. */
export class FakePlayback implements Playback {
  readonly prepared: string[] = []
  readonly played: string[] = []
  readonly disposed: string[] = []
  /** Set while a track is playing; calling it ends that track. */
  #finish: (() => void) | undefined
  /** Thrown by the next `play` call, once. */
  #failure: Error | undefined

  /** Whether a track is playing right now. */
  get isPlaying(): boolean {
    return this.#finish !== undefined
  }

  /**
   * Make the next playback fail, as a missing player binary would.
   *
   * @param error - what to throw.
   */
  failNextPlay(error: Error): void {
    this.#failure = error
  }

  // No return-type annotation: `Promise<PreparedTrack>` would make the literal
  // below excess-property-check against `PreparedTrack` before `satisfies` gets
  // a say — the same trap `createPlayback` documents.
  async prepare(track: Track) {
    this.prepared.push(track.title)
    const disposed = this.disposed
    return {
      title: track.title,
      async dispose() { disposed.push(track.title) },
    } satisfies FakePrepared
  }

  async play(prepared: PreparedTrack, signal: AbortSignal): Promise<void> {
    const failure = this.#failure
    this.#failure = undefined
    if (failure !== undefined) throw failure
    this.played.push((prepared as FakePrepared).title)
    await new Promise<void>(resolve => {
      this.#finish = resolve
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    this.#finish = undefined
  }

  /** End the playing track, as a real player does when the song runs out. */
  endTrack(): void {
    const finish = this.#finish
    this.#finish = undefined
    finish?.()
  }
}

/** A logger that keeps what it was told. */
export class FakeLogger implements AmbientLogger {
  readonly infos: string[] = []
  readonly warnings: string[] = []

  info(message: unknown): void {
    this.infos.push(String(message))
  }

  warn(message: unknown): void {
    this.warnings.push(String(message))
  }
}

/**
 * A transient AudioLib failure, the kind a flaky network produces.
 *
 * @returns the error to queue on a {@link FakeSource}.
 */
export function transientFailure(): AudiolibError {
  return new AudiolibError('transient', 'audiolib: request failed (network)')
}

/**
 * An auth failure, the kind a wrong key produces.
 *
 * @returns the error to queue on a {@link FakeSource}.
 */
export function authFailure(): AudiolibError {
  return new AudiolibError('auth', 'audiolib: request failed (HTTP 401)')
}

/**
 * A quota failure dated to a period end.
 *
 * @param periodEnd - Unix seconds at which the period rolls over.
 * @returns the error to queue on a {@link FakeSource}.
 */
export function quotaFailure(periodEnd: number): AudiolibError {
  return new AudiolibError('quota', 'audiolib: request failed (HTTP 402)', {
    planName: 'Starter', total: 300, used: 300, remaining: 0,
    unlimited: false, ratePerMinute: 10, periodEnd,
  })
}
