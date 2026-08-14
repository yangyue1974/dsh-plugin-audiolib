/**
 * dsh-plugin-audiolib — an ambient soundtrack for DeepSeek Harness.
 *
 * The agent's own session events are the state signal: a turn opens, work is
 * happening; every turn closes, the room goes quiet. AudioLib supplies the
 * music, one API call per track.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AmbientSoundtrack } from './ambient.js'
import { defaultPlayerCommand } from './player.js'

export const name = 'audiolib'
export const inject = ['tools']

/** Plugin configuration; every deployment-varying value lives here. */
export interface Config {
  /** AudioLib API key; falls back to `AUDIOLIB_API_KEY` in the environment. */
  apiKey: string
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
  apiKey: Schema.string().default(''),
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
  const apiKey = config.apiKey || process.env['AUDIOLIB_API_KEY'] || ''
  if (apiKey === '') {
    throw new Error('audiolib: set `apiKey` in cordis.yml or AUDIOLIB_API_KEY in the environment')
  }

  const soundtrack = new AmbientSoundtrack({
    endpoint: { apiKey, baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs },
    playerCommand: config.playerCommand.length > 0 ? config.playerCommand : defaultPlayerCommand(process.platform),
    workingLibrary: config.workingLibrary,
    idleLibrary: config.idleLibrary,
    logger: ctx.logger,
  })
  ctx.effect(() => () => void soundtrack.dispose())

  if (config.ambient) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') soundtrack.turnOpened(session.id)
      else if (event.type === 'turn/end') soundtrack.turnClosed(session.id)
    })
  }

  if (config.exposeTools) {
    ctx.tools.register(playTool(soundtrack))
    ctx.tools.register(stopTool(soundtrack))
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
      'Libraries are ids such as "audio.focus", "audio.ambient", "audio.cinematic", "audio.jazz", "audio.sleep".',
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
