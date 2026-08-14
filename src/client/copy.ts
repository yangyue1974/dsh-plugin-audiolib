/**
 * Card copy. The plugin carries its own two dictionaries and picks by the
 * document language the shell already set, rather than registering a locale
 * namespace: one less service to depend on for six labels.
 */

/** Every string the card renders. */
export interface Copy {
  title: string
  description: string
  keyLabel: string
  keyHint: string
  keyConfigured: string
  keyMissing: string
  keyShadowed: string
  keyPlaceholder: string
  save: string
  saved: string
  failed: string
  workingLabel: string
  workingHint: string
  idleLabel: string
  idleHint: string
  silence: string
  ambientLabel: string
  ambientHint: string
  unavailable: string
  notExposed: string
}

const zh: Copy = {
  title: 'AudioLib 环境音轨',
  description: '智能体开始干活时放音乐，一首曲子永远播完才换——状态变化不打断正在播的曲子。',
  keyLabel: 'API 密钥',
  keyHint: '在 audiolib.ai 获取。密钥存进 DSH 的凭据库，不会写进任何配置文件。',
  keyConfigured: '已配置',
  keyMissing: '未配置',
  keyShadowed: '被环境变量占用，此处不可写',
  keyPlaceholder: 'alp_…',
  save: '保存',
  saved: '已保存',
  failed: '保存失败',
  workingLabel: '干活时的曲库',
  workingHint: '有对话在进行时播放。',
  idleLabel: '空闲时的曲库',
  idleHint: '所有对话结束后播放。',
  silence: '静音',
  ambientLabel: '跟随智能体状态',
  ambientHint: '关掉后音乐只由模型的 music_play 控制。',
  unavailable: '当前连接不提供插件设置，无法在此修改。',
  notExposed: 'DSH 目前只把内置插件的设置下发到浏览器（dsh-host-apiproxy 里的白名单），第三方插件还不行。曲库暂时在 profile 的 cordis.patch.yml 里改；密钥不受此限制，上面就能填。',
}

const en: Copy = {
  title: 'AudioLib soundtrack',
  description: 'Music while the agent works. A track always finishes — a state change never cuts one off.',
  keyLabel: 'API key',
  keyHint: 'Get one at audiolib.ai. Stored in the DSH credential store, never in a config file.',
  keyConfigured: 'configured',
  keyMissing: 'not configured',
  keyShadowed: 'supplied by the environment, not writable here',
  keyPlaceholder: 'alp_…',
  save: 'Save',
  saved: 'Saved',
  failed: 'Save failed',
  workingLabel: 'Working library',
  workingHint: 'Plays while a session has an open turn.',
  idleLabel: 'Idle library',
  idleHint: 'Plays once every turn has closed.',
  silence: 'Silence',
  ambientLabel: 'Follow agent state',
  ambientHint: 'Off leaves the music entirely to the model\'s music_play.',
  unavailable: 'This connection serves no plugin settings, so nothing can be changed here.',
  notExposed: 'DSH serves only built-in plugins\' settings to the browser (an allowlist in dsh-host-apiproxy), so these are read-only for now. Set the libraries in your profile\'s cordis.patch.yml; the key above is unaffected.',
}

/**
 * Pick the dictionary for the shell's current language.
 *
 * @returns the Chinese copy under a `zh*` document language, English otherwise.
 */
export function copy(): Copy {
  const language = typeof document === 'undefined' ? '' : document.documentElement.lang
  return language.toLowerCase().startsWith('zh') ? zh : en
}
