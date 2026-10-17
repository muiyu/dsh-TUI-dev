/**
 * Display text for permission preset roster entries. The three stock presets
 * and DSH's experimental `auto` preset are localized here; the registry hands
 * `auto` out under its bare reserved name with no description, so the TUI
 * owns its label the same way it owns the stock ones. Every other preset keeps
 * the registry's own name/description. Backend-neutral: i18n only.
 */
import { t, type I18nKey } from './i18n.js'

/** DSH's reserved, session-only experimental preset (dsh-experimental-auto-review). */
export const PERMISSION_PRESET_AUTO = 'auto'

interface PresetOptionLike {
  readonly value: string
  readonly name: string
  readonly description?: string
}

const LOCALIZED: Readonly<Record<string, { label: I18nKey; description: I18nKey }>> = {
  'read-only': { label: 'permission-preset-readonly', description: 'permission-preset-readonly-desc' },
  'workspace-write': { label: 'permission-preset-workspace-write', description: 'permission-preset-workspace-write-desc' },
  'danger-full-access': { label: 'permission-preset-full-access', description: 'permission-preset-full-access-desc' },
  [PERMISSION_PRESET_AUTO]: { label: 'permission-preset-auto', description: 'permission-preset-auto-desc' },
}

/** The i18n keys for one option, or undefined when the registry's text stands.
 *  `auto` is localized only while the registry still names it bare. */
export function permissionPresetKeys(option: PresetOptionLike): { label: I18nKey; description: I18nKey } | undefined {
  if (!Object.hasOwn(LOCALIZED, option.value)) return undefined
  if (option.value === PERMISSION_PRESET_AUTO && option.name !== PERMISSION_PRESET_AUTO) return undefined
  return LOCALIZED[option.value]
}

export function permissionPresetLabel(option: PresetOptionLike): string {
  const keys = permissionPresetKeys(option)
  return keys === undefined ? option.name : t(keys.label)
}

export function permissionPresetDescription(option: PresetOptionLike): string {
  const keys = permissionPresetKeys(option)
  return keys === undefined ? option.description ?? option.name : t(keys.description)
}
