import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { cleanRenderText, NOTICE_CELLS } from '../channel/sanitize.js'
import type { PluginManageStep, PluginManageTarget } from '../dsh-adapter/plugin-manage.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { Pane } from './design-system/Pane.js'

/** Foreign text on its way to the screen: control sequences stripped, bounded. */
const clean = (value: string): string => cleanRenderText(value, NOTICE_CELLS)

/**
 * The target's identity is the subject of the question, and it is foreign text
 * like everything else here: a package name and a module specifier come from
 * somebody else's manifest, so either can carry newlines or thousands of cells.
 * Bounded to what a line can show — at 50 columns an unbounded name buries the
 * title and the key hints, which are exactly what the person needs to answer.
 */
const TARGET_CELLS = 80

/**
 * `/plugin remove | enable | disable`: the pane that asks what the flow cannot
 * answer on its own (Stage C-5).
 *
 * The flow (`dsh-adapter/plugin-manage.ts`) writes every line of the action into
 * the transcript — what it resolved, why it refused, what the service answered —
 * so this pane only carries the one thing a person must decide before the write.
 * Unlike the install pane there is no progress, no cancellation and no retry:
 * each action is a single call that settles once.
 *
 * Presentational only, and the same three parts as its install sibling
 * (`PluginInstallPane`): the pane, the facts that make the question answerable,
 * and the key hints. Keys are handled in Chat (Enter answers, Esc closes).
 */
export function PluginManagePane({ step, busy }: { step: PluginManageStep; busy: boolean }): React.ReactNode {
  if (busy) {
    // A write is in flight. Esc closes the pane and the write finishes anyway —
    // the service has no cancellation for these three, and saying "cancelling"
    // here would be a promise nobody can keep.
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Text color="remember" bold>{t('plugins-manage-pane-title')}</Text>
          <Box marginTop={1}>
            <LoadingState message={t('plugins-manage-working')} />
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-manage-key-busy')} /></Text>
      </Pane>
    )
  }
  if (step.kind === 'confirm') {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>{t('plugins-manage-pane-title')}</Text>
          </Box>
          <Text>{t('plugins-manage-configure', {
            action: t(actionKeyOf(step.target)),
            target: describe(step.target),
          })}</Text>
          <Box marginTop={1} flexDirection="column">
            {step.question.kind === 'remove' && (
              <Text>{t('plugins-manage-remove-facts', {
                rows: String(step.target.kind === 'bundle' ? step.target.rows : 0),
                overrides: String(step.target.kind === 'bundle' ? step.target.overrides : 0),
              })}</Text>
            )}
            {step.question.kind === 'trust' && <Text>{t('plugins-manage-trust-facts')}</Text>}
            {step.question.kind === 'host-row' && <Text>{t('plugins-manage-host-row-facts')}</Text>}
            {step.question.kind === 'team-active' && (
              <>
                {step.question.members > 0 && <Text>{t('plugins-manage-team-active-facts', { members: String(step.question.members) })}</Text>}
                {step.question.unseen > 0 && <Text>{t('plugins-manage-team-unseen-facts', { members: String(step.question.unseen) })}</Text>}
                <Text>{t('plugins-manage-team-active-stop')}</Text>
              </>
            )}
          </Box>
        </Box>
        <Text dimColor italic><HintLine text={t('plugins-manage-key-confirm')} /></Text>
      </Pane>
    )
  }
  // `done` never renders: its lines are already in the transcript, so Chat
  // closes the pane instead of leaving an empty box behind.
  return null
}

/** Which verb the title asks about. */
function actionKeyOf(target: PluginManageTarget): 'plugins-manage-action-remove' | 'plugins-manage-action-enable' | 'plugins-manage-action-disable' {
  return target.action === 'remove'
    ? 'plugins-manage-action-remove'
    : target.action === 'enable' ? 'plugins-manage-action-enable' : 'plugins-manage-action-disable'
}

/**
 * The target as one bounded cell. A bundle is named by its package name; a row
 * by the module it loads, which is what the report listed it as and what a
 * person typed to get here.
 */
function describe(target: PluginManageTarget): string {
  if (target.kind === 'bundle') {
    const version = target.version === undefined ? '' : `@${target.version}`
    return cleanRenderText(`${target.name}${version}`, TARGET_CELLS)
  }
  return cleanRenderText(target.moduleName, TARGET_CELLS)
}
