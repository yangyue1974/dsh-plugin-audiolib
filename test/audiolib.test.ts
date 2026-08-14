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
