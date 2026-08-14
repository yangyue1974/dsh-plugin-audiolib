/**
 * The ambient soundtrack: agent activity selects a library, and the selection
 * only ever takes effect at a track seam.
 *
 * A track is never interrupted by a state change. Turns open and close far
 * faster than a song lasts, and cutting mid-track reads as noise rather than as
 * feedback; the seam is the only moment where switching carries information.
 */

import { requestTrack, type Endpoint, type Track } from './audiolib.js'
import { download, play, type LocalTrack } from './player.js'

/** Whether any session currently holds an open turn. */
export type Activity = 'working' | 'idle'

/** The subset of the Cordis logger this module uses. */
export interface AmbientLogger {
  info(message: unknown, ...args: unknown[]): void
  warn(message: unknown, ...args: unknown[]): void
}

/** Everything the soundtrack needs to run. */
export interface AmbientOptions {
  readonly endpoint: Endpoint
  /** Player argv, already resolved to a platform default when unset. */
  readonly playerCommand: readonly string[]
  /** Library played while a turn is open; empty means silence while working. */
  readonly workingLibrary: string
  /** Library played once every turn has closed; empty means silence when idle. */
  readonly idleLibrary: string
  readonly logger: AmbientLogger
}

/** A track already downloaded and ready to play. */
interface Prepared {
  readonly track: Track
  readonly local: LocalTrack
}

/** A prefetch in flight for one specific library. */
interface Prefetch {
  readonly library: string
  readonly work: Promise<Prepared | undefined>
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
   * Override the library chosen by activity. Playback starts immediately when
   * nothing is playing; otherwise the change lands at the next seam.
   *
   * @param library - AudioLib library id.
   * @returns when the override takes effect.
   */
  request(library: string): 'now' | 'next-track' {
    this.#override = library
    const playing = this.#loop !== undefined
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
    return this.#openTurns.size > 0 ? this.#options.workingLibrary : this.#options.idleLibrary
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
      let prepared: Prepared | undefined
      try {
        prepared = await this.#take(library)
      } catch (error) {
        this.#options.logger.warn('audiolib: stopped after a failed request')
        this.#options.logger.warn(error)
        return
      }
      if (prepared === undefined || this.#controller.signal.aborted) return
      this.#startPrefetch()
      this.#track = new AbortController()
      const signal = AbortSignal.any([this.#controller.signal, this.#track.signal])
      try {
        this.#options.logger.info('audiolib: %s — %s', library, prepared.track.title)
        await play(prepared.local.file, this.#options.playerCommand, signal)
      } catch (error) {
        this.#options.logger.warn('audiolib: playback stopped')
        this.#options.logger.warn(error)
        return
      } finally {
        this.#track = undefined
        await prepared.local.dispose()
      }
    }
  }

  /** Take the prefetched track when it matches `library`, else fetch a fresh one. */
  async #take(library: string): Promise<Prepared | undefined> {
    const prefetch = this.#prefetch
    this.#prefetch = undefined
    if (prefetch?.library === library) {
      const prepared = await prefetch.work
      if (prepared !== undefined) return prepared
    } else if (prefetch !== undefined) {
      await disposeQuietly(prefetch.work)
    }
    return this.#prepare(library)
  }

  /**
   * Fetch and download the next track while the current one plays. Calls are
   * cheap, so a prefetch discarded by a state change costs nothing worth saving.
   */
  #startPrefetch(): void {
    const library = this.#currentLibrary()
    if (library === '') return
    this.#prefetch = {
      library,
      work: this.#prepare(library).catch(() => undefined),
    }
  }

  async #prepare(library: string): Promise<Prepared | undefined> {
    const signal = this.#controller.signal
    const track = await requestTrack(this.#options.endpoint, library, signal)
    if (signal.aborted) return undefined
    const local = await download(track.url, signal)
    return { track, local }
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
async function disposeQuietly(work: Promise<Prepared | undefined>): Promise<void> {
  const prepared = await work.catch(() => undefined)
  await prepared?.local.dispose().catch(() => undefined)
}
