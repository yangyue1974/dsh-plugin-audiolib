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
