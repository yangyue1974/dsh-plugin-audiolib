# Changelog

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
- Fixed: the install instructions in both READMEs told the reader to run
  `dsh plugin --profile web add dsh-plugin-audiolib`. That fails for anyone who
  installed DSH with `npx @deepseek-ai/dsh web` — `dsh` is never on `PATH` that
  way, and DSH's plugin installer needs pnpm, which is not installed either.
  Both READMEs now route through `npx` and `corepack enable pnpm`.

## 0.1.0 — 2026-08-14

First release.

- Session events drive the soundtrack: `turn/start` opens the working library, `turn/end` returns to the idle one. The selection takes effect only at a track seam, so a state change never cuts off a playing track. `music_stop` is the one exception.
- Streams by default. `{url}` in `playerCommand` hands the AudioLib URL to `mpv` or `ffplay`, which buffers as it plays and writes nothing to disk; `{file}` keeps a download path for players that cannot stream (macOS `afplay`).
- Prefetches one track at load and again when a track starts, so the first turn opens on the downbeat and the seam has no gap.
- Model-facing tools: `music_play` over the 25-library catalog, `music_stop`, and `music_status`, which reports plan and remaining calls without spending one.
- The key is a credential reference (`apiKeyRef`), resolved per call from the DSH credential store or the environment. Configuration never holds the secret.
- Browser half: a card in Settings → Plugins with the key control, the library pickers, and the ambient toggle.

Known limitation: the card's library pickers are read-only. `dsh-host-apiproxy` allowlists which settings namespaces reach the browser and third-party namespaces are not on it — its own comment marks moving that decision to `settings.register()` as deferred work. Set the libraries in your profile's `cordis.patch.yml` until that lifts. Credentials are not gated this way, so the key control works.
