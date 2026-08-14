/**
 * AudioLib REST client. One POST returns one fully-cleared track URL.
 *
 * @see https://audiolib.ai/docs
 */

/** One track AudioLib selected for a requested library. */
export interface Track {
  /** Track title, used for logging only. */
  readonly title: string
  /** Time-limited media URL served from the AudioLib CDN. */
  readonly url: string
  /** Track length in seconds as reported by the API; `0` when absent. */
  readonly durationSec: number
}

/** Connection settings for one AudioLib deployment. */
export interface Endpoint {
  /** API key issued by the AudioLib dashboard (`alp_…`). */
  readonly apiKey: string
  /** Full audio endpoint URL. */
  readonly baseUrl: string
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number
}

/** The JSON envelope returned by the audio endpoint; every field is untrusted. */
interface AudiolibBody {
  code?: unknown
  msg?: unknown
  data?: { title?: unknown; url?: unknown; duration_sec?: unknown }
}

/**
 * Request one track from `library`.
 *
 * @param endpoint - API key, endpoint URL, and per-request deadline.
 * @param library - AudioLib library id, for example `audio.focus`.
 * @param signal - caller cancellation, combined with the configured deadline.
 * @returns the selected track.
 * @throws when the request fails or the response carries no usable URL.
 */
export async function requestTrack(endpoint: Endpoint, library: string, signal: AbortSignal): Promise<Track> {
  const response = await fetch(endpoint.baseUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ library }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs)]),
  })
  const body = await response.json().catch(() => undefined) as AudiolibBody | undefined
  const message = typeof body?.msg === 'string' ? `, ${body.msg}` : ''
  if (!response.ok || body?.code !== 0) {
    throw new Error(`audiolib: "${library}" request failed (HTTP ${response.status}${message})`)
  }
  const data = body.data
  if (typeof data?.url !== 'string' || data.url === '') {
    throw new Error(`audiolib: "${library}" response carried no track URL`)
  }
  return {
    title: typeof data.title === 'string' ? data.title : library,
    url: data.url,
    durationSec: typeof data.duration_sec === 'number' ? data.duration_sec : 0,
  }
}
