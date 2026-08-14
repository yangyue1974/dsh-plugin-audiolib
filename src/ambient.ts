/**
 * The ambient soundtrack: agent activity selects a library, and the selection
 * only ever takes effect at a track seam.
 *
 * A track is never interrupted by a state change. Turns open and close far
 * faster than a song lasts, and cutting mid-track reads as noise rather than as
 * feedback; the seam is the only moment where switching carries information.
 */

import type { Quota, Track } from './audiolib.js'
import type { Clock, Playback, PreparedTrack, TrackSource } from './ports.js'

/** Whether any session currently holds an open turn. */
export type Activity = 'working' | 'idle'

/** The subset of the Cordis logger this module uses. */
export interface AmbientLogger {
  info(message: unknown, ...args: unknown[]): void
  warn(message: unknown, ...args: unknown[]): void
}

/** What the soundtrack is doing right now, plus the account state behind it. */
export interface AmbientStatus {
  /** Library of the playing track; empty when silent. */
  readonly library: string
  /** Title of the playing track; empty when silent. */
  readonly title: string
  /** Quota reported by the most recent API call; absent before the first one. */
  readonly quota: Quota | undefined
}

/** Everything the soundtrack needs to run. */
export interface AmbientOptions {
  /** Where tracks come from. */
  readonly source: TrackSource
  /** How they reach the speakers. */
  readonly playback: Playback
  /** Time, so a retry delay is something a test can inspect. */
  readonly clock: Clock
  /**
   * The libraries in force right now. A thunk, not two strings: settings can
   * change under a running soundtrack, and the next seam must read the choice
   * that stands then rather than the one composed at load.
   *
   * @returns `working` plays while a turn is open, `idle` once every turn has
   * closed; either empty means silence in that state.
   */
  libraries(): { working: string; idle: string }
  readonly logger: AmbientLogger
}

/** A track plus the handle that plays it. */
interface Taken {
  readonly track: Track
  readonly prepared: PreparedTrack
}

/** A prefetch in flight for one specific library. */
interface Prefetch {
  readonly library: string
  readonly work: Promise<Taken>
}

/**
 * Plays one track at a time, choosing the next library at each seam from the
 * current activity and any explicit override.
 */
export class AmbientSoundtrack {
  readonly #options: AmbientOptions
  readonly #controller = new AbortController()
  readonly #openTurns = new Set<string>()
  /** Library requested by an explicit call, outranking the activity mapping. */
  #override: string | undefined
  #loop: Promise<void> | undefined
  #prefetch: Prefetch | undefined
  /** Newest quota snapshot, refreshed by every successful API call. */
  #quota: Quota | undefined
  #playing: { library: string; title: string } | undefined
  /** Aborts only the current track, leaving the loop free to pick the next one. */
  #track: AbortController | undefined

  constructor(options: AmbientOptions) {
    this.#options = options
  }

  /**
   * Record that `session` opened a turn. Playback starts on the first open turn
   * and the library takes effect at the next seam.
   *
   * @param session - the session id that opened the turn.
   */
  turnOpened(session: string): void {
    this.#openTurns.add(session)
    this.#ensureRunning()
  }

  /**
   * Record that `session` closed its turn. The playing track finishes first.
   *
   * @param session - the session id whose turn ended.
   */
  turnClosed(session: string): void {
    this.#openTurns.delete(session)
    this.#ensureRunning()
  }

  /**
   * What is playing and what the account has left.
   *
   * @returns the current track and the newest quota snapshot.
   */
  status(): AmbientStatus {
    return {
      library: this.#playing?.library ?? '',
      title: this.#playing?.title ?? '',
      quota: this.#quota,
    }
  }

  /**
   * Prepare one track before anything asks for it, so the first turn opens on
   * the downbeat rather than on whatever the network takes to answer.
   */
  warmUp(): void {
    this.#startPrefetch(this.#options.libraries().working)
  }

  /**
   * Override the library chosen by activity. Playback starts immediately when
   * nothing is playing; otherwise the change lands at the next seam.
   *
   * @param library - AudioLib library id.
   * @returns when the override takes effect.
   */
  request(library: string): 'now' | 'next-track' {
    this.#override = library
    const playing = this.#loop !== undefined
    // Fetch the newly chosen library now, so the seam does not stall on it.
    this.#startPrefetch(library)
    this.#ensureRunning()
    return playing ? 'next-track' : 'now'
  }

