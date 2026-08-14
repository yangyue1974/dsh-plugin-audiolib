/**
 * The AudioLib card inside Settings → Plugins.
 *
 * Self-contained by necessity: a third-party browser bundle may resolve only
 * the module table (react, cordis, ui-primitives), so the card cannot reuse the
 * built-in card chrome and draws its own.
 */

import { useSyncExternalStore } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { LIBRARIES } from '../libraries.js'
import type { CardController, CardState } from './controller.js'
import { copy } from './copy.js'

/** The face the slot registration injects; no `hooks` compartment, so it passes through verbatim. */
export interface AudiolibCardFace {
  controller: CardController
}

/** Props the slot renderer binds for this card. */
export type AudiolibCardProps = AudiolibCardFace

/** Row spacing shared by every control block. */
const ROW: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.75rem' }
const HINT: React.CSSProperties = { fontSize: '0.75rem', opacity: 0.75 }
const LABEL: React.CSSProperties = { fontSize: '0.8125rem', fontWeight: 600 }

/**
 * One library picker.
 *
 * @param props - label, hint, current value, an optional silence entry, and the writer.
 * @returns the labelled select.
 */
function LibrarySelect(props: {
  label: string
  hint: string
  value: string
  silenceLabel?: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <div style={ROW}>
      <span style={LABEL}>{props.label}</span>
      <select
        value={props.value}
        disabled={props.disabled}
        onChange={event => { props.onChange(event.target.value) }}
        style={{ padding: '0.375rem 0.5rem', borderRadius: '0.375rem', font: 'inherit' }}
      >
        {props.silenceLabel === undefined ? null : <option value="">{props.silenceLabel}</option>}
        {LIBRARIES.map(library => <option key={library} value={library}>{library}</option>)}
      </select>
      <span style={HINT}>{props.hint}</span>
    </div>
  )
}

/**
 * Render the AudioLib card.
 *
 * @param props - the injected controller.
 * @returns the card.
 */
export function AudiolibCard(props: AudiolibCardProps) {
  const { controller } = props
  const state: CardState = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const t = copy()
  const locked = state.status !== 'ready' || !state.writable

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem 0' }}>
      <header style={ROW}>
        <strong>{t.title}</strong>
        <span style={HINT}>{t.description}</span>
      </header>

      <div style={ROW}>
        <span style={LABEL}>
          {t.keyLabel}{' '}
          <Pill>{state.keyConfigured ? t.keyConfigured : t.keyMissing}</Pill>
        </span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Input
            type="password"
            value={state.keyDraft}
            placeholder={t.keyPlaceholder}
            disabled={!state.keyWritable || state.busy}
            onChange={event => { controller.setKeyDraft(event.target.value) }}
          />
          <Button
            variant="primary"
            disabled={!state.keyWritable || state.busy || state.keyDraft.trim() === ''}
            onClick={() => { void controller.saveKey() }}
          >
            {t.save}
          </Button>
        </div>
        <span style={HINT}>
          {state.keyWritable ? t.keyHint : t.keyShadowed}
          {state.notice === 'saved' ? ` · ${t.saved}` : state.notice === 'failed' ? ` · ${t.failed}` : ''}
        </span>
      </div>

      <LibrarySelect
        label={t.workingLabel}
        hint={t.workingHint}
        value={state.workingLibrary}
        disabled={locked}
        onChange={value => { void controller.setField('workingLibrary', value) }}
      />
      <LibrarySelect
        label={t.idleLabel}
        hint={t.idleHint}
        value={state.idleLibrary}
        silenceLabel={t.silence}
        disabled={locked}
        onChange={value => { void controller.setField('idleLibrary', value) }}
      />

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={state.ambient}
          disabled={locked}
          onChange={event => { void controller.setField('ambient', event.target.checked) }}
        />
        <span style={LABEL}>{t.ambientLabel}</span>
      </label>
      <span style={HINT}>{t.ambientHint}</span>
      {state.status === 'unavailable'
        ? <p style={{ ...HINT, margin: '0.5rem 0 0' }}>{t.notExposed}</p>
        : !state.writable ? <p style={{ ...HINT, margin: '0.5rem 0 0' }}>{t.unavailable}</p> : null}
    </section>
  )
}
