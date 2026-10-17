/**
 * Agent Teams on and off at run time (issue #1241, see
 * docs/agent-teams-design.md「开关机制」).
 *
 * The switch is the upstream team bundle itself: `/team on|off` selects or
 * drops its layer through the host plugin manager (the same write
 * `/plugin enable|disable` makes), which persists to the profile and, with
 * `hmr` mounted, applies at once. The team tool plugin installs into every
 * live root Agent and uninstalls on disposal, so the sessions already running
 * follow. What stays here is the one decision that cannot live in a preset —
 * which legacy delegation tools a request carries — and the `/team` command.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { t } from '../i18n.js'
import { resolveDshProfileName } from '../update.js'
import { installedKernelVersion, UPSTREAM_VALIDATED_VERSION } from './contract.js'
import { createPluginManageFlow, type PluginManageFlow, type PluginManageSink, type TeamActiveMembers } from './plugin-manage.js'
import { pluginManagerOf } from './plugin-manager.js'
import { cell } from './plugins-info.js'
import { TEAM_BUNDLE } from './team-roster.js'
import { TEAM_SPAWN_TOOL } from './team-tools.js'

/**
 * The DSH lines whose team bundle this adapter reads: the validated line,
 * 0.2.1-alpha.5 (its team packages differ from rc.2 only in version) and the
 * 0.2.0 compat line (compat/agent-team-0.2.0.ts; rc.1 ships the same team
 * code as rc.2). Other lines' team projection may lack the `wire` view
 * `channel.team` needs.
 */
const TEAM_LINES: ReadonlySet<string> = new Set([UPSTREAM_VALIDATED_VERSION, '0.2.1-alpha.5', '0.2.0-rc.1', '0.2.0-rc.2'])

/**
 * The install spec the hints name. The team packages ship in lockstep with
 * DSH and pin their DSH peers exactly, so only the bundle of the running
 * kernel's own version installs into this host (npm `latest` and `next`
 * both name other lines).
 * @param kernel - The running DSH version; unknown falls back to the validated line.
 * @returns `<bundle>@<version>`, or undefined on a known kernel that is not a
 *   team line: no bundle installs there, DSH has to move to a team line first.
 */
export function teamBundleSpec(kernel: string | undefined): string | undefined {
  if (kernel === undefined) return `${TEAM_BUNDLE}@${UPSTREAM_VALIDATED_VERSION}`
  return TEAM_LINES.has(kernel) ? `${TEAM_BUNDLE}@${kernel}` : undefined
}

/** The install hints that name the bundle spec. */
type TeamInstallHint = 'team-cmd-not-installed' | 'team-cmd-no-manager'

/**
 * Legacy delegation tools that `spawn_teammate` replaces. The four control
 * tools the team shares names with (`send_message`, `list_agents`,
 * `interrupt_agent`, `wait_agent`) need no entry: the team copies live in the
 * Agent's own scope and shadow the preset's, in the assembly and at execution.
 */
const TEAM_REPLACED_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

/**
 * Keep one delegation tool set per request. Presets keep their legacy rows,
 * so whether the team replaces them is decided where the tools are known: an
 * assembly carrying `spawn_teammate` drops `subagent` / `subagent_fork`. This
 * follows a bundle toggled at run time into the sessions already joined (a
 * preset revision cannot), and a team service that never activated leaves the
 * legacy tools in place. The agent loop diffs these final tools against the
 * logged request header, so the model is told about each swap.
 * @param assembly - Fully assembled prompt inputs for one model request.
 * @returns The original assembly, or a copy without the replaced tools.
 */
export function filterTeamReplacedTools(assembly: PromptAssembly): PromptAssembly {
  if (!assembly.tools.some(tool => tool.name === TEAM_SPAWN_TOOL)) return assembly
  if (!assembly.tools.some(tool => TEAM_REPLACED_TOOLS.has(tool.name))) return assembly
  return { ...assembly, tools: assembly.tools.filter(tool => !TEAM_REPLACED_TOOLS.has(tool.name)) }
}

/** What `/team` was asked. */
export type TeamCommand =
  | { readonly kind: 'on' | 'off' | 'status' }
  | { readonly kind: 'unknown'; readonly sub: string }

export function parseTeamArgs(args: string): TeamCommand {
  const sub = args.trim().split(/\s+/)[0] ?? ''
  if (sub === '' || sub === 'status') return { kind: 'status' }
  if (sub === 'on' || sub === 'off') return { kind: sub }
  return { kind: 'unknown', sub }
}

/** What the screen supplies: the plugin flow's sink, plus the team's live state. */
export interface TeamCommandSink extends PluginManageSink {
  /** Teammates of the bound session, how many are running or provisioning, and how many may be running. */
  readonly members: () => { readonly total: number } & TeamActiveMembers
}

/** What one `/team` input turned into. */
export type TeamCommandOutcome =
  | { readonly kind: 'flow'; readonly flow: PluginManageFlow }
  | { readonly kind: 'lines'; readonly lines: Promise<readonly string[]> }