  /**
   * Stop playback now and drop any override. An explicit stop is the one case
   * that interrupts a track: silence requested is silence owed.
   *
   * @returns when the current track has been stopped.
   */
  async stop(): Promise<void> {
    this.#override = ''
    this.#track?.abort()
    await this.#loop
  }

  /** Stop playback and release every temporary file. */
  async dispose(): Promise<void> {
    this.#controller.abort()
    this.#track?.abort()
    await this.#loop?.catch(() => undefined)
    await this.#discardPrefetch()
  }

  /** The library that a seam reached right now would play; empty means silence. */
  #currentLibrary(): string {
    if (this.#override !== undefined) return this.#override
    const { working, idle } = this.#options.libraries()
    return this.#openTurns.size > 0 ? working : idle
  }

  #ensureRunning(): void {
    if (this.#loop !== undefined || this.#controller.signal.aborted) return
    if (this.#currentLibrary() === '') return
    this.#loop = this.#run().finally(() => {
      this.#loop = undefined
    })
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const library = this.#currentLibrary()
      if (library === '') return
      let taken: Taken
      try {
        taken = await this.#take(library)
      } catch (error) {
        this.#options.logger.warn('audiolib: stopped after a failed request')
        this.#options.logger.warn(error)
        return
      }
      if (this.#controller.signal.aborted) {
        await taken.prepared.dispose().catch(() => undefined)
        return
      }
      this.#startPrefetch()
      this.#track = new AbortController()
      const signal = AbortSignal.any([this.#controller.signal, this.#track.signal])
      this.#playing = { library, title: taken.track.title }
      try {
        this.#options.logger.info('audiolib: %s — %s (quota left: %s)', library, taken.track.title,
          this.#quota === undefined ? '?' : this.#quota.unlimited ? 'unlimited' : String(this.#quota.remaining))
        await this.#options.playback.play(taken.prepared, signal)
      } catch (error) {
        this.#options.logger.warn('audiolib: playback stopped')
        this.#options.logger.warn(error)
        return
      } finally {
        this.#track = undefined
        this.#playing = undefined
        await taken.prepared.dispose().catch(() => undefined)
      }
    }
  }

  /** Take the prefetched track when it matches `library`, else fetch a fresh one. */
  async #take(library: string): Promise<Taken> {
    const prefetch = this.#prefetch
    this.#prefetch = undefined
    if (prefetch?.library === library) return prefetch.work
    if (prefetch !== undefined) void disposeQuietly(prefetch.work)
    return this.#prepare(library)
  }

  /**
   * Fetch and prepare a track ahead of the seam that will play it. Calls are
   * cheap, so a prefetch discarded by a state change costs nothing worth saving.
   *
   * @param library - the library to prepare; defaults to what a seam would pick now.
   */
  #startPrefetch(library: string = this.#currentLibrary()): void {
    if (library === '' || this.#controller.signal.aborted) return
    const existing = this.#prefetch
    if (existing?.library === library) return
    if (existing !== undefined) void disposeQuietly(existing.work)
    const work = this.#prepare(library)
    // A prefetch nobody ends up awaiting must not crash the process; the taker
    // still sees the rejection through its own reference to the same promise.
    void work.catch(() => undefined)
    this.#prefetch = { library, work }
  }

  async #prepare(library: string): Promise<Taken> {
    const signal = this.#controller.signal
    const track = await this.#options.source.fetch(library, signal)
    if (track.quota !== undefined) this.#quota = track.quota
    const prepared = await this.#options.playback.prepare(track, signal)
    return { track, prepared }
  }

  async #discardPrefetch(): Promise<void> {
    const prefetch = this.#prefetch
    this.#prefetch = undefined
    if (prefetch !== undefined) await disposeQuietly(prefetch.work)
  }
}

/**
 * Release a prepared track that will never be played.
 *
 * @param work - the prefetch whose result is no longer wanted.
 */
async function disposeQuietly(work: Promise<Taken>): Promise<void> {
  const taken = await work.catch(() => undefined)
  await taken?.prepared.dispose().catch(() => undefined)
}
