/**
 * Local playback: detect an installed player, decide between streaming a URL
 * and downloading to a temporary file, and run the external player process
 * either way. The stream-or-download decision is made once, in
 * {@link createPlayback}, so the rest of the plugin never has to know which
 * mode it is in.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import type { Track } from './audiolib.js'
import type { Playback, PreparedTrack } from './ports.js'

/** Argv token replaced with the downloaded track path before spawning the player. */
export const FILE_PLACEHOLDER = '{file}'

/**
 * Argv token replaced with the remote track URL. Its presence is how a player
 * declares that it streams: the plugin then skips downloading entirely and the
 * player buffers as it plays.
 */
export const URL_PLACEHOLDER = '{url}'

/** Streaming players, in preference order, with the argv each one needs. */
const STREAMING_PLAYERS: readonly (readonly string[])[] = [
  ['mpv', '--no-video', '--really-quiet', URL_PLACEHOLDER],
  ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', URL_PLACEHOLDER],
]

/** Whether `command` streams from the network instead of playing a local file. */
export function isStreaming(command: readonly string[]): boolean {
  return command.some(argument => argument.includes(URL_PLACEHOLDER))
}

/** Whether a binary is on PATH. Injected so detection can be tested. */
export type Probe = (binary: string) => boolean

/**
 * The command that answers whether a binary is on PATH.
 *
 * @param platform - the running platform, as `process.platform` reports it.
 * @returns `where` on Windows, `which` everywhere else.
 */
export function pathLocator(platform: NodeJS.Platform): 'where' | 'which' {
  return platform === 'win32' ? 'where' : 'which'
}

/**
 * The platform's way of asking whether a binary is on PATH.
 *
 * Windows has no `which`; `where` is its equivalent, and probing with the
 * wrong one finds nothing while looking exactly like "not installed" — which
 * is how every Windows user silently lost streaming playback.
 *
 * @param platform - the running platform, as `process.platform` reports it.
 * @returns a probe bound to that platform's locator.
 */
export function probeOnPath(platform: NodeJS.Platform): Probe {
  const locator = pathLocator(platform)
  return binary => spawnSync(locator, [binary], { stdio: 'ignore' }).status === 0
}

/**
 * Pick the player to use when `playerCommand` is left empty.
 *
 * A streaming player wins whenever one is installed, because streaming is what
 * the audio URL is for: playback starts on the first buffered bytes instead of
 * after several megabytes. `afplay` ships with macOS but only reads local
 * files, so it is the fallback that keeps the plugin working with no install.
 *
 * @param platform - the running platform, as `process.platform` reports it.
 * @param probe - how to test for a binary; defaults to the platform's locator.
 * @returns argv whose `{url}` or `{file}` token declares its playback mode.
 */
export function defaultPlayerCommand(platform: NodeJS.Platform, probe: Probe = probeOnPath(platform)): string[] {
  for (const candidate of STREAMING_PLAYERS) {
    const [binary] = candidate
    if (binary !== undefined && probe(binary)) return [...candidate]
  }
  if (platform === 'darwin') return ['afplay', FILE_PLACEHOLDER]
  return ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', URL_PLACEHOLDER]
}

/** A track on local disk. `dispose()` removes it and its temporary directory. */
export interface LocalTrack {
  readonly file: string
  dispose(): Promise<void>
}

/**
 * Download `url` into a private temporary directory.
 *
 * @param url - the media URL returned by AudioLib.
 * @param signal - cancellation; an aborted download removes its partial file.
 * @returns the local file plus its disposer.
 * @throws when the media request fails or the transfer aborts.
 */
export async function download(url: string, signal: AbortSignal): Promise<LocalTrack> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`audiolib: track download failed (HTTP ${response.status})`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-audiolib-'))
  const file = join(directory, `track${extname(new URL(url).pathname) || '.mp3'}`)
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(file), { signal })
  } catch (error) {
    await dispose()
    throw error
  }
  return { file, dispose }
}

/**
 * Substitute the source into a player's argv.
 *
 * Both placeholders are replaced with the same value: which one a command
 * carries decides whether that value is a URL or a path, and by the time argv
 * is built the decision is already made.
 *
 * @param command - player argv containing {@link URL_PLACEHOLDER} or {@link FILE_PLACEHOLDER}.
 * @param source - the URL or file path to play.
 * @returns the argv to spawn.
 */
export function playerArgv(command: readonly string[], source: string): string[] {
  return command.map(argument => argument
    .replaceAll(URL_PLACEHOLDER, source)
    .replaceAll(FILE_PLACEHOLDER, source))
}

/**
 * Play one track to completion with an external player.
 *
 * Aborting `signal` terminates the player and resolves: a stopped track is a
 * normal outcome, not a failure.
 *
 * @param source - the remote URL for a streaming player, or the downloaded file path.
 * @param command - player argv containing {@link URL_PLACEHOLDER} or {@link FILE_PLACEHOLDER}.
 * @param signal - cancellation that stops playback.
 * @throws when the player binary is missing or exits non-zero on its own.
 */
export async function play(source: string, command: readonly string[], signal: AbortSignal): Promise<void> {
  const argv = playerArgv(command, source)
  const [binary, ...rest] = argv
  if (binary === undefined) throw new Error('audiolib: `playerCommand` is empty')
  if (signal.aborted) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, rest, { stdio: 'ignore' })
    const stop = () => child.kill('SIGTERM')
    signal.addEventListener('abort', stop, { once: true })
    const settle = (finish: () => void) => {
      signal.removeEventListener('abort', stop)
      finish()
    }
    child.on('error', (error: NodeJS.ErrnoException) => settle(() => reject(error.code === 'ENOENT'
      ? new Error(`audiolib: player "${binary}" not found; install it or set \`playerCommand\` in cordis.yml`)
      : error)))
    child.on('close', (code, killedBy) => settle(() => {
      if (signal.aborted || killedBy !== null || code === 0 || code === null) resolve()
      else reject(new Error(`audiolib: player "${binary}" exited with code ${code}`))
    }))
  })
}

/** A prepared track, plus the source only this module knows how to play. */
interface PreparedSource extends PreparedTrack {
  readonly source: string
}

/**
 * Bind a player command into a {@link Playback}.
 *
 * The streaming decision lives here and nowhere else: a streaming command
 * prepares by doing nothing and plays the URL, a file-only one prepares by
 * downloading and plays the path. The soundtrack above never learns which.
 *
 * @param command - player argv containing `{url}` or `{file}`.
 * @returns the playback port.
 */
export function createPlayback(command: readonly string[]): Playback {
  const streaming = isStreaming(command)
  return {
    // No return-type annotation here: the object literal below needs its
    // contextual type to come from `Playback` alone, or TypeScript's excess
    // property check fires against `PreparedTrack` before `satisfies` below
    // gets a say.
    async prepare(track: Track, signal: AbortSignal) {
      if (streaming) {
        return { source: track.url, dispose: async () => undefined } satisfies PreparedSource
      }
      const local = await download(track.url, signal)
      return { source: local.file, dispose: local.dispose } satisfies PreparedSource
    },
    async play(prepared: PreparedTrack, signal: AbortSignal): Promise<void> {
      // The handle is opaque above this line, so the narrowing has to happen
      // here — and a handle from somewhere else is a bug worth naming.
      const source = (prepared as Partial<PreparedSource>).source
      if (source === undefined) {
        throw new Error('audiolib: playback received a track it did not prepare')
      }
      await play(source, command, signal)
    },
  }
}
