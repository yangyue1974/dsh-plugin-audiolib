# dsh-plugin-audiolib

English | [中文](README.zh.md)

An ambient soundtrack for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), driven by the agent's own state. Music comes from [AudioLib.ai](https://audiolib.ai) — 100,000+ fully-cleared tracks, one API call per track.

The agent already publishes everything needed as session events: a turn opens, work is happening; every turn closes, the room goes quiet. This plugin turns that stream into sound.

**A track is never interrupted by a state change.** Turns open and close far faster than a song lasts, so cutting mid-track reads as noise instead of feedback. The state you are in when a track ends decides what plays next. Only an explicit `music_stop` cuts playback, because silence requested is silence owed.

## Install

```sh
dsh plugin --profile web add dsh-plugin-audiolib
```

Then put your AudioLib key in the environment (or in `apiKey`, below) and restart:

```sh
export AUDIOLIB_API_KEY=alp_your_key
```

Get a key at [audiolib.ai](https://audiolib.ai) — the free tier is 300 requests/month.

Playback uses an external player: `afplay` on macOS (built in), `ffplay` elsewhere (`brew install ffmpeg` / `apt install ffmpeg`). Any other player works through `playerCommand`.

## Configure

Override the row in your profile's `cordis.patch.yml`:

```yaml
- id: audiolib
  name: dsh-plugin-audiolib
  config:
    workingLibrary: audio.focus
    idleLibrary: audio.ambient
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `''` | AudioLib key; falls back to `AUDIOLIB_API_KEY` |
| `baseUrl` | `https://api.audiolib.ai/v1/audio` | Audio endpoint |
| `ambient` | `true` | Let session events drive the soundtrack |
| `workingLibrary` | `audio.focus` | Plays while a turn is open; `''` for silence |
| `idleLibrary` | `''` | Plays once every turn has closed; `''` for silence |
| `exposeTools` | `true` | Give the model `music_play` / `music_stop` |
| `playerCommand` | `[]` | Player argv with a `{file}` token; empty picks the platform default |
| `requestTimeoutMs` | `15000` | AudioLib request deadline |

Known libraries include `audio.focus`, `audio.ambient`, `audio.cinematic`, `audio.jazz`, `audio.sleep`, `audio.electronic`, `audio.default`.

## Tools

- `music_play(library)` — the model scores its own work. Takes effect at the next seam; starts immediately when nothing is playing.
- `music_stop()` — stops now and stays silent until `music_play` is called again.

Both are ordinary registrations on `ctx.tools`, so they are available in Code Mode as `await tools.music_play({ library })` too.

## How it works

| Piece | Extension point |
|---|---|
| Activity tracking | `ctx.on('session/event')` — `turn/start` / `turn/end`, counted per session |
| Model control | `ctx.tools.register()` with raw JSON-Schema definitions |
| Teardown | `ctx.effect()` — unloading the plugin kills the player and removes every temporary file |

Each track is downloaded to a private temporary directory before playing, and the next one is fetched while the current plays, so the seam has no gap. AudioLib calls are cheap, so a prefetch discarded by a state change costs nothing worth optimizing.

## Develop

```sh
npm install
npm run build
```

Load a source checkout into a running harness without installing it:

```yaml
# audiolib.overlay.yml
- insert:
    - id: audiolib
      name: '/absolute/path/to/dsh-plugin-audiolib/lib/index.js'
      config:
        workingLibrary: audio.focus
```

```sh
dsh web --patch ./audiolib.overlay.yml
```

## License

MIT
