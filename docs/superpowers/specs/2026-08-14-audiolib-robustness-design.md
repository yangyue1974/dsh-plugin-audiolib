# Robustness and a test net for dsh-plugin-audiolib

Target version: 0.2.0

## Why

0.1.0 shipped the experience but not the guarantees behind it. Three things are
wrong, and one of them is invisible to the user it hurts:

- **A single failed request silences the soundtrack permanently.** `#run()`
  returns on any error, and the loop only restarts when a turn opens. With an
  idle library configured, one network hiccup means the music never comes back
  and nothing on screen says why.
- **`music_play` disables the ambient mapping forever.** `#override` is never
  cleared, so after one explicit library choice the working/idle mapping is
  dead — contradicting the documented behaviour that the room goes quiet when
  the agent stops.
- **Nothing is tested.** There is no test script and no test file. The seam,
  prefetch, and cancellation logic in `ambient.ts` — five mutable fields and
  three overlapping lifetimes — has no regression net at all.

The fix for the first two is a state machine; the fix for the third is a
dependency structure that admits fakes. They are one change, because the state
machine is only worth writing if a test can pin it down.

## Health

`AmbientSoundtrack` gains a `Health` value: the single authority on why no music
is playing.

```ts
export type Health =
  | { kind: 'ok' }
  | { kind: 'retrying'; attempts: number; message: string }
  | {
      kind: 'paused'
      reason: 'auth' | 'quota' | 'player' | 'config'
      message: string
      /** Unix seconds after which a retry is allowed; 0 means never on its own. */
      untilUnix: number
    }
```

Classification lives in `audiolib.ts`, the only module that sees the HTTP status.
`requestTrack` throws `AudiolibError` carrying a `kind`:

| Condition | `kind` | Loop response |
| --- | --- | --- |
| Network failure, 5xx, timeout | `transient` | Back off and retry |
| 429 with quota left, or no quota reported | `transient` | Back off and retry |
| 401, 403 | `auth` | `paused{auth}` |
| 402, or 429 whose quota reports `remaining === 0` | `quota` | `paused{quota, untilUnix: quota.periodEnd}` |
| Malformed body, no track URL | `config` | `paused{config}` |

A 429 is ambiguous on its own: it covers both the per-minute rate limit, which
clears in seconds, and an exhausted period, which does not. The quota snapshot
in the same response settles it, and when the response carries none the plugin
assumes the recoverable reading and retries. When `quota.periodEnd` is missing —
it reads as `0` — `untilUnix` stays `0` and the pause is sticky, because a
rollover the plugin cannot date is one it must not guess at.

Playback failure — the player binary missing, or exiting non-zero on its own —
becomes `paused{player}`. An aborted player is not a failure and never was.

**Backoff:** 1s, 2s, 4s, 8s, 16s, 30s, then 30s forever. There is deliberately no
attempt ceiling. Background music should resume by itself after a two-hour
outage, and one probe every thirty seconds costs nothing worth counting.
`attempts` resets to zero on the first success.

**Leaving `paused`:** three ways, and only three.

- `music_play` clears any paused state. An explicit call is a human or a model
  saying "try again", and it is the only signal that carries that meaning.
- `paused{quota}` allows a retry once `untilUnix` has passed. The API already
  tells us when the period rolls over, so the plugin does not have to guess.
- `auth`, `player`, and `config` are sticky until reload. All three require
  someone to change something outside the process; retrying on a timer would
  only produce noise.

**Logging:** one warning on entering `retrying`, one info line on leaving it
(`recovered after N attempts`), and nothing in between. The present code warns
once per failed track, which floods the log during exactly the outage a reader
would be trying to understand.

## Override lifetime

`#override` splits in two, because stopping and switching are different things
and packing them into one field is what produced the bug:

```ts
#override: string | undefined  // set by music_play, cleared when the last turn closes
#stopped = false               // set by music_stop, cleared only by music_play
```

`#currentLibrary()` reads: `stopped` means silence; otherwise `override`, else
the activity mapping.

