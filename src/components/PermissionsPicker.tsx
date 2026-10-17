import React from 'react'
import { t } from '../i18n.js'
import { PERMISSION_PRESET_AUTO, permissionPresetDescription, permissionPresetLabel } from '../permissionPresetLabels.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'
import type { PermissionPresetOption } from '../dsh-adapter/channel.js'

/**
 * `/permission` sandbox-preset picker. The command itself is registered by
 * the harness side (dsh-sandbox-policy / dsh-base permission-presets row);
 * bare `/permission` opens this picker and Enter dispatches
 * `/permission <preset>` through the same external-command path a hand-typed
 * argument takes. The roster comes from the adapter snapshot so host plugins
 * can contribute additional preset identities without UI changes.
 *
 * DSH's experimental `auto` preset is tagged EXP, and picking it first shows
 * a session-scoped risk confirmation (`confirming`); Chat owns the keys.
 */
export function PermissionsPicker({
  options,
  focusIndex,
  currentValue,
  cwd,
  confirming = false,
  onPick,
  onConfirm,
  onCancelConfirm,
}: {
  options: readonly PermissionPresetOption[]
  focusIndex: number
  currentValue: string | undefined
  cwd: string
  /** Show the Auto review risk confirmation instead of the list. */
  confirming?: boolean
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
  /** Mouse confirm / back on the risk confirmation (fullscreen); the
   *  keyboard path stays Enter / Esc in Chat. */
  onConfirm?: () => void
  onCancelConfirm?: () => void
}): React.ReactNode {
  if (confirming) return <AutoReviewConfirm onConfirm={onConfirm} onCancel={onCancelConfirm} />
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('permission-picker-title')}
          </Text>
        </Box>
        <Select
          options={options.map(option => ({
            value: option.value,
            label: option.value === PERMISSION_PRESET_AUTO
              ? <>{permissionPresetLabel(option)} <Text color="warning">{t('permission-preset-exp-tag')}</Text></>
              : permissionPresetLabel(option),
            description: permissionPresetDescription(option),
          }))}
          focusIndex={focusIndex}
          selectedValue={currentValue}
          onPick={onPick ? index => onPick(index) : undefined}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
        <Text dimColor>
          {t('permission-root-hint', { cwd })}
        </Text>
      </Box>
    </Pane>
  )
}

const AUTO_CONFIRM_POINTS = [
  'permission-auto-confirm-session',
  'permission-auto-confirm-sandbox',
  'permission-auto-confirm-cost',
  'permission-auto-confirm-risk',
] as const

function AutoReviewConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm?: () => void
  onCancel?: () => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="warning" bold>
            {t('permission-auto-confirm-title')}
          </Text>
        </Box>
        {AUTO_CONFIRM_POINTS.map(key => (
          // Bullet column + shrinking body: wrapped lines hang under the text.
          <Box key={key}>
            <Text>· </Text>
            <Box flexShrink={1}>
              <Text>{t(key)}</Text>
            </Box>
          </Box>
        ))}
        {onConfirm !== undefined && onCancel !== undefined && (
          <Box marginTop={1}>
            <Select
              options={[
                { value: 'enable', label: t('permission-auto-confirm-enable') },
                { value: 'back', label: t('permission-auto-confirm-back') },
              ]}
              focusIndex={0}
              selectedValue={undefined}
              onPick={index => (index === 0 ? onConfirm() : onCancel())}
            />
          </Box>
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('permission-auto-confirm-actions')} />
      </Text>
    </Pane>
  )
}
