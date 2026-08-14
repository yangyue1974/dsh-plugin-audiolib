/**
 * dsh-plugin-audiolib — an ambient soundtrack for DeepSeek Harness.
 *
 * The agent's own session events are the state signal: a turn opens, work is
 * happening; every turn closes, the room goes quiet. AudioLib supplies the
 * music, one API call per track.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// The root module carries the `ctx.credentials` declaration merge; `/types` carries the ref brand.
import type {} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
// Carries the `ctx.settings` declaration merge and the namespace brand.
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AmbientSoundtrack } from './ambient.js'
import { requestTrack } from './audiolib.js'
import { systemClock } from './clock.js'
import { LIBRARIES } from './libraries.js'
import { createPlayback, defaultPlayerCommand } from './player.js'

export const name = 'audiolib'

/**
 * Settings namespace the browser card binds. Spelled here and again in the
 * client half: a browser bundle must not import a host package.
 */
export const SETTINGS_NAMESPACE = 'audiolib' as SettingsNamespace

/**
 * Only `tools` is declared: Cordis `inject` has no optional tier, and requiring
 * `credentials` would keep the plugin from activating in a composition that
 * mounts no provider. The key is read through an optional access instead, so
 * such a composition falls back to the process environment.
 */
export const inject = ['tools']

/** Plugin configuration; every deployment-varying value lives here. */
export interface Config {
  /**
   * Name of the credential holding the AudioLib key — a reference, never the
   * key itself, so this config stays safe to sync and to render in a UI.
   */
  apiKeyRef: string
  /** Audio endpoint URL. */
  baseUrl: string
  /** Whether session events drive the soundtrack. */
  ambient: boolean
  /** Library played while a turn is open; empty means silence while working. */
  workingLibrary: string
  /** Library played once every turn has closed; empty means silence when idle. */
  idleLibrary: string
  /** Whether the model can pick the library itself. */
  exposeTools: boolean
  /** Player argv containing `{file}`; empty selects the platform default. */
  playerCommand: string[]
  /** Per-request deadline for the AudioLib API in milliseconds. */
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  apiKeyRef: Schema.string().default('AUDIOLIB_API_KEY'),
  baseUrl: Schema.string().default('https://api.audiolib.ai/v1/audio'),
  ambient: Schema.boolean().default(true),
  workingLibrary: Schema.string().default('audio.focus'),
  idleLibrary: Schema.string().default(''),
  exposeTools: Schema.boolean().default(true),
  playerCommand: Schema.array(Schema.string()).default([]),
  requestTimeoutMs: Schema.number().default(15_000),
})

/**
 * Mount the soundtrack.
 *
 * @param ctx - the plugin context; every registration is disposed with it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyRef)) {
    throw new Error(`audiolib: \`apiKeyRef\` must be a shell-style identifier, got "${config.apiKeyRef}"`)
  }
  /**
   * The authoritative configuration. It starts as the composition entry and
   * points at the settings section while one is registered, so a change made
   * in the browser card reaches the next seam without a restart. Falling back
   * on detach keeps the plugin working exactly as composed.
   */
  let current = (): Config => config
  ctx.inject(['settings'], sctx => {
    const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
    current = () => scope.get()
    sctx.effect(() => () => { current = () => config }, 'audiolib: settings detach')
  })

  /** The credential reference in force right now. */
  const keyRef = (): CredentialRef => current().apiKeyRef as CredentialRef

  /**
   * Read the credentials service without requiring it: a plain `ctx.credentials`
   * access THROWS when the service is not in `inject`, and requiring it would
   * keep the plugin from activating — which fails the whole harness boot — in a
   * composition that mounts no provider.
   *
   * @returns the provider, or `undefined` when this composition has none.
   */
  const credentials = (): Context['credentials'] | undefined =>
    ctx.reflect.get('credentials', false) as Context['credentials'] | undefined

  /**
   * Resolve the key for one call. The credentials provider layers the process
   * environment over its managed store, so a plain `AUDIOLIB_API_KEY=…` still
   * works and a key pasted into the store takes effect on the next track.
   */
  const resolveKey = async (): Promise<string> => {
    const ref = keyRef()
    const stored = await credentials()?.resolve(ref)
    const key = stored?.value ?? process.env[ref] ?? ''
    if (key === '') {
      throw new Error(`audiolib: no key behind "${ref}" — paste one into Settings → Plugins → AudioLib`)
    }
    return key
  }

  const playerCommand = config.playerCommand.length > 0
    ? config.playerCommand
    : defaultPlayerCommand(process.platform)
  const endpoint = { baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs }
  const soundtrack = new AmbientSoundtrack({
    source: {
      async fetch(library, signal) {
        return requestTrack(endpoint, await resolveKey(), library, signal)
      },
    },
    playback: createPlayback(playerCommand),
    clock: systemClock,
    libraries: () => ({ working: current().workingLibrary, idle: current().idleLibrary }),
    logger: ctx.logger,
  })
  ctx.effect(() => () => void soundtrack.dispose())

  // One loud line at load when nothing is configured yet, instead of a silent
  // soundtrack whose cause only shows up in a per-track warning.
  void (async () => {
    const ref = keyRef()
    const configured = (await credentials()?.describe(ref))?.configured ?? process.env[ref] !== undefined
    if (!configured) {
      ctx.logger.warn('audiolib: no key behind "%s" — the soundtrack stays silent until one is configured', ref)
    }
  })().catch(() => undefined)

  if (config.ambient) {
    soundtrack.warmUp()
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') soundtrack.turnOpened(session.id)
      else if (event.type === 'turn/end') soundtrack.turnClosed(session.id)
    })
  }

  if (config.exposeTools) {
    ctx.tools.register(playTool(soundtrack))
    ctx.tools.register(stopTool(soundtrack))
    ctx.tools.register(statusTool(soundtrack))
  }
}

