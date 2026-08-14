/**
 * Browser half: the AudioLib card in Settings → Plugins.
 *
 * DSH renders no generic settings form — a plugin that wants a configuration
 * surface ships one. This half owns the key control and the library pickers;
 * the host half owns the soundtrack and never sees this code.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settings shell's ctx.settingsScope merge and the slot map entry
// this card registers into. Cross-plugin collaboration goes through services.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { AudiolibCard } from './AudiolibCard.tsx'
import { CardController, type AudiolibSettings } from './controller.ts'

/** Settings namespace registered by the host half. Spelled, not imported. */
const NAMESPACE = 'audiolib'

/** Required browser services. */
export const inject = ['slots', 'connection', 'settingsScope']

/**
 * Mount the card.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new CardController(
    ctx.settingsScope.bind<AudiolibSettings>({ namespace: NAMESPACE }),
    api,
  )

  // `inject` waits for the plugin-configuration tab to declare the slot: a
  // deployment without that surface simply renders no card.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'audiolib',
    inject: () => ({ controller }),
  }, AudiolibCard))
}
