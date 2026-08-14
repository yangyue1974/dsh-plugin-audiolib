/**
 * AudioLib REST client. One POST returns one fully-cleared track URL.
 *
 * @see https://audiolib.ai/docs
 */

/**
 * The quota snapshot every successful response carries. AudioLib documents it
 * as the surface a product shows its users, so the plugin keeps the newest one
 * rather than discarding it with the rest of the envelope.
 */
export interface Quota {
  /** Plan display name, for example `Starter`. */
  readonly planName: string
  /** Calls included in the current period. */
  readonly total: number
  /** Calls already spent in the current period. */
  readonly used: number
  /** Calls still available in the current period. */
  readonly remaining: number
  /** Whether the plan has no call ceiling. */
  readonly unlimited: boolean
  /** Calls per minute the plan allows. */
  readonly ratePerMinute: number
  /** Unix seconds at which the current period ends. */
  readonly periodEnd: number
}

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

/** One track AudioLib selected for a requested library. */
export interface Track {
  /** Track title, used for logging only. */
  readonly title: string
  /** Time-limited media URL served from the AudioLib CDN. */
  readonly url: string
  /** Track length in seconds as reported by the API; `0` when absent. */
  readonly durationSec: number
  /** Account state at the moment of this call; absent when the API omits it. */
  readonly quota: Quota | undefined
}

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

/** The JSON envelope returned by the audio endpoint; every field is untrusted. */
interface AudiolibBody {
  code?: unknown
  msg?: unknown
  data?: {
    title?: unknown
    url?: unknown
    duration_sec?: unknown
    quota?: Record<string, unknown>
  }
}

/** Read one number out of the untrusted quota object. */
function quotaNumber(quota: Record<string, unknown>, field: string): number {
  const value = quota[field]
  return typeof value === 'number' ? value : 0
}

/**
 * Project the response's quota object, or `undefined` when the API omits it.
 *
 * @param quota - the untrusted `data.quota` value.
 * @returns the projected snapshot.
 */
function readQuota(quota: Record<string, unknown> | undefined): Quota | undefined {
  if (quota === undefined) return undefined
  return {
    planName: typeof quota['plan_name'] === 'string' ? quota['plan_name'] : '',
    total: quotaNumber(quota, 'total_quota'),
    used: quotaNumber(quota, 'used_quota'),
    remaining: quotaNumber(quota, 'remaining_quota'),
    unlimited: quota['is_unlimited'] === true,
    ratePerMinute: quotaNumber(quota, 'rate_per_minute'),
    periodEnd: quotaNumber(quota, 'period_end'),
  }
}

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

/**
 * Request one track from `library`.
 *
 * @param endpoint - endpoint URL and per-request deadline.
 * @param apiKey - the key resolved for this one call; credentials are never cached.
 * @param library - AudioLib library id, for example `audio.focus`.
 * @param signal - caller cancellation, combined with the configured deadline.
 * @returns the selected track and the account's quota at that moment.
 * @throws when the request fails or the response carries no usable URL.
 */
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
