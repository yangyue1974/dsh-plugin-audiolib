/**
 * Local playback: download a track to a temporary file, then hand that file to
 * an external player process. Downloading first keeps playback independent of
 * the player's network support and lets the next track be fetched while the
 * current one plays.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'

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

/**
 * Pick the player to use when `playerCommand` is left empty.
 *
 * A streaming player wins whenever one is installed, because streaming is what
 * the audio URL is for: playback starts on the first buffered bytes instead of
 * after several megabytes. `afplay` ships with macOS but only reads local
 * files, so it is the fallback that keeps the plugin working with no install.
 *
 * @param platform - the running platform, as `process.platform` reports it.
 * @returns argv whose `{url}` or `{file}` token declares its playback mode.
 */
export function defaultPlayerCommand(platform: NodeJS.Platform): string[] {
  for (const candidate of STREAMING_PLAYERS) {
    const [binary] = candidate
    if (binary !== undefined && spawnSync('which', [binary], { stdio: 'ignore' }).status === 0) {
      return [...candidate]
    }
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
  const argv = command.map(argument => argument
    .replaceAll(URL_PLACEHOLDER, source)
    .replaceAll(FILE_PLACEHOLDER, source))
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