/**
 * Wire `/team` to the running composition.
 * @param ctx - Host context of the composition root.
 * @param options - The profile a manual route names, and the running host's
 *   DSH version (this package's entry; otherwise the installed one is read).
 * @returns the command entry the screen calls.
 */
export function createTeamCommandEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined; readonly kernelVersion?: string | undefined } = {},
): (args: string, sink: TeamCommandSink) => TeamCommandOutcome {
  const profile = (): string => options.profileName ?? resolveDshProfileName() ?? 'dsh-tui'
  // The version does not change in a process: read it once, on the first hint.
  let kernel: { readonly version: string | undefined } | undefined
  const hint = (key: TeamInstallHint): string => {
    kernel ??= { version: options.kernelVersion ?? installedKernelVersion() }
    const spec = teamBundleSpec(kernel.version)
    return spec === undefined
      ? t('team-cmd-kernel-unsupported', { version: cell(kernel.version ?? ''), lines: [...TEAM_LINES].join(' / ') })
      : t(key, { profile: cell(profile()), bundle: spec })
  }
  return (args, sink) => {
    const parsed = parseTeamArgs(args)
    if (parsed.kind === 'unknown') {
      return { kind: 'lines', lines: Promise.resolve([t('team-cmd-usage', { sub: cell(parsed.sub) })]) }
    }
    const manager = pluginManagerOf(ctx)
    if (parsed.kind === 'status') return { kind: 'lines', lines: teamStatusLines(ctx, sink, hint) }
    if (manager === undefined) {
      return { kind: 'lines', lines: Promise.resolve([hint('team-cmd-no-manager')]) }
    }
    const flow = createPluginManageFlow({
      manager,
      action: parsed.kind === 'on' ? 'enable' : 'disable',
      target: TEAM_BUNDLE,
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
      profileName: profile(),
      teamActiveMembers: sink.members,
    })
    // Without the package the lifecycle flow would answer with its generic
    // "no such target" and every addressable name. Say what is missing
    // instead: `on` with how to install it (installing stays an explicit
    // `/plugin install`, it runs third-party code behind its own trust step),
    // `off` that there is nothing to switch off.
    const bindingAtStart = sink.binding()
    return {
      kind: 'flow',
      flow: {
        ...flow,
        async begin() {
          let installed = true
          let enabled = false
          try {
            const entry = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
            installed = entry !== undefined
            enabled = entry?.enabled === true
          } catch {
            // A failing read is the flow's to report: it reads the same list.
          }
          if (parsed.kind === 'off') {
            if (installed) return flow.begin()
            if (sink.binding() === bindingAtStart) sink.onLines([t('team-cmd-off-not-installed')])
            return { kind: 'done' }
          }
          // Already selected: no trust question about code already running,
          // no no-op write. Say whether it is actually running.
          if (installed && !enabled) return flow.begin()
          if (sink.binding() === bindingAtStart) {
            sink.onLines(!installed
              ? [hint('team-cmd-not-installed')]
              : [t('team-cmd-already-on'), ...ctx.get('agentTeams', false) === undefined ? [t('team-cmd-pending-on')] : []])
          }
          return { kind: 'done' }
        },
      },
    }
  }
}

/**
 * `/team` and `/team status`: whether the profile selects the bundle, whether
 * the team service is running in this process, and the bound session's team.
 */
async function teamStatusLines(ctx: Context, sink: TeamCommandSink, hint: (key: TeamInstallHint) => string): Promise<readonly string[]> {
  const manager = pluginManagerOf(ctx)
  const service = ctx.get('agentTeams', false) !== undefined
  const lines: string[] = []
  if (manager === undefined) {
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    lines.push(hint('team-cmd-no-manager'))
  } else {
    let selected: boolean | undefined
    let installed = false
    try {
      const bundle = (await manager.listBundles()).find(candidate => candidate.name === TEAM_BUNDLE)
      installed = bundle !== undefined
      selected = bundle?.enabled
    } catch (error) {
      lines.push(t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) }))
    }
    if (selected !== undefined || installed) {
      lines.push(t('team-cmd-bundle', { state: t(selected === true ? 'team-cmd-on' : 'team-cmd-off') }))
    } else if (lines.length === 0) {
      lines.push(hint('team-cmd-not-installed'))
    }
    lines.push(t('team-cmd-service', { state: t(service ? 'team-cmd-running' : 'team-cmd-stopped') }))
    // The profile says on but nothing runs (a startup-only profile, or the
    // service failed to activate), or the reverse: say which one wins now.
    if (selected === true && !service) lines.push(t('team-cmd-pending-on'))
    if (selected === false && service) lines.push(t('team-cmd-pending-off'))
  }
  const { total, active, unseen } = sink.members()
  lines.push(total === 0
    ? t('team-cmd-no-members')
    : t(unseen === 0 ? 'team-cmd-members' : 'team-cmd-members-unseen', { total: String(total), active: String(active), unseen: String(unseen) }))
  return lines
}
