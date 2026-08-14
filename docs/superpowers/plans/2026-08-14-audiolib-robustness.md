# AudioLib Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `dsh-plugin-audiolib` a health state machine that survives failures, a correct `music_play` lifetime, and the first test suite the package has ever had.

**Architecture:** `ambient.ts` becomes a pure state machine driven through four injected ports (`TrackSource`, `Playback`, `Clock`, plus the existing `libraries()` thunk) and imports no Node module. Failure classification moves into `audiolib.ts`, the only module that sees an HTTP status; retry policy moves into a new pure `health.ts`. `index.ts` builds the real ports and wires them.

**Tech Stack:** TypeScript 5.9 (NodeNext), Node 22.19+, `node:test` + `node:assert/strict`, tsdown for the browser bundle. No new runtime or dev dependency.

## Global Constraints

- **Zero new dependencies.** Tests use `node:test` and `node:assert/strict`, both built in.
- **NodeNext specifiers.** Every relative import ends in `.js`, including from test files.
- **Doc comments on every exported symbol**, in the declarative "say why" voice the existing files use. `@param`/`@returns`/`@throws` on exported functions.
- **`strict`, `noUncheckedIndexedAccess`** are on. Index access yields `T | undefined`; handle it.
- **Never cache the API key.** `resolveKey()` is called per request and its result is never stored.
- **The browser card is out of scope.** Third-party settings namespaces are still off the `dsh-host-apiproxy` allowlist; health surfaces through `music_status` and the log only.
- **Backoff sequence is exactly** 1s, 2s, 4s, 8s, 16s, 30s, 30s, … with no attempt ceiling.
- **Low-quota warning threshold:** 10% of `total` remaining.
- **Target version:** 0.2.0.

---

### Task 1: Test harness and classified API errors

