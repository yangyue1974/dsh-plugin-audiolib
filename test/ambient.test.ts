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
  // #2 is missing because the seam that started #1 prefetched audio.focus, and
  // the closed turn made that prefetch the wrong library to play.
  assert.deepEqual(h.playback.played, ['audio.focus #1', 'audio.ambient #3'])
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
