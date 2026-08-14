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