A consequence worth stating plainly: ask for jazz while the agent is idle, then
run a turn, and the override clears when that turn closes. That follows from the
rule — an explicitly chosen library scores the stretch of work it was chosen
for, and ends with it.

## Ports

`ambient.ts` becomes a state machine that imports no Node module. Three ports in
a new `src/ports.ts`:

```ts
export interface TrackSource {
  fetch(library: string, signal: AbortSignal): Promise<Track>
}

/** A track ready to play. Opaque to the soundtrack, which only ever disposes it. */
export interface PreparedTrack {
  dispose(): Promise<void>
}

export interface Playback {
  /** No-op for a streaming player; a download for a file-only one. */
  prepare(track: Track, signal: AbortSignal): Promise<PreparedTrack>
  play(prepared: PreparedTrack, signal: AbortSignal): Promise<void>
}

export interface Clock {
  sleep(ms: number, signal: AbortSignal): Promise<void>
}
```

`Prepared`, `LocalTrack`, and `isStreaming` retreat into `player.ts`. After this
the soundtrack does not know that files exist — it holds an opaque handle, plays
it, and disposes it.

Backoff sleeps through the injected `Clock`, so a test that asserts the delay
sequence records six numbers and waits for none of them.

A new `src/health.ts` (~70 lines) holds the `Health` type, `backoffMs(attempts)`,
and `healthFrom(error, quota)` — pure functions, tested directly. Keeping them
out of `ambient.ts` holds that file near its present 300 lines instead of pushing
it past 400.

Wiring lives in `apply()` in `index.ts`, roughly twenty lines.

## Tests

`node:test` with `node:assert/strict`. No new dependency.

Tests live in `test/*.test.ts` and compile through `tsconfig.test.json` into a
gitignored `.test-build/`. They cannot run as TypeScript directly: type stripping
does not rewrite a `./x.js` specifier to `./x.ts`, and this codebase uses NodeNext
specifiers throughout. `npm test` compiles, then runs `node --test`.

Behaviour to pin down:

- **The seam.** Activity changing mid-track does not interrupt it; the new
  library takes effect on the next track.
- **Prefetch discipline.** A prefetch for a library the seam no longer wants is
  discarded, its handle disposed, and a fresh track fetched.
- **The silence bug.** One transient failure, and the music resumes by itself.
- **Backoff.** The recorded sleep sequence is 1s, 2s, 4s, 8s, 16s, 30s, 30s.
- **Auth.** No retry; straight to `paused{auth}`; `music_play` clears it.
- **Quota.** `paused{quota}` becomes retryable once `untilUnix` has passed.
- **Concurrent turns.** Two sessions open; idle is reached only when both close.
- **Stop.** Interrupts immediately, and a turn closing afterwards does not
  quietly undo it.
- **Override lifetime.** Cleared by the turn close that empties the set, not by
  one that leaves another turn open.
- **Dispose races.** An in-flight prefetch is released; no temporary directory
  outlives the plugin.
- **Classification.** Every row of the `AudiolibError` table, driven by an
  injected fetch.

## Incidental fixes

Same change, because each is small and each is a robustness hole:

- **Windows player detection.** `player.ts` probes with `which`, which does not
  exist on win32, so `mpv` is never found there. Use `where` on win32.
- **Quota warning.** One warning when remaining drops below 10% of total, so the
  wall arrives announced rather than as a sudden silence.
- **`music_status`.** Two new fields, `health` and `healthReason`, so the model
  can answer "why is there no music" from the tool rather than from a guess.
- **CI.** `.github/workflows/ci.yml` running typecheck, test, and build on
  Node 22 and 24.

The browser card cannot show any of this. It reaches the host through the
settings scope and the credentials domain only, and third-party settings
namespaces are still off the `dsh-host-apiproxy` allowlist — the same upstream
limitation 0.1.0 documented. Health surfaces through `music_status` and the log
until that lifts.

## Version

0.2.0. The override lifetime is a behaviour change, so this is not a patch.
`CHANGELOG.md` follows the existing prose style.
