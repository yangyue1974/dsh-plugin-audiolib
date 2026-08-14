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
