/**
 * The ambient soundtrack: agent activity selects a library, and the selection
 * only ever takes effect at a track seam.
 *
 * A track is never interrupted by a state change. Turns open and close far
 * faster than a song lasts, and cutting mid-track reads as noise rather than as
 * feedback; the seam is the only moment where switching carries information.
 */

import { AudiolibError, type Quota, type Track } from './audiolib.js'
import { backoffMs, healthFromError, type Health } from './health.js'
import type { Clock, Playback, PreparedTrack, TrackSource } from './ports.js'

/** Remaining share of the period's calls below which the plugin says so once. */
const LOW_QUOTA_FRACTION = 0.1

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
  /** Why the soundtrack is or is not playing. */
  readonly health: Health
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
  /** Library requested by `music_play`; cleared when the last open turn closes. */
  #override: string | undefined
  /** Set by `music_stop`. Only `music_play` clears it — a turn boundary must not. */
  #stopped = false
  #loop: Promise<void> | undefined
  #prefetch: Prefetch | undefined
  /** Newest quota snapshot, refreshed by every successful API call. */
  #quota: Quota | undefined
  /** Why the soundtrack is or is not playing. */
  #health: Health = { kind: 'ok' }
  /** Consecutive fetch failures; the first success resets it. */
  #attempts = 0
  /** Whether the low-quota warning has already been spent this period. */
  #warnedLowQuota = false
  #playing: { library: string; title: string } | undefined
  /** Aborts only the current track, leaving the loop free to pick the next one. */
  #track: AbortController | undefined
  /**
   * Aborts a backoff the loop is currently waiting out. A backoff reaches
   * thirty seconds and stays there, so anyone asking for silence or for a
   * different library has to be able to cut it short rather than serve it.
   */
  #wake: AbortController | undefined

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
    // An explicitly chosen library scores the stretch of work it was chosen
    // for, and ends with it.
    if (this.#openTurns.size === 0) this.#override = undefined
    this.#ensureRunning()
  }

  /**
   * What is playing, what the account has left, and why it is or is not playing.
   *
   * @returns the current track, the newest quota snapshot, and the health.
   */
  status(): AmbientStatus {
    return {
      library: this.#playing?.library ?? '',
      title: this.#playing?.title ?? '',
      quota: this.#quota,
      health: this.#health,
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
    this.#stopped = false
    this.#override = library
    // An explicit call is someone saying "try again", and it is the only
    // signal that carries that meaning.
    this.#health = { kind: 'ok' }
    this.#attempts = 0
    this.#wake?.abort()
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
    this.#stopped = true
    this.#override = undefined
    this.#track?.abort()
    this.#wake?.abort()
    await this.#loop
  }

  /** Stop playback and release whatever a prepared track reserved. */
  async dispose(): Promise<void> {
    this.#controller.abort()
    this.#track?.abort()
    await this.#loop?.catch(() => undefined)
    await this.#discardPrefetch()
  }

  /** The library that a seam reached right now would play; empty means silence. */
  #currentLibrary(): string {
    if (this.#stopped) return ''
    if (this.#override !== undefined) return this.#override
    const { working, idle } = this.#options.libraries()
    return this.#openTurns.size > 0 ? working : idle
  }

  #ensureRunning(): void {
    if (this.#loop !== undefined || this.#controller.signal.aborted) return
    if (this.#currentLibrary() === '') return
    if (!this.#mayRun()) return
    this.#loop = this.#run().finally(() => {
      this.#loop = undefined
    })
  }

  /**
   * Whether a paused soundtrack is allowed to try again, clearing the pause
   * when it is.
   *
   * @returns whether the loop may start.
   */
  #mayRun(): boolean {
    const health = this.#health
    if (health.kind !== 'paused') return true
    // An undated pause waits for a human; a dated one waits for the clock.
    if (health.untilUnix === 0 || this.#options.clock.now() < health.untilUnix) return false
    this.#health = { kind: 'ok' }
    this.#attempts = 0
    return true
  }

  async #run(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const library = this.#currentLibrary()
      if (library === '') return
      let taken: Taken
      try {
        taken = await this.#take(library)
      } catch (error) {
        if (await this.#afterFetchFailure(error)) continue
        return
      }
      this.#afterFetchSuccess()
      if (this.#controller.signal.aborted) {
        await taken.prepared.dispose().catch(() => undefined)
        return
      }
      // A fetch covers a network call and, on a file-only player, a whole
      // download. A stop or a library change arriving inside that window has no
      // track to interrupt, so answering it by playing the track anyway would
      // make the answer arrive three minutes late.
      if (this.#currentLibrary() !== library) {
        await taken.prepared.dispose().catch(() => undefined)
        continue
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
        this.#pause('player', error)
        return
      } finally {
        this.#track = undefined
        this.#playing = undefined
        await taken.prepared.dispose().catch(() => undefined)
      }
    }
  }

  /**
   * Fold one fetch failure into the health, waiting out a backoff when the
   * failure is worth retrying.
   *
   * @param error - what the fetch threw.
   * @returns whether the loop should try again.
   */
  async #afterFetchFailure(error: unknown): Promise<boolean> {
    if (this.#controller.signal.aborted) return false
    const kind = error instanceof AudiolibError ? error.kind : 'transient'
    const message = error instanceof Error ? error.message : String(error)
    // The 402 carries the snapshot that dates the pause, and it is also the
    // truest one there is: keeping it is what stops `music_status` reporting a
    // healthy quota beside a quota pause, at the one moment the field matters.
    if (error instanceof AudiolibError) this.#noteQuota(error.quota)
    this.#attempts += 1
    const wasRetrying = this.#health.kind === 'retrying'
    const health = healthFromError(kind, message, this.#attempts, this.#quota)
    this.#health = health
    if (health.kind !== 'retrying') {
      this.#options.logger.warn('audiolib: paused — %s', message)
      return false
    }
    // One warning for the whole outage. Warning per attempt floods exactly the
    // log a reader would be searching to understand the outage.
    if (!wasRetrying) this.#options.logger.warn('audiolib: request failed, retrying — %s', message)
    const wake = new AbortController()
    this.#wake = wake
    try {
      await this.#options.clock.sleep(
        backoffMs(this.#attempts), AbortSignal.any([this.#controller.signal, wake.signal]))
    } finally {
      this.#wake = undefined
    }
    // Woken early still means "go round again": the next pass re-reads the
    // library, which is what turns a stop into silence and a request into music.
    return !this.#controller.signal.aborted
  }

  /** Clear a retry streak, saying so once when there was one. */
  #afterFetchSuccess(): void {
    if (this.#health.kind === 'retrying') {
      this.#options.logger.info('audiolib: recovered after %d attempts', this.#attempts)
    }
    this.#health = { kind: 'ok' }
    this.#attempts = 0
  }

  /**
   * Stop for a reason no retry can fix.
   *
   * @param reason - which part of the setup has to change.
   * @param error - what failed.
   */
  #pause(reason: 'player', error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#health = { kind: 'paused', reason, message, untilUnix: 0 }
    this.#options.logger.warn('audiolib: paused — %s', message)
  }

  /** Take the prefetched track when it matches `library`, else fetch a fresh one. */
  async #take(library: string): Promise<Taken> {
    const prefetch = this.#prefetch
    this.#prefetch = undefined
    if (prefetch?.library === library) return prefetch.work
    if (prefetch !== undefined) void disposeQuietly(prefetch, this.#options.logger)
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
    if (existing !== undefined) void disposeQuietly(existing, this.#options.logger)
    const work = this.#prepare(library)
    // A prefetch nobody ends up awaiting must not crash the process; the taker
    // still sees the rejection through its own reference to the same promise.
    void work.catch(() => undefined)
    this.#prefetch = { library, work }
  }

  async #prepare(library: string): Promise<Taken> {
    const signal = this.#controller.signal
    const track = await this.#options.source.fetch(library, signal)
    this.#noteQuota(track.quota)
    const prepared = await this.#options.playback.prepare(track, signal)
    return { track, prepared }
  }

  /**
   * Record the newest quota, saying once when the period is nearly spent. The
   * wall should arrive announced rather than as a sudden silence.
   *
   * @param quota - the snapshot the response carried, when it carried one.
   */
  #noteQuota(quota: Quota | undefined): void {
    if (quota === undefined) return
    this.#quota = quota
    if (quota.unlimited || quota.total <= 0) return
    const low = quota.remaining <= quota.total * LOW_QUOTA_FRACTION
    if (low && !this.#warnedLowQuota) {
      this.#warnedLowQuota = true
      this.#options.logger.warn('audiolib: %d of %d calls left this period',
        quota.remaining, quota.total)
    }
    // Climbing back above the line means the period rolled over; arm the
    // warning again for the next one.
    if (!low) this.#warnedLowQuota = false
  }

  async #discardPrefetch(): Promise<void> {
    const prefetch = this.#prefetch
    this.#prefetch = undefined
    if (prefetch !== undefined) await disposeQuietly(prefetch, this.#options.logger)
  }
}

/**
 * Release a prepared track that will never be played, naming its failure when
 * it had one. Nobody else ever looks at a discarded prefetch's rejection, and
 * silence is this plugin's normal state — dropped, the failure would be
 * indistinguishable from working correctly.
 *
 * @param prefetch - the prefetch whose result is no longer wanted.
 * @param logger - where a failure gets named.
 */
async function disposeQuietly(prefetch: Prefetch, logger: AmbientLogger): Promise<void> {
  let taken: Taken
  try {
    taken = await prefetch.work
  } catch (error) {
    logger.warn('audiolib: could not prepare %s', prefetch.library)
    logger.warn(error)
    return
  }
  await taken.prepared.dispose().catch(() => undefined)
}