**Files:**
- Create: `tsconfig.test.json`
- Create: `test/audiolib.test.ts`
- Modify: `src/audiolib.ts` (add `AudiolibErrorKind`, `AudiolibError`, `classify`; rewrite `requestTrack`'s failure paths; add `fetch` to `Endpoint`)
- Modify: `package.json` (add `test` script)
- Modify: `.gitignore` (ignore `.test-build/`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AudiolibErrorKind = 'transient' | 'auth' | 'quota' | 'config'`
  - `class AudiolibError extends Error { readonly kind: AudiolibErrorKind; readonly quota: Quota | undefined }`
  - `interface Endpoint { readonly baseUrl: string; readonly timeoutMs: number; readonly fetch?: typeof globalThis.fetch }`
  - `requestTrack(endpoint, apiKey, library, signal): Promise<Track>` — unchanged signature, now throwing `AudiolibError`.

Tests compile rather than run as TypeScript directly: Node's type stripping does not rewrite a `./x.js` specifier to `./x.ts`, and this codebase uses NodeNext specifiers throughout.

- [ ] **Step 1: Create the test tsconfig**

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": ".test-build",
    "rootDir": ".",
    "declaration": false,
    "noEmit": false
  },
  "//": "Tests compile alongside src into a throwaway tree; node --test runs the emitted .js.",
  "include": ["src", "test"],
  "exclude": ["src/client"]
}
```

- [ ] **Step 2: Wire the test script and ignore the build tree**

In `package.json`, add to `scripts` (keep the existing entries):

```json
"test": "tsc -p tsconfig.test.json && node --test \".test-build/test/**/*.test.js\""
```

Append to `.gitignore`:

```
.test-build/
```

- [ ] **Step 3: Write the failing classification test**

Create `test/audiolib.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudiolibError, requestTrack, type Endpoint, type Quota } from '../src/audiolib.js'

/** A quota body as the API spells it, with `remaining_quota` overridable per case. */
function quotaBody(remaining: number, unlimited = false): Record<string, unknown> {
  return {
    plan_name: 'Starter',
    total_quota: 300,
    used_quota: 300 - remaining,
    remaining_quota: remaining,
    is_unlimited: unlimited,
    rate_per_minute: 10,
    period_end: 1_800_000_000,
  }
}

/**
 * An endpoint whose transport answers with one canned response.
 *
 * @param status - the HTTP status to answer with.
 * @param body - the JSON body to answer with.
 * @returns the endpoint to hand `requestTrack`.
 */
function endpointReturning(status: number, body: unknown): Endpoint {
  return {
    baseUrl: 'https://api.test/v1/audio',
    timeoutMs: 1_000,
    fetch: async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  }
}

/** Run one request and return the error it threw. */
async function failureOf(endpoint: Endpoint): Promise<AudiolibError> {
  const error = await requestTrack(endpoint, 'alp_test', 'audio.focus', new AbortController().signal)
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof AudiolibError, `expected an AudiolibError, got ${String(error)}`)
  return error
}

test('a 500 is transient', async () => {
  assert.equal((await failureOf(endpointReturning(500, { code: 5, msg: 'boom' }))).kind, 'transient')
})

test('a 401 is an auth failure', async () => {
  assert.equal((await failureOf(endpointReturning(401, { code: 1, msg: 'bad key' }))).kind, 'auth')
})

test('a 403 is an auth failure', async () => {
  assert.equal((await failureOf(endpointReturning(403, { code: 1, msg: 'forbidden' }))).kind, 'auth')
})

test('a 402 is a quota failure', async () => {
  assert.equal((await failureOf(endpointReturning(402, { code: 2, msg: 'payment required' }))).kind, 'quota')
})

test('a 429 with calls left is transient, because it is the per-minute limit', async () => {
  const endpoint = endpointReturning(429, { code: 3, msg: 'slow down', data: { quota: quotaBody(120) } })
  assert.equal((await failureOf(endpoint)).kind, 'transient')
})

test('a 429 reporting no calls left is a quota failure', async () => {
  const endpoint = endpointReturning(429, { code: 3, msg: 'exhausted', data: { quota: quotaBody(0) } })
  const error = await failureOf(endpoint)
  assert.equal(error.kind, 'quota')
  assert.equal(error.quota?.periodEnd, 1_800_000_000)
})

test('a 429 carrying no quota takes the recoverable reading', async () => {
  assert.equal((await failureOf(endpointReturning(429, { code: 3, msg: 'slow down' }))).kind, 'transient')
})

test('an unlimited plan is never a quota failure', async () => {
  const endpoint = endpointReturning(429, { code: 3, msg: 'slow down', data: { quota: quotaBody(0, true) } })
  assert.equal((await failureOf(endpoint)).kind, 'transient')
})

test('a 200 carrying no track URL is a config failure', async () => {
  assert.equal((await failureOf(endpointReturning(200, { code: 0, data: { title: 'x' } }))).kind, 'config')
})

test('a 200 with a non-zero code is a config failure', async () => {
  assert.equal((await failureOf(endpointReturning(200, { code: 7, msg: 'LIBRARY_NOT_FOUND' }))).kind, 'config')
})

test('a transport failure is transient', async () => {
  const endpoint: Endpoint = {
    baseUrl: 'https://api.test/v1/audio',
    timeoutMs: 1_000,
    fetch: async () => { throw new TypeError('fetch failed') },
  }
  assert.equal((await failureOf(endpoint)).kind, 'transient')
})

test('caller cancellation is rethrown rather than classified', async () => {
  const controller = new AbortController()
  controller.abort()
  const endpoint: Endpoint = {
    baseUrl: 'https://api.test/v1/audio',
    timeoutMs: 1_000,
    fetch: async () => { throw new DOMException('aborted', 'AbortError') },
  }
  const thrown = await requestTrack(endpoint, 'alp_test', 'audio.focus', controller.signal)
    .then(() => undefined, (error: unknown) => error)
  assert.ok(!(thrown instanceof AudiolibError))
})

test('a success returns the track and its quota', async () => {
  const endpoint = endpointReturning(200, {
    code: 0,
    data: {
      title: 'Blue Hour',
      url: 'https://cdn.test/blue-hour.mp3',
      duration_sec: 214,
      quota: quotaBody(299),
    },
  })
  const track = await requestTrack(endpoint, 'alp_test', 'audio.focus', new AbortController().signal)
  assert.equal(track.title, 'Blue Hour')
  assert.equal(track.url, 'https://cdn.test/blue-hour.mp3')
  assert.equal(track.durationSec, 214)
  const quota = track.quota as Quota
  assert.equal(quota.remaining, 299)
  assert.equal(quota.planName, 'Starter')
})
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npm test
```

Expected: compilation fails with `'"../src/audiolib.js"' has no exported member named 'AudiolibError'`.

- [ ] **Step 5: Add the error type and classification to `src/audiolib.ts`**

Add above `Track`, after the `Quota` interface:

```ts
/**
 * How a failed AudioLib call should be treated. The distinction is the whole
 * point: a `transient` failure is worth retrying forever and an `auth` one is
 * worth retrying never, and only the code holding the HTTP status can tell.
 */
export type AudiolibErrorKind = 'transient' | 'auth' | 'quota' | 'config'

/** A failed AudioLib call, classified for the caller's retry policy. */
export class AudiolibError extends Error {
  readonly kind: AudiolibErrorKind
  /** Quota reported alongside the failure; absent when the response carried none. */
  readonly quota: Quota | undefined

  /**
   * @param kind - the retry classification.
   * @param message - what to show a human.
   * @param quota - the quota snapshot in the failing response, when it had one.
   */
  constructor(kind: AudiolibErrorKind, message: string, quota?: Quota) {
    super(message)
    this.name = 'AudiolibError'
    this.kind = kind
    this.quota = quota
  }
}
```

Extend `Endpoint` with the transport seam:

```ts
/** Connection settings for one AudioLib deployment. The key is not one of them. */
export interface Endpoint {
  /** Full audio endpoint URL. */
  readonly baseUrl: string
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number
  /**
   * Transport, defaulting to the global `fetch`. Named here so a test can
   * answer the request without a socket, and so a deployment behind a proxy
   * can supply its own.
   */
  readonly fetch?: typeof globalThis.fetch
}
```

Add the classifier below `readQuota`:

```ts
/**
 * Classify a failed response.
 *
 * A 429 is ambiguous on its own: it covers the per-minute rate limit, which
 * clears in seconds, and an exhausted period, which does not. The quota in the
 * same response settles it, and a response carrying none gets the recoverable
 * reading — a retry costs a request, a wrong pause costs the whole feature.
 *
 * @param status - the HTTP status.
 * @param quota - the quota projected out of the same response.
 * @returns the retry classification.
 */
function classify(status: number, quota: Quota | undefined): AudiolibErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  const exhausted = quota !== undefined && !quota.unlimited && quota.remaining <= 0
  if (exhausted) return 'quota'
  if (status === 429 || status >= 500) return 'transient'
  return 'config'
}
```

- [ ] **Step 6: Rewrite `requestTrack`'s failure paths**

Replace the body of `requestTrack` with:

```ts
export async function requestTrack(endpoint: Endpoint, apiKey: string, library: string, signal: AbortSignal): Promise<Track> {
  const transport = endpoint.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await transport(endpoint.baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ library }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs)]),
    })
  } catch (error) {
    // The caller's own cancellation is not a failure to classify; the deadline
    // firing is, and both arrive here as an abort.
    if (signal.aborted) throw error
    throw new AudiolibError('transient', `audiolib: "${library}" request failed (${String(error)})`)
  }
  const body = await response.json().catch(() => undefined) as AudiolibBody | undefined
  const quota = readQuota(body?.data?.quota)
  const message = typeof body?.msg === 'string' ? `, ${body.msg}` : ''
  if (!response.ok || body?.code !== 0) {
    throw new AudiolibError(
      classify(response.status, quota),
      `audiolib: "${library}" request failed (HTTP ${response.status}${message})`,
      quota,
    )
  }
  const data = body.data
  if (typeof data?.url !== 'string' || data.url === '') {
    throw new AudiolibError('config', `audiolib: "${library}" response carried no track URL`, quota)
  }
  return {
    title: typeof data.title === 'string' ? data.title : library,
    url: data.url,
    durationSec: typeof data.duration_sec === 'number' ? data.duration_sec : 0,
    quota,
  }
}
```

Note the `classify` call receives `response.status`, so a 200-with-non-zero-code lands on the `return 'config'` line — which is what the test expects.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test
```

Expected: 13 passing tests, 0 failing.

- [ ] **Step 8: Verify the package still typechecks and builds**

```bash
npm run typecheck && npm run build
```

Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add tsconfig.test.json test/audiolib.test.ts src/audiolib.ts package.json .gitignore
git commit -m "classify API failures, and give the package a place to put tests

A 429 is the per-minute limit or an exhausted period, and only the quota
in the same response tells them apart. Everything downstream needs that
distinction to decide between retrying forever and not at all."
```

---

### Task 2: The retry policy

**Files:**
- Create: `src/health.ts`
- Create: `test/health.test.ts`

**Interfaces:**
- Consumes: `AudiolibErrorKind`, `Quota` from `src/audiolib.js` (Task 1).
- Produces:
  - `type PauseReason = 'auth' | 'quota' | 'player' | 'config'`
  - `type Health = { kind: 'ok' } | { kind: 'retrying'; attempts: number; message: string } | { kind: 'paused'; reason: PauseReason; message: string; untilUnix: number }`
  - `backoffMs(attempts: number): number`
  - `healthFromError(kind: AudiolibErrorKind, message: string, attempts: number, quota: Quota | undefined): Health`
  - `const MAX_BACKOFF_MS = 30_000`

- [ ] **Step 1: Write the failing test**

Create `test/health.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, healthFromError, MAX_BACKOFF_MS } from '../src/health.js'
import type { Quota } from '../src/audiolib.js'

/** A quota snapshot whose period ends at a known instant. */
const QUOTA: Quota = {
  planName: 'Starter',
  total: 300,
  used: 300,
  remaining: 0,
  unlimited: false,
  ratePerMinute: 10,
  periodEnd: 1_800_000_000,
}

test('backoff doubles from one second and caps at thirty', () => {
  const sequence = [1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)
  assert.deepEqual(sequence, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
})

test('backoff never overflows for an outage that lasts a week', () => {
  assert.equal(backoffMs(100_000), MAX_BACKOFF_MS)
})

test('a transient failure keeps retrying and carries the attempt count', () => {
  const health = healthFromError('transient', 'boom', 3, undefined)
  assert.equal(health.kind, 'retrying')
  assert.equal(health.kind === 'retrying' ? health.attempts : -1, 3)
})

test('an auth failure pauses with no expiry, because only a human can fix it', () => {
  const health = healthFromError('auth', 'bad key', 1, QUOTA)
  assert.deepEqual(health, { kind: 'paused', reason: 'auth', message: 'bad key', untilUnix: 0 })
})

test('a quota failure pauses until the period the API named', () => {
  const health = healthFromError('quota', 'exhausted', 1, QUOTA)
  assert.deepEqual(health, {
    kind: 'paused', reason: 'quota', message: 'exhausted', untilUnix: 1_800_000_000,
  })
})

test('a quota failure with no dated period stays paused, rather than guessing', () => {
  const health = healthFromError('quota', 'exhausted', 1, { ...QUOTA, periodEnd: 0 })
  assert.equal(health.kind === 'paused' ? health.untilUnix : -1, 0)
})

test('a quota failure with no quota at all stays paused', () => {
  const health = healthFromError('quota', 'exhausted', 1, undefined)
  assert.equal(health.kind === 'paused' ? health.untilUnix : -1, 0)
})

test('a config failure pauses with no expiry', () => {
  const health = healthFromError('config', 'no url', 1, undefined)
  assert.equal(health.kind === 'paused' ? health.reason : '', 'config')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: compilation fails with `Cannot find module '../src/health.js'`.

- [ ] **Step 3: Write `src/health.ts`**

```ts
/**
 * Why the soundtrack is or is not playing, and how long to wait before trying
 * again.
 *
 * Pure by design: no clock, no network, no state. The soundtrack owns the
 * decision of *when* to act; this module owns only what the decision is.
 */

import type { AudiolibErrorKind, Quota } from './audiolib.js'

/** Why a paused soundtrack stopped. */
export type PauseReason = 'auth' | 'quota' | 'player' | 'config'

/** The single authority on why no music is playing. */
export type Health =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'retrying'
      /** Consecutive failures so far, starting at 1. */
      readonly attempts: number
      /** The newest failure, in the words the API or the player used. */
      readonly message: string
    }
  | {
      readonly kind: 'paused'
      readonly reason: PauseReason
      readonly message: string
      /**
       * Unix seconds after which a retry is allowed. `0` means the pause never
       * lifts on its own — something outside the process has to change first.
       */
      readonly untilUnix: number
    }

/** The first delay; each further attempt doubles it. */
const BASE_BACKOFF_MS = 1_000

/**
 * The ceiling the delay grows to. There is deliberately no attempt ceiling to
 * go with it: background music should resume by itself after a two-hour
 * outage, and one probe every thirty seconds costs nothing worth counting.
 */
export const MAX_BACKOFF_MS = 30_000

/** Beyond this the doubling has long since hit the cap; stop shifting. */
const CAPPED_AT_ATTEMPT = 6

/**
 * How long to wait before the retry that follows `attempts` failures.
 *
 * @param attempts - consecutive failures so far, starting at 1.
 * @returns the delay in milliseconds: 1s, 2s, 4s, 8s, 16s, then 30s forever.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 1) return BASE_BACKOFF_MS
  if (attempts >= CAPPED_AT_ATTEMPT) return MAX_BACKOFF_MS
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)
}

/**
 * The health a failed request produces.
 *
 * @param kind - the classification the API client attached.
 * @param message - what to show a human.
 * @param attempts - consecutive failures so far including this one.
 * @param quota - the newest quota snapshot, which is what dates a quota pause.
 * @returns the health the soundtrack should adopt.
 */
export function healthFromError(
  kind: AudiolibErrorKind,
  message: string,
  attempts: number,
  quota: Quota | undefined,
): Health {
  switch (kind) {
    case 'transient':
      return { kind: 'retrying', attempts, message }
    case 'quota':
      // The API already says when the period rolls over, so the plugin does
      // not have to guess; an undated rollover is one it must not guess at.
      return { kind: 'paused', reason: 'quota', message, untilUnix: quota?.periodEnd ?? 0 }
    case 'auth':
      return { kind: 'paused', reason: 'auth', message, untilUnix: 0 }
    case 'config':
      return { kind: 'paused', reason: 'config', message, untilUnix: 0 }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```

Expected: 21 passing tests total, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/health.ts test/health.test.ts
git commit -m "add the retry policy as pure functions

Backoff caps at thirty seconds and never stops. A quota pause is dated
from the period end the API reports; every other pause waits for a human."
```

---

### Task 3: Ports, and a player half that can be tested

**Files:**
- Create: `src/ports.ts`
- Create: `test/player.test.ts`
- Modify: `src/player.ts` (add `Probe`/`probeOnPath`, `playerArgv`, `createPlayback`; make `defaultPlayerCommand` take a probe)

**Interfaces:**
- Consumes: `Track` from `src/audiolib.js`.
- Produces:
  - `interface TrackSource { fetch(library: string, signal: AbortSignal): Promise<Track> }`
  - `interface PreparedTrack { dispose(): Promise<void> }`
  - `interface Playback { prepare(track: Track, signal: AbortSignal): Promise<PreparedTrack>; play(prepared: PreparedTrack, signal: AbortSignal): Promise<void> }`
  - `interface Clock { sleep(ms: number, signal: AbortSignal): Promise<void>; now(): number }`
  - `type Probe = (binary: string) => boolean`
  - `probeOnPath(platform: NodeJS.Platform): Probe`
  - `defaultPlayerCommand(platform: NodeJS.Platform, probe?: Probe): string[]`
  - `playerArgv(command: readonly string[], source: string): string[]`
  - `createPlayback(command: readonly string[]): Playback`

- [ ] **Step 1: Write the failing test**

Create `test/player.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlayback, defaultPlayerCommand, pathLocator, playerArgv, probeOnPath } from '../src/player.js'
import type { Track } from '../src/audiolib.js'

/** A probe that answers yes for exactly the named binaries. */
function probeFor(...installed: string[]): (binary: string) => boolean {
  return binary => installed.includes(binary)
}

const TRACK: Track = {
  title: 'Blue Hour',
  url: 'https://cdn.test/blue-hour.mp3',
  durationSec: 214,
  quota: undefined,
}

test('mpv wins when it is installed', () => {
  assert.deepEqual(
    defaultPlayerCommand('darwin', probeFor('mpv', 'ffplay')),
    ['mpv', '--no-video', '--really-quiet', '{url}'],
  )
})

test('ffplay is the second choice', () => {
  assert.equal(defaultPlayerCommand('linux', probeFor('ffplay'))[0], 'ffplay')
})

test('macOS falls back to afplay, which reads files only', () => {
  const command = defaultPlayerCommand('darwin', probeFor())
  assert.deepEqual(command, ['afplay', '{file}'])
})

test('elsewhere the fallback still streams', () => {
  const command = defaultPlayerCommand('linux', probeFor())
  assert.ok(command.includes('{url}'))
})

test('win32 locates binaries with where; every other platform with which', () => {
  assert.equal(pathLocator('win32'), 'where')
  assert.equal(pathLocator('darwin'), 'which')
  assert.equal(pathLocator('linux'), 'which')
})

test('both streaming players are probed before the fallback', () => {
  const asked: string[] = []
  defaultPlayerCommand('win32', binary => { asked.push(binary); return false })
  assert.deepEqual(asked, ['mpv', 'ffplay'])
})

test('the real probe answers for a binary that certainly exists', () => {
  assert.equal(probeOnPath(process.platform)('node'), true)
})

test('both placeholders are substituted', () => {
  assert.deepEqual(
    playerArgv(['mpv', '--no-video', '{url}'], 'https://cdn.test/a.mp3'),
    ['mpv', '--no-video', 'https://cdn.test/a.mp3'],
  )
  assert.deepEqual(playerArgv(['afplay', '{file}'], '/tmp/a.mp3'), ['afplay', '/tmp/a.mp3'])
})

test('a streaming playback prepares without downloading', async () => {
  const playback = createPlayback(['mpv', '{url}'])
  const prepared = await playback.prepare(TRACK, new AbortController().signal)
  // A download would have needed the network; reaching here at all is the test.
  await prepared.dispose()
})

test('playback refuses a handle it did not prepare', async () => {
  const playback = createPlayback(['mpv', '{url}'])
  await assert.rejects(
    () => playback.play({ dispose: async () => undefined }, new AbortController().signal),
    /did not prepare/,
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: compilation fails on the missing `playerArgv`, `createPlayback`, and `probeOnPath` exports.

- [ ] **Step 3: Create `src/ports.ts`**

```ts
/**
 * The boundaries the soundtrack talks through.
 *
 * `ambient.ts` imports nothing else that touches the network, the filesystem,
 * or the clock. That is what lets a test drive the whole state machine —
 * including a retry sequence — without waiting for any of them.
 */

import type { Track } from './audiolib.js'

/** Where tracks come from. */
export interface TrackSource {
  /**
   * Request one track.
   *
   * @param library - AudioLib library id.
   * @param signal - cancellation.
   * @returns the selected track.
   * @throws AudiolibError classified for the retry policy.
   */
  fetch(library: string, signal: AbortSignal): Promise<Track>
}

/**
 * A track ready to play. Opaque to the soundtrack, which only ever hands it
 * back to the same {@link Playback} or disposes it.
 */
export interface PreparedTrack {
  /** Release whatever preparation reserved. Safe to call more than once. */
  dispose(): Promise<void>
}

/** How tracks reach the speakers. */
export interface Playback {
  /**
   * Get a track ready. Nothing for a streaming player; a download for a
   * file-only one — which is what keeps the prefetch worth doing on `afplay`.
   *
   * @param track - the track to prepare.
   * @param signal - cancellation; an aborted preparation releases what it took.
   * @returns the handle to play or dispose.
   */
  prepare(track: Track, signal: AbortSignal): Promise<PreparedTrack>
  /**
   * Play to completion.
   *
   * @param prepared - a handle from this same playback's `prepare`.
   * @param signal - cancellation; an aborted signal resolves rather than throws,
   * because a stopped track is a normal outcome.
   * @throws when the player is missing or exits non-zero on its own.
   */
  play(prepared: PreparedTrack, signal: AbortSignal): Promise<void>
}

/** Time, injected so a backoff test waits for none of it. */
export interface Clock {
  /**
   * Wait.
   *
   * @param ms - how long.
   * @param signal - cancellation; an aborted wait resolves early.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** @returns the current time in Unix seconds. */
  now(): number
}
```

- [ ] **Step 4: Rework `src/player.ts`**

Add these imports at the top of the existing import block:

```ts
import type { Track } from './audiolib.js'
import type { Playback, PreparedTrack } from './ports.js'
```

Replace `defaultPlayerCommand` with the probe-taking version, and add `probeOnPath` above it:

```ts
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
```

Extract the substitution out of `play` so it can be tested on its own. Add above `play`:

```ts
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
```

And in `play`, replace the first statement with:

```ts
  const argv = playerArgv(command, source)
```

- [ ] **Step 5: Add `createPlayback` at the end of `src/player.ts`**

```ts
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
    async prepare(track: Track, signal: AbortSignal): Promise<PreparedTrack> {
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
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm test
```

Expected: 31 passing tests total, 0 failing.

- [ ] **Step 7: Commit**

```bash
git add src/ports.ts src/player.ts test/player.test.ts
git commit -m "name the ports, and fix player detection on Windows

probeOnPath asks `where` on win32. `which` does not exist there, so mpv
was never found and every Windows user silently lost streaming.

createPlayback moves the stream-or-download decision into player.ts, so
the soundtrack above stops knowing that files exist."
```

---

### Task 4: The soundtrack on ports

Rewrite `ambient.ts` against the ports with **no behaviour change**, so the tests written here pin down what already works before Task 5 changes it.

**Files:**
- Create: `test/fakes.ts`
- Create: `test/ambient.test.ts`
- Modify: `src/ambient.ts` (replace `AmbientOptions`; drop the `player.js`/`audiolib.js` value imports; `Prepared` becomes `PreparedTrack`)

**Interfaces:**
- Consumes: `TrackSource`, `Playback`, `PreparedTrack`, `Clock` from `src/ports.js`; `Track`, `Quota` from `src/audiolib.js`.
- Produces:
  - `interface AmbientOptions { readonly source: TrackSource; readonly playback: Playback; readonly clock: Clock; libraries(): { working: string; idle: string }; readonly logger: AmbientLogger }`
  - `class AmbientSoundtrack` with unchanged public methods: `turnOpened(session)`, `turnClosed(session)`, `status()`, `warmUp()`, `request(library): 'now' | 'next-track'`, `stop()`, `dispose()`.

- [ ] **Step 1: Write the fakes**

Create `test/fakes.ts`:

```ts
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

/** A clock that records what it was asked to wait for and never waits. */
export class FakeClock implements Clock {
  /** Every delay requested, in order. */
  readonly slept: number[] = []
  #now = 1_000_000

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms)
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

  async fetch(library: string): Promise<Track> {
    this.requested.push(library)
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

  async prepare(track: Track): Promise<PreparedTrack> {
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
```

- [ ] **Step 2: Write the failing behaviour test**

Create `test/ambient.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AmbientSoundtrack, type AmbientOptions } from '../src/ambient.js'
import { FakeClock, FakeLogger, FakePlayback, FakeSource, settle } from './fakes.js'

/** One assembled soundtrack plus the fakes behind it. */
interface Harness {
  soundtrack: AmbientSoundtrack
  source: FakeSource
  playback: FakePlayback
  clock: FakeClock
  logger: FakeLogger
  /** Mutable, so a test can change the configured libraries mid-run. */
  libraries: { working: string; idle: string }
}

/**
 * Build a soundtrack over fakes.
 *
 * @param working - library while a turn is open.
 * @param idle - library once every turn has closed; empty means silence.
 * @returns the harness.
 */
function harness(working = 'audio.focus', idle = ''): Harness {
  const source = new FakeSource()
  const playback = new FakePlayback()
  const clock = new FakeClock()
  const logger = new FakeLogger()
  const libraries = { working, idle }
  const options: AmbientOptions = {
    source, playback, clock, logger,
    libraries: () => libraries,
  }
  return { soundtrack: new AmbientSoundtrack(options), source, playback, clock, logger, libraries }
}

test('a turn opening starts a track', async () => {
  const h = harness()
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1'])
  await h.soundtrack.dispose()
})

test('a turn closing does not interrupt the playing track', async () => {
  const h = harness('audio.focus', '')
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.turnClosed('s1')
  await settle()
  assert.equal(h.playback.isPlaying, true, 'the track kept playing')
  assert.equal(h.soundtrack.status().title, 'audio.focus #1')
  await h.soundtrack.dispose()
})

test('the idle library takes over at the seam, not before it', async () => {
  const h = harness('audio.focus', 'audio.ambient')
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.turnClosed('s1')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1'])
  h.playback.endTrack()
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.ambient #2'])
  await h.soundtrack.dispose()
})

test('silence at the seam when the idle library is empty', async () => {
  const h = harness('audio.focus', '')
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.turnClosed('s1')
  h.playback.endTrack()
  await settle()
  assert.equal(h.playback.isPlaying, false)
  assert.equal(h.soundtrack.status().library, '')
  await h.soundtrack.dispose()
})

test('idle is reached only when every open turn has closed', async () => {
  const h = harness('audio.focus', '')
  h.soundtrack.turnOpened('s1')
  h.soundtrack.turnOpened('s2')
  await settle()
  h.soundtrack.turnClosed('s1')
  h.playback.endTrack()
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.focus #2'])
  h.soundtrack.turnClosed('s2')
  h.playback.endTrack()
  await settle()
  assert.equal(h.playback.isPlaying, false)
  await h.soundtrack.dispose()
})

test('warmUp fetches a track before any turn opens', async () => {
  const h = harness()
  h.soundtrack.warmUp()
  await settle()
  assert.deepEqual(h.source.requested, ['audio.focus'])
  assert.equal(h.playback.played.length, 0, 'a warm-up prepares but does not play')
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.deepEqual(h.source.requested, ['audio.focus', 'audio.focus'], 'the seam prefetched the next one')
  assert.deepEqual(h.playback.played, ['audio.focus #1'], 'the warmed track played, not a fresh one')
  await h.soundtrack.dispose()
})

test('a prefetch for a library the seam no longer wants is discarded and disposed', async () => {
  const h = harness('audio.focus', 'audio.ambient')
  h.soundtrack.turnOpened('s1')
  await settle()
  // The seam prefetched audio.focus; closing the turn changes what plays next.
  h.soundtrack.turnClosed('s1')
  h.playback.endTrack()
  await settle()
  assert.ok(h.playback.disposed.includes('audio.focus #2'), 'the unwanted prefetch was released')
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.ambient #3'])
  await h.soundtrack.dispose()
})

test('stop cuts the playing track immediately', async () => {
  const h = harness()
  h.soundtrack.turnOpened('s1')
  await settle()
  await h.soundtrack.stop()
  assert.equal(h.playback.isPlaying, false)
  assert.equal(h.soundtrack.status().library, '')
  await h.soundtrack.dispose()
})

test('request while playing lands at the next seam', async () => {
  const h = harness()
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.equal(h.soundtrack.request('audio.jazz'), 'next-track')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1'])
  h.playback.endTrack()
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.jazz #3'])
  await h.soundtrack.dispose()
})

test('request while silent starts now', async () => {
  const h = harness()
  assert.equal(h.soundtrack.request('audio.jazz'), 'now')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.jazz #1'])
  await h.soundtrack.dispose()
})

test('request after stop resumes', async () => {
  const h = harness()
  h.soundtrack.turnOpened('s1')
  await settle()
  await h.soundtrack.stop()
  h.soundtrack.request('audio.jazz')
  await settle()
  // The exact track number depends on how many prefetches were discarded on
  // the way here, which is not what this test is about.
  assert.match(h.playback.played.at(-1) ?? '', /^audio\.jazz /)
  await h.soundtrack.dispose()
})

test('dispose releases an in-flight prefetch', async () => {
  const h = harness()
  h.soundtrack.turnOpened('s1')
  await settle()
  await h.soundtrack.dispose()
  await settle()
  assert.ok(h.playback.disposed.includes('audio.focus #2'), 'the pending prefetch was released')
  assert.equal(h.playback.isPlaying, false)
})

test('status reports the playing track and the newest quota', async () => {
  const h = harness()
  h.source.quota = {
    planName: 'Starter', total: 300, used: 1, remaining: 299,
    unlimited: false, ratePerMinute: 10, periodEnd: 1_800_000_000,
  }
  h.soundtrack.turnOpened('s1')
  await settle()
  const status = h.soundtrack.status()
  assert.equal(status.library, 'audio.focus')
  assert.equal(status.title, 'audio.focus #1')
  assert.equal(status.quota?.remaining, 299)
  await h.soundtrack.dispose()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test
```

Expected: compilation fails — `AmbientOptions` has no `source`, `playback`, or `clock`.

- [ ] **Step 4: Rewrite the top of `src/ambient.ts`**

Replace the import block and `AmbientOptions` (keep the file's existing module doc comment, `Activity`, `AmbientLogger`, and `AmbientStatus`):

```ts
import type { Quota, Track } from './audiolib.js'
import type { Clock, Playback, PreparedTrack, TrackSource } from './ports.js'
```

```ts
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
```

Replace the `Prepared` and `Prefetch` interfaces with:

```ts
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
```

- [ ] **Step 5: Rewrite the private methods that touched the network or the filesystem**

Replace `#prepare`, `#take`, `#startPrefetch`, `#discardPrefetch`, and the module-level `disposeQuietly` with:

```ts
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
```

- [ ] **Step 6: Rewrite `#run` against the ports**

Replace the body of `#run` with — note this keeps Task 4's "stop the loop on any failure" behaviour, which Task 5 replaces:

```ts
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
```

- [ ] **Step 7: Update `warmUp`**

`warmUp` keeps its body (`this.#startPrefetch(this.#options.libraries().working)`) but its doc comment now overstates the cost. Replace the comment with:

```ts
  /**
   * Prepare one track before anything asks for it, so the first turn opens on
   * the downbeat rather than on whatever the network takes to answer.
   */
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm test
```

Expected: 44 passing tests total, 0 failing.

- [ ] **Step 9: Verify the build still works**

```bash
npm run typecheck && npm run build
```

Expected: both succeed. `src/index.ts` still compiles because `AmbientOptions` changed shape — **if it does not**, that is expected here only if you already touched `index.ts`; do not. Instead, apply the minimal wiring now:

In `src/index.ts`, replace the `new AmbientSoundtrack({...})` call with:

```ts
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
```

and add to the imports:

```ts
import { requestTrack } from './audiolib.js'
import { createPlayback, defaultPlayerCommand } from './player.js'
import { systemClock } from './clock.js'
```

Create `src/clock.ts`:

```ts
/** The real clock, kept out of `index.ts` so the wiring stays one screen. */

import { setTimeout as delay } from 'node:timers/promises'
import type { Clock } from './ports.js'

/** Time as the process sees it. */
export const systemClock: Clock = {
  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    // An aborted wait resolves rather than throws: a cancelled retry is a
    // normal shutdown, not a failure the caller has to handle.
    await delay(ms, undefined, { signal }).catch(() => undefined)
  },
  now(): number {
    return Math.floor(Date.now() / 1_000)
  },
}
```

- [ ] **Step 10: Commit**

```bash
git add src/ambient.ts src/clock.ts src/index.ts test/fakes.ts test/ambient.test.ts
git commit -m "put the soundtrack on ports, and pin down what it already does

ambient.ts now imports no node module. Thirteen tests cover the seam,
the prefetch discard, concurrent turns, stop, and the dispose race —
the behaviour the next commit is about to change."
```

---

### Task 5: Health, retry, and the override lifetime

**Files:**
- Modify: `src/ambient.ts` (add `#health`, `#attempts`, `#stopped`, `#warnedLowQuota`; rewrite `#run`, `#ensureRunning`, `#currentLibrary`, `turnClosed`, `request`, `stop`, `status`)
- Modify: `test/ambient.test.ts` (append the health tests)

**Interfaces:**
- Consumes: `Health`, `backoffMs`, `healthFromError` from `src/health.js` (Task 2); `AudiolibError` from `src/audiolib.js` (Task 1).
- Produces: `AmbientStatus` gains `readonly health: Health`.

- [ ] **Step 1: Write the failing tests**

Append to `test/ambient.test.ts` (the imports at the top of the file gain `authFailure`, `quotaFailure`, `transientFailure` from `./fakes.js`):

```ts
test('a transient failure retries and the music comes back on its own', async () => {
  const h = harness()
  h.source.failNext(transientFailure())
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1'], 'the retry succeeded')
  assert.deepEqual(h.clock.slept, [1_000])
  assert.equal(h.soundtrack.status().health.kind, 'ok')
  await h.soundtrack.dispose()
})

test('repeated failures back off 1, 2, 4, 8, 16, 30, 30 seconds', async () => {
  const h = harness()
  h.source.failNext(transientFailure(), 7)
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.deepEqual(h.clock.slept, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  assert.deepEqual(h.playback.played, ['audio.focus #1'])
  await h.soundtrack.dispose()
})

test('a retry storm warns once, and says so once when it recovers', async () => {
  const h = harness()
  h.source.failNext(transientFailure(), 4)
  h.soundtrack.turnOpened('s1')
  await settle()
  const retrying = h.logger.warnings.filter(line => line.includes('retrying'))
  assert.equal(retrying.length, 1, 'one warning for the whole outage')
  assert.equal(h.logger.infos.filter(line => line.includes('recovered')).length, 1)
  await h.soundtrack.dispose()
})

test('an auth failure pauses without retrying', async () => {
  const h = harness()
  h.source.failNext(authFailure(), 5)
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.deepEqual(h.clock.slept, [], 'no backoff was attempted')
  assert.deepEqual(h.source.requested, ['audio.focus'], 'exactly one call was spent')
  const health = h.soundtrack.status().health
  assert.equal(health.kind, 'paused')
  assert.equal(health.kind === 'paused' ? health.reason : '', 'auth')
  await h.soundtrack.dispose()
})

test('a paused soundtrack does not wake on a new turn', async () => {
  const h = harness()
  h.source.failNext(authFailure())
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.turnClosed('s1')
  h.soundtrack.turnOpened('s2')
  await settle()
  assert.deepEqual(h.source.requested, ['audio.focus'], 'the pause held')
  await h.soundtrack.dispose()
})

test('music_play clears a pause', async () => {
  const h = harness()
  h.source.failNext(authFailure())
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.request('audio.jazz')
  await settle()
  assert.equal(h.soundtrack.status().health.kind, 'ok')
  assert.deepEqual(h.playback.played, ['audio.jazz #1'])
  await h.soundtrack.dispose()
})

test('a quota pause lifts once the period the API named has passed', async () => {
  const h = harness()
  h.source.failNext(quotaFailure(h.clock.now() + 3_600))
  h.soundtrack.turnOpened('s1')
  await settle()
  assert.equal(h.soundtrack.status().health.kind, 'paused')

  h.soundtrack.turnClosed('s1')
  h.soundtrack.turnOpened('s2')
  await settle()
  assert.deepEqual(h.source.requested, ['audio.focus'], 'still inside the period')

  h.clock.advance(3_601)
  h.soundtrack.turnClosed('s2')
  h.soundtrack.turnOpened('s3')
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1'], 'the period rolled over')
  await h.soundtrack.dispose()
})

test('a missing player pauses with the player reason', async () => {
  const h = harness()
  h.playback.failNextPlay(new Error('audiolib: player "mpv" not found'))
  h.soundtrack.turnOpened('s1')
  await settle()
  const health = h.soundtrack.status().health
  assert.equal(health.kind === 'paused' ? health.reason : '', 'player')
  await h.soundtrack.dispose()
})

test('an override clears when the last turn closes', async () => {
  const h = harness('audio.focus', 'audio.ambient')
  h.soundtrack.turnOpened('s1')
  await settle()
  h.soundtrack.request('audio.jazz')
  h.playback.endTrack()
  await settle()
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.jazz #3'])
  h.soundtrack.turnClosed('s1')
  h.playback.endTrack()
  await settle()
  assert.match(h.playback.played.at(-1) ?? '', /^audio\.ambient /, 'the override did not outlive the work')
  await h.soundtrack.dispose()
})

test('an override survives a turn close that leaves another turn open', async () => {
  const h = harness('audio.focus', 'audio.ambient')
  h.soundtrack.turnOpened('s1')
  h.soundtrack.turnOpened('s2')
  await settle()
  h.soundtrack.request('audio.jazz')
  h.soundtrack.turnClosed('s1')
  h.playback.endTrack()
  await settle()
  assert.equal(h.playback.played.at(-1), 'audio.jazz #3')
  await h.soundtrack.dispose()
})

test('a turn closing does not undo an explicit stop', async () => {
  const h = harness('audio.focus', 'audio.ambient')
  h.soundtrack.turnOpened('s1')
  await settle()
  await h.soundtrack.stop()
  h.soundtrack.turnClosed('s1')
  h.soundtrack.turnOpened('s2')
  await settle()
  assert.equal(h.playback.isPlaying, false, 'silence requested is silence owed')
  await h.soundtrack.dispose()
})

test('a low quota warns once, not once per track', async () => {
  const h = harness()
  h.source.quota = {
    planName: 'Starter', total: 300, used: 291, remaining: 9,
    unlimited: false, ratePerMinute: 10, periodEnd: 1_800_000_000,
  }
  h.soundtrack.turnOpened('s1')
  await settle()
  h.playback.endTrack()
  await settle()
  h.playback.endTrack()
  await settle()
  const low = h.logger.warnings.filter(line => line.includes('calls left this period'))
  assert.equal(low.length, 1)
  await h.soundtrack.dispose()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```

Expected: compilation fails — `status().health` does not exist — and, once that is added, the retry tests fail because the loop still returns on the first failure.

- [ ] **Step 3: Add the new state and the status field**

In `src/ambient.ts`, add the import:

```ts
import { backoffMs, healthFromError, type Health } from './health.js'
import { AudiolibError } from './audiolib.js'
```

Note `AudiolibError` is a value import — `ambient.ts` needs `instanceof`. It carries no Node dependency, so the module stays pure.

Extend `AmbientStatus`:

```ts
  /** Why the soundtrack is or is not playing. */
  readonly health: Health
```

Replace the `#override` field declaration with:

```ts
  /** Library requested by `music_play`; cleared when the last open turn closes. */
  #override: string | undefined
  /** Set by `music_stop`. Only `music_play` clears it — a turn boundary must not. */
  #stopped = false
```

Add alongside `#quota`:

```ts
  /** Why the soundtrack is or is not playing. */
  #health: Health = { kind: 'ok' }
  /** Consecutive fetch failures; the first success resets it. */
  #attempts = 0
  /** Whether the low-quota warning has already been spent this period. */
  #warnedLowQuota = false
```

Add the threshold at module scope, below the imports:

```ts
/** Remaining share of the period's calls below which the plugin says so once. */
const LOW_QUOTA_FRACTION = 0.1
```

- [ ] **Step 4: Rewrite the state accessors**

```ts
  turnClosed(session: string): void {
    this.#openTurns.delete(session)
    // An explicitly chosen library scores the stretch of work it was chosen
    // for, and ends with it.
    if (this.#openTurns.size === 0) this.#override = undefined
    this.#ensureRunning()
  }

  status(): AmbientStatus {
    return {
      library: this.#playing?.library ?? '',
      title: this.#playing?.title ?? '',
      quota: this.#quota,
      health: this.#health,
    }
  }

  request(library: string): 'now' | 'next-track' {
    this.#stopped = false
    this.#override = library
    // An explicit call is someone saying "try again", and it is the only
    // signal that carries that meaning.
    this.#health = { kind: 'ok' }
    this.#attempts = 0
    const playing = this.#loop !== undefined
    this.#startPrefetch(library)
    this.#ensureRunning()
    return playing ? 'next-track' : 'now'
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#override = undefined
    this.#track?.abort()
    await this.#loop
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
```

- [ ] **Step 5: Rewrite `#run` to retry instead of returning**

```ts
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
    const quota = (error instanceof AudiolibError ? error.quota : undefined) ?? this.#quota
    this.#attempts += 1
    const wasRetrying = this.#health.kind === 'retrying'
    const health = healthFromError(kind, message, this.#attempts, quota)
    this.#health = health
    if (health.kind !== 'retrying') {
      this.#options.logger.warn('audiolib: paused — %s', message)
      return false
    }
    // One warning for the whole outage. Warning per attempt floods exactly the
    // log a reader would be searching to understand the outage.
    if (!wasRetrying) this.#options.logger.warn('audiolib: request failed, retrying — %s', message)
    await this.#options.clock.sleep(backoffMs(this.#attempts), this.#controller.signal)
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
```

- [ ] **Step 6: Move the quota bookkeeping into its own method**

In `#prepare`, replace `if (track.quota !== undefined) this.#quota = track.quota` with `this.#noteQuota(track.quota)`, and add:

```ts
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
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test
```

Expected: 56 passing tests total, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add src/ambient.ts test/ambient.test.ts
git commit -m "retry transient failures, and let music_play stop outliving the work

A network hiccup used to silence the soundtrack until the next turn, and
with an idle library configured that meant forever. Transient failures
now back off and resume; auth, quota, player, and config failures pause
with a reason the status tool can report.

music_play's library now clears when the last open turn closes, which is
what the README always said happened."
```

---

### Task 6: Report health through `music_status`

**Files:**
- Modify: `src/index.ts` (add `health` and `healthReason` to the `music_status` output schema, execute, and render)

**Interfaces:**
- Consumes: `AmbientStatus.health` (Task 5).
- Produces: `music_status` output gains `health: string` and `healthReason: string`.

- [ ] **Step 1: Write the failing test**

Create `test/status.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeHealth } from '../src/index.js'

test('a healthy soundtrack reports ok with nothing to explain', () => {
  assert.deepEqual(describeHealth({ kind: 'ok' }), { health: 'ok', healthReason: '' })
})

test('a retry streak reports itself and how many attempts in', () => {
  const described = describeHealth({ kind: 'retrying', attempts: 3, message: 'HTTP 503' })
  assert.equal(described.health, 'retrying')
  assert.match(described.healthReason, /3/)
  assert.match(described.healthReason, /HTTP 503/)
})

test('a pause names the reason, so the model can say what to fix', () => {
  const described = describeHealth({
    kind: 'paused', reason: 'auth', message: 'HTTP 401', untilUnix: 0,
  })
  assert.equal(described.health, 'paused:auth')
  assert.match(described.healthReason, /HTTP 401/)
})

test('a dated pause says when it lifts', () => {
  const described = describeHealth({
    kind: 'paused', reason: 'quota', message: 'exhausted', untilUnix: 1_800_000_000,
  })
  assert.equal(described.health, 'paused:quota')
  assert.match(described.healthReason, /2027/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test
```

Expected: compilation fails with `'"../src/index.js"' has no exported member named 'describeHealth'`.

- [ ] **Step 3: Add `describeHealth` to `src/index.ts`**

Add near the bottom, above `statusTool`:

```ts
/** The `music_status` projection of a {@link Health}. */
export interface DescribedHealth {
  /** `ok`, `retrying`, or `paused:<reason>` — one token the model can branch on. */
  readonly health: string
  /** What went wrong and, for a dated pause, when it lifts; empty when nothing did. */
  readonly healthReason: string
}

/**
 * Flatten health into the two strings the tool reports.
 *
 * The card cannot show any of this — third-party settings namespaces are still
 * off the `dsh-host-apiproxy` allowlist — so the tool is the only place a user
 * can ask why the room is quiet and get an answer.
 *
 * @param health - the soundtrack's current health.
 * @returns the two reported fields.
 */
export function describeHealth(health: Health): DescribedHealth {
  if (health.kind === 'ok') return { health: 'ok', healthReason: '' }
  if (health.kind === 'retrying') {
    return {
      health: 'retrying',
      healthReason: `${health.message} (attempt ${health.attempts})`,
    }
  }
  const lifts = health.untilUnix === 0
    ? ''
    : ` Retries after ${new Date(health.untilUnix * 1_000).toISOString()}.`
  return { health: `paused:${health.reason}`, healthReason: `${health.message}.${lifts}` }
}
```

Add the import:

```ts
import type { Health } from './health.js'
```

- [ ] **Step 4: Wire the fields into `statusTool`**

In the output `schema.properties`, add:

```ts
          health: { type: 'string' },
          healthReason: { type: 'string' },
```

and add `'health'`, `'healthReason'` to the `required` array.

In `execute`, replace the return with:

```ts
    async execute() {
      const { library, title, quota, health } = soundtrack.status()
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
        ...describeHealth(health),
      }
    },
```

In `render`, widen the cast and append the health sentence:

```ts
      render: (_args, value) => {
        const status = value as {
          library: string; title: string; plan: string
          remaining: number; total: number; unlimited: boolean
          health: string; healthReason: string
        }
        const playing = status.library === '' ? 'Nothing playing.' : `Playing ${status.title} (${status.library}).`
        const quota = status.plan === ''
          ? 'No AudioLib call has been made yet, so no quota is known.'
          : status.unlimited
            ? `Plan ${status.plan}, unlimited calls.`
            : `Plan ${status.plan}, ${status.remaining} of ${status.total} calls left this period.`
        const health = status.health === 'ok' ? '' : ` Soundtrack ${status.health}: ${status.healthReason}`
        return [{ type: 'text', text: `${playing} ${quota}${health}` }]
      },
```

Update the tool description to mention it:

```ts
    description: 'Report the track playing now, the AudioLib plan, remaining calls, and rate limit, and why the soundtrack is silent when it is. Costs no API call.',
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test && npm run typecheck && npm run build
```

Expected: 60 passing tests, 0 failing; typecheck and build succeed.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/status.test.ts
git commit -m "let music_status say why the room is quiet

The browser card still cannot show this, so the tool is the only place a
user can ask and get an answer."
```

---

### Task 7: CI, and the 0.2.0 release

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (version 0.2.0)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `README.zh.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further tasks rely on.

- [ ] **Step 1: Add the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ['22.19', '24']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Verify the workflow's commands pass locally**

```bash
npm ci && npm run typecheck && npm test && npm run build
```

Expected: all four succeed.

- [ ] **Step 3: Bump the version**

In `package.json`, set `"version": "0.2.0"`.

- [ ] **Step 4: Write the changelog entry**

Insert below the `# Changelog` heading in `CHANGELOG.md`:

```markdown
## 0.2.0 — 2026-08-14

- A failed request no longer silences the soundtrack. Transient failures —
  network, 5xx, timeout, and the per-minute rate limit — back off 1s, 2s, 4s,
  8s, 16s, then 30s and keep going, so the music resumes by itself after an
  outage of any length. Failures no retry can fix pause instead, each with a
  reason: a bad key, an exhausted period, a missing player, a response the
  client cannot read.
- A quota pause is dated from the `period_end` the API reports, so it lifts by
  itself when the period rolls over. Every other pause waits for `music_play`
  or a restart, because nothing else about it can change on its own.
- `music_status` reports `health` and `healthReason`, which is where "why is
  there no music" gets answered — the browser card still cannot show it.
- One warning when fewer than 10% of the period's calls are left, so the wall
  arrives announced.
- **Changed:** the library `music_play` chooses now clears when the last open
  turn closes, returning to `idleLibrary`. It used to persist forever, which
  disabled the working/idle mapping for the rest of the session and contradicted
  what the README described.
- Fixed: `mpv` and `ffplay` are now detected on Windows. Detection probed with
  `which`, which does not exist there, so streaming playback was silently lost.
- The soundtrack runs on injected ports and the package has a test suite —
  `npm test`, no new dependency — covering the seam, prefetch discard,
  concurrent turns, the backoff sequence, every failure classification, and the
  dispose race. CI runs it on Node 22 and 24.
```

- [ ] **Step 5: Update both READMEs**

In `README.md`, find the paragraph describing `music_play` under the tools section and make the lifetime explicit. Add after it:

```markdown
`music_play`'s choice lasts as long as the work does: when the last open turn closes, the soundtrack returns to `idleLibrary`. An explicitly chosen library scores the stretch of work it was chosen for.

When a request fails, transient causes — network, 5xx, timeout, rate limit — back off and retry indefinitely, so the music resumes on its own. A bad key, an exhausted period, a missing player, or an unreadable response pauses instead; `music_status` reports which, and a quota pause lifts by itself when the period rolls over.
```

Mirror both paragraphs in `README.zh.md` in that file's voice:

```markdown
`music_play` 选的曲库只活到这段工作结束：最后一个 turn 关闭时，音轨回到 `idleLibrary`。明确选的曲库，是为它配的那段工作而选的。

请求失败时，瞬时原因——网络、5xx、超时、速率限制——会退避重试且不设上限，音乐自己接上。密钥错误、额度耗尽、播放器缺失、响应读不了则转为暂停；`music_status` 会说是哪一种，其中额度暂停在周期翻转后自行解除。
```

- [ ] **Step 6: Verify everything passes one more time**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all three succeed.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml package.json CHANGELOG.md README.md README.zh.md
git commit -m "release 0.2.0, and run the tests on every push

Node 22 and 24, typecheck and test and build."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `Health` type, `PauseReason` | 2 |
| Classification table incl. the 429 rule and undated `periodEnd` | 1, 2 |
| Backoff 1/2/4/8/16/30, no attempt ceiling | 2, 5 |
| Leaving `paused`: `music_play`, dated quota, sticky rest | 5 |
| Logging: one warning in, one info out | 5 |
| `#override` / `#stopped` split and lifetime | 5 |
| Ports (`TrackSource`, `PreparedTrack`, `Playback`, `Clock`) | 3 |
| `Prepared`/`LocalTrack`/`isStreaming` retreat into `player.ts` | 3 |
| `health.ts` as pure functions | 2 |
| Wiring in `index.ts` | 4 (ports), 6 (status) |
| Test harness: `node:test`, `.test-build/`, NodeNext note | 1 |
| All eleven listed behaviours | 1, 4, 5 |
| Windows `where` | 3 |
| Low-quota warning at 10% | 5 |
| `music_status` health fields | 6 |
| CI on Node 22 and 24 | 7 |
| Version 0.2.0, CHANGELOG in existing voice | 7 |

**Type consistency:** `Taken` is introduced in Task 4 and used unchanged in Task 5. `PreparedTrack` is named identically in `ports.ts`, `player.ts`, `ambient.ts`, and the fakes. `healthFromError(kind, message, attempts, quota)` is defined in Task 2 and called with that argument order in Task 5. `describeHealth` returns `{ health, healthReason }`, matching the schema properties added in Task 6.

**Known ordering constraint:** Task 4's Step 9 changes `src/index.ts` because `AmbientOptions` changes shape — `index.ts` cannot compile between Steps 4 and 9. That is deliberate: splitting the port rewrite from its wiring would leave the tree unbuildable across a commit boundary.
