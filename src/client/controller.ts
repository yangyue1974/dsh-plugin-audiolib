/**
 * The AudioLib card's state: the plugin's settings section plus the one thing
 * that is not in it — whether a key is configured.
 *
 * The key literal never rides a response, so the card can only learn whether
 * the Host holds one, and writes go to the credentials domain rather than the
 * settings section.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'

/** The fields this card edits, all optional as the wire section may omit them. */
export interface AudiolibSettings {
  apiKeyRef?: string
  workingLibrary?: string
  idleLibrary?: string
  ambient?: boolean
}

/** Everything the card renders. */
export interface CardState {
  /** Settings sync state; anything but `ready` disables the controls. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts settings writes. */
  writable: boolean
  /** Credential reference this deployment names. */
  apiKeyRef: string
  /** Whether the Host reports a key behind that reference. */
  keyConfigured: boolean
  /** Whether the credentials domain accepts a write; false when the environment shadows it. */
  keyWritable: boolean
  /** The staged key, blank on every load. */
  keyDraft: string
  /** Whether a write is in flight. */
  busy: boolean
  /** Last outcome to show the user; empty when there is nothing to say. */
  notice: 'saved' | 'failed' | ''
  /** Library played while the agent works. */
  workingLibrary: string
  /** Library played once the agent is idle; empty means silence. */
  idleLibrary: string
  /** Whether session events drive the soundtrack at all. */
  ambient: boolean
}

/** The credential reference used when the section names none. */
const DEFAULT_KEY_REF = 'AUDIOLIB_API_KEY'

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

/**
 * Bridges the `audiolib` settings scope and the credentials domain onto one
 * card state, published to React through `subscribe`/`getState`.
 */
export class CardController {
  readonly #scope: SettingsScope<AudiolibSettings>
  readonly #api: Pick<IApiClient, 'credentials'>
  readonly #listeners = new Set<() => void>()
  #credential: CredentialState = { ref: DEFAULT_KEY_REF, configured: false, writable: true }
  #draft = ''
  #busy = false
  #notice: CardState['notice'] = ''
  /** Cached so `getState` returns a stable reference between changes. */
  #state: CardState

  /**
   * @param scope - the bound settings scope for the `audiolib` namespace.
   * @param api - the connection's credentials domain.
   */
  constructor(scope: SettingsScope<AudiolibSettings>, api: Pick<IApiClient, 'credentials'>) {
    this.#scope = scope
    this.#api = api
    this.#state = this.#project()
    scope.subscribe(() => {
      this.#publish()
      void this.#readCredential()
    })
    void this.#readCredential()
  }

  /**
   * Observe card changes.
   *
   * @param listener - invoked after each published change.
   * @returns the disposer removing this listener.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** @returns the current card state; the same reference until something changes. */
  getState = (): CardState => this.#state

  /**
   * Stage a key without writing it.
   *
   * @param value - what the user typed.
   */
  setKeyDraft = (value: string): void => {
    this.#draft = value
    this.#notice = ''
    this.#publish()
  }

  /** Write the staged key through the credentials domain, then re-read the badge. */
  saveKey = async (): Promise<void> => {
    const value = this.#draft.trim()
    if (value === '' || this.#busy) return
    this.#busy = true
    this.#notice = ''
    this.#publish()
    try {
      await this.#api.credentials.set({ ref: this.#refOf(), value })
    } catch (_writeRefused) {
      // The Host is the only authority on whether the key landed; the re-read
      // below reports what it actually holds.
    }
    await this.#readCredential()
    this.#busy = false
    this.#draft = this.#credential.configured ? '' : this.#draft
    this.#notice = this.#credential.configured ? 'saved' : 'failed'
    this.#publish()
  }

  /**
   * Write one settings field, or clear it when the user picks the inherited value.
   *
   * @param field - the settings field to write.
   * @param value - the chosen value.
   */
  setField = async (field: keyof AudiolibSettings, value: string | boolean): Promise<void> => {
    await this.#scope.set(field, value)
  }

  /** @returns the reference the section names, or the default. */
  #refOf(): string {
    const named = this.#scope.getSnapshot().value?.apiKeyRef
    return named === undefined || named === '' ? DEFAULT_KEY_REF : named
  }

  async #readCredential(): Promise<void> {
    const ref = this.#refOf()
    if (ref !== this.#credential.ref) {
      this.#credential = { ref, configured: false, writable: true }
      this.#publish()
    }
    let configured = false
    let writable = true
    try {
      const response = await this.#api.credentials.describe({ refs: [ref] })
      if (!response.result.ok || ref !== this.#refOf()) return
      const view = response.result.value.credentials[ref]
      configured = view?.configured ?? false
      // An unknown reference stays writable: the Host refuses, the card does not guess.
      writable = view?.writable ?? true
    } catch (_readFailure) {
      // Keep the last known state; a write still reaches the Host.
      return
    }
    if (configured === this.#credential.configured && writable === this.#credential.writable) return
    this.#credential = { ref, configured, writable }
    this.#publish()
  }

  #project(): CardState {
    const snapshot = this.#scope.getSnapshot()
    const value = snapshot.value
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      apiKeyRef: this.#refOf(),
      keyConfigured: this.#credential.configured,
      keyWritable: this.#credential.writable,
      keyDraft: this.#draft,
      busy: this.#busy,
      notice: this.#notice,
      workingLibrary: value?.workingLibrary ?? 'audio.focus',
      idleLibrary: value?.idleLibrary ?? '',
      ambient: value?.ambient ?? true,
    }
  }

  #publish(): void {
    this.#state = this.#project()
    for (const listener of this.#listeners) listener()
  }
}