/**
 * Read the `library` argument of a raw JSON-Schema tool call.
 *
 * Raw registrations validate their own input: the typed `defineTool` helper is
 * a same-process convenience this plugin deliberately avoids depending on.
 *
 * @param args - unvalidated model arguments.
 * @returns the requested library id.
 * @throws when the argument is missing or empty.
 */
function readLibrary(args: unknown): string {
  const library = (args as { library?: unknown }).library
  if (typeof library !== 'string' || library.trim() === '') {
    throw new Error('music_play: `library` must be a non-empty AudioLib library id, for example "audio.focus"')
  }
  return library.trim()
}

/**
 * Build the tool that lets the model choose the room's music.
 *
 * @param soundtrack - the mounted soundtrack.
 * @returns the tool definition to register.
 */
function playTool(soundtrack: AmbientSoundtrack): ToolDefinition {
  return {
    name: 'music_play',
    description: [
      'Choose the background music playing for the user, from the AudioLib catalog.',
      `Libraries: ${LIBRARIES.join(', ')}.`,
      'The change lands when the current track ends — a playing track is never cut off.',
      'Use it to match the mood of the work; call music_stop for silence.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        library: { type: 'string', description: 'AudioLib library id, for example "audio.focus".' },
      },
      required: ['library'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          library: { type: 'string' },
          startsAt: { type: 'string', enum: ['now', 'next-track'] },
        },
        required: ['library', 'startsAt'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const { library, startsAt } = value as { library: string; startsAt: string }
        return [{
          type: 'text',
          text: startsAt === 'now'
            ? `Playing ${library}.`
            : `Queued ${library}; it starts when the current track ends.`,
        }]
      },
    },
    presentCall: args => ({ card: 'generic', title: `♪ ${(args as { library?: unknown }).library ?? ''}` }),
    async execute(args) {
      const library = readLibrary(args)
      return { library, startsAt: soundtrack.request(library) }
    },
  }
}

/**
 * Build the tool that silences the room.
 *
 * @param soundtrack - the mounted soundtrack.
 * @returns the tool definition to register.
 */
function stopTool(soundtrack: AmbientSoundtrack): ToolDefinition {
  return {
    name: 'music_stop',
    description: 'Stop the background music immediately and stay silent until music_play is called again.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    presentCall: () => ({ card: 'generic', title: '♪ stop' }),
    async execute() {
      await soundtrack.stop()
      return 'Music stopped.'
    },
  }
}

/**
 * Build the tool that reports what is playing and what the AudioLib account has
 * left. Every audio call returns a quota snapshot, so the account's own numbers
 * are already in hand — the model can answer "how much do I have left" without
 * spending a call.
 *
 * @param soundtrack - the mounted soundtrack.
 * @returns the tool definition to register.
 */
function statusTool(soundtrack: AmbientSoundtrack): ToolDefinition {
  return {
    name: 'music_status',
    description: 'Report the track playing now and the AudioLib plan, remaining calls, and rate limit. Costs no API call.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          library: { type: 'string' },
          title: { type: 'string' },
          plan: { type: 'string' },
          remaining: { type: 'number' },
          total: { type: 'number' },
          used: { type: 'number' },
          unlimited: { type: 'boolean' },
          ratePerMinute: { type: 'number' },
          periodEndUnix: { type: 'number' },
        },
        required: ['library', 'title', 'plan', 'remaining', 'total', 'used', 'unlimited', 'ratePerMinute', 'periodEndUnix'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const status = value as {
          library: string; title: string; plan: string
          remaining: number; total: number; unlimited: boolean
        }
        const playing = status.library === '' ? 'Nothing playing.' : `Playing ${status.title} (${status.library}).`
        const quota = status.plan === ''
          ? 'No AudioLib call has been made yet, so no quota is known.'
          : status.unlimited
            ? `Plan ${status.plan}, unlimited calls.`
            : `Plan ${status.plan}, ${status.remaining} of ${status.total} calls left this period.`
        return [{ type: 'text', text: `${playing} ${quota}` }]
      },
    },
    presentCall: () => ({ card: 'generic', title: '♪ status' }),
    async execute() {
      const { library, title, quota } = soundtrack.status()
      return {
        library,
        title,
        plan: quota?.planName ?? '',
        remaining: quota?.remaining ?? 0,
        total: quota?.total ?? 0,
        used: quota?.used ?? 0,
        unlimited: quota?.unlimited ?? false,
        ratePerMinute: quota?.ratePerMinute ?? 0,
        periodEndUnix: quota?.periodEnd ?? 0,
      }
    },
  }
}
