# Changelog

## 0.1.0 — 2026-08-14

First release.

- Session events drive the soundtrack: `turn/start` opens the working library, `turn/end` returns to the idle one. The selection takes effect only at a track seam, so a state change never cuts off a playing track. `music_stop` is the one exception.
- Streams by default. `{url}` in `playerCommand` hands the AudioLib URL to `mpv` or `ffplay`, which buffers as it plays and writes nothing to disk; `{file}` keeps a download path for players that cannot stream (macOS `afplay`).
- Prefetches one track at load and again when a track starts, so the first turn opens on the downbeat and the seam has no gap.
- Model-facing tools: `music_play` over the 25-library catalog, `music_stop`, and `music_status`, which reports plan and remaining calls without spending one.
- The key is a credential reference (`apiKeyRef`), resolved per call from the DSH credential store or the environment. Configuration never holds the secret.
- Browser half: a card in Settings → Plugins with the key control, the library pickers, and the ambient toggle.

Known limitation: the card's library pickers are read-only. `dsh-host-apiproxy` allowlists which settings namespaces reach the browser and third-party namespaces are not on it — its own comment marks moving that decision to `settings.register()` as deferred work. Set the libraries in your profile's `cordis.patch.yml` until that lifts. Credentials are not gated this way, so the key control works.
