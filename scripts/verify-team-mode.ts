/**
 * Agent Teams on and off at run time (issue #1241, docs/agent-teams-design.md
 * 「开关机制」): the per-assembly choice of delegation tools, the team store
 * following the service across a plugin-manager change, and `/team` — status,
 * on / off through the lifecycle flow, and the confirmation that disabling
 * the team bundle asks while teammates are active (from `/team off` and from
 * `/plugin disable` alike). The plugin manager and the registry are fakes; the
 * live toggle itself was measured against the real 0.2.0-rc.2 bundle (see the
 * design doc).
 *
 * Run: node --import tsx/esm scripts/verify-team-mode.ts
 */
process.env.DSH_TUI_LANG = 'en'
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }, assertModule] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
  import('node:assert/strict'),
])
const assert = assertModule.default
const dataDir = mkdtempSync(join(tmpdir(), 'verify-team-mode-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [teamMode, roster, manage, { UPSTREAM_VALIDATED_VERSION }] = await Promise.all([
  import('../src/dsh-adapter/team-mode.js'),
  import('../src/dsh-adapter/team-roster.js'),
  import('../src/dsh-adapter/plugin-manage.js'),
  import('../src/dsh-adapter/contract.js'),
])
const { createTeamCommandEntry, filterTeamReplacedTools, parseTeamArgs, teamBundleSpec } = teamMode
const { createTeamRosterStore, TEAM_BUNDLE, TEAM_PROJECTION_KEY } = roster
const { createPluginManageEntry } = manage
/** The validated line's bundle spec, escaped for a RegExp. */
const VALIDATED_SPEC = `${TEAM_BUNDLE}@${UPSTREAM_VALIDATED_VERSION}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
type PluginManagerView = import('../src/dsh-adapter/plugin-manager.js').PluginManagerView
type BundleInfo = Awaited<ReturnType<PluginManagerView['listBundles']>>[number]
type PluginManageStep = import('../src/dsh-adapter/plugin-manage.js').PluginManageStep

try {
  // ── delegation tools per assembly ──────────────────────────────────────
  {
    const tool = (name: string) => ({ name })
    const assembly = (...names: string[]) => ({ sections: [], contexts: [], variables: {}, tools: names.map(tool) }) as never
    const on = assembly('bash', 'subagent', 'subagent_fork', 'spawn_teammate', 'send_message', 'list_agents')
    assert.deepEqual(filterTeamReplacedTools(on).tools.map((t: { name: string }) => t.name),
      ['bash', 'spawn_teammate', 'send_message', 'list_agents'],
      'with spawn_teammate the legacy spawners leave; the shared-name controls are the shadowing team copies')
    const off = assembly('bash', 'subagent', 'subagent_fork', 'send_message')
    assert.equal(filterTeamReplacedTools(off), off, 'without the team tools the assembly is untouched')
    const teamOnly = assembly('bash', 'spawn_teammate')
    assert.equal(filterTeamReplacedTools(teamOnly), teamOnly, 'nothing to drop keeps the reference')
    console.log('PASS delegation tools follow spawn_teammate per assembly')
  }

  // ── team store follows the service across a plugin-manager change ──────
  {
    const LEAD = 'lead-1'
    const team = {
      members: [{ id: LEAD, name: 'lead', role: 'lead', phase: 'active' }, { id: 'm1', name: 'builder', role: 'teammate', phase: 'active' }],
      tasks: [],
    }
    let mounted = true
    let changed: (() => void) | undefined
    const ctx = {
      get: (name: string) => (name === 'agentTeams' ? (mounted ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      logger: { warn: () => undefined },
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({
          sessionProjections: {
            onChanged: () => () => undefined,
            // An unregistered definition is absent from the snapshot.
            snapshot: () => ({ values: mounted ? { [TEAM_PROJECTION_KEY]: team } : {} }),
          },
          effect: () => undefined,
        })
      },
      on(name: string, listener: () => void) {
        if (name === 'plugin-manager/changed') changed = listener
        return () => undefined
      },
    }
    const store = createTeamRosterStore(ctx as never)
    let emits = 0
    store.subscribe(() => { emits++ })
    store.seed({ id: LEAD })
    assert.equal(store.read()?.members.length, 2)
    assert.ok(changed !== undefined, 'the store listens for plugin-manager changes')
    mounted = false
    changed!()
    assert.equal(store.read(), undefined, 'switched off: the view clears')
    assert.equal(emits, 2)
    mounted = true
    changed!()
    assert.equal(store.read()?.members[1]?.name, 'builder', 'switched on again: the Lead team comes back')
    assert.equal(emits, 3)
    console.log('PASS team store clears and comes back on plugin-manager/changed')

    // The service can leave while the projection definition is still
    // registered, the host then handing back the same cached value: the
    // narrow (which checks the service) must still run on a reseed.
    let service = true
    let notify: (() => void) | undefined
    const sameRef = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (service ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({ sessionProjections: { onChanged: () => () => undefined, snapshot: () => ({ values: { [TEAM_PROJECTION_KEY]: team } }) }, effect: () => undefined })
      },
      on(name: string, listener: () => void) {
        if (name === 'plugin-manager/changed') notify = listener
        return () => undefined
      },
    } as never)
    sameRef.seed({ id: LEAD })
    assert.equal(sameRef.read()?.members.length, 2)
    service = false
    notify!()
    assert.equal(sameRef.read(), undefined, 'the service gone with the definition still registered: the view clears')
    service = true
    notify!()
    assert.equal(sameRef.read()?.members.length, 2, 'and comes back on the same cached value')
    console.log('PASS team store re-narrows an unchanged projection value on plugin-manager/changed')

    // A service change the plugin manager never announces (an HMR-applied
    // CLI edit, a late activation) is followed through `internal/service`.
    let present = true
    let serviceChanged: ((name: unknown) => void) | undefined
    const quiet = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (present ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({ sessionProjections: { onChanged: () => () => undefined, snapshot: () => ({ values: { [TEAM_PROJECTION_KEY]: team } }) }, effect: () => undefined })
      },
      on(name: string, listener: (name: unknown) => void) {
        if (name === 'internal/service') serviceChanged = listener
        return () => undefined
      },
    } as never)
    quiet.seed({ id: LEAD })
    assert.equal(quiet.read()?.members.length, 2)
    present = false
    serviceChanged!('agents')
    assert.equal(quiet.read()?.members.length, 2, 'another service changing reads nothing again')
    serviceChanged!('agentTeams')
    assert.equal(quiet.read(), undefined, 'the team service gone without a manager event: the view clears')
    present = true
    serviceChanged!('agentTeams')
    assert.equal(quiet.read()?.members.length, 2, 'and comes back with it')
    console.log('PASS team store follows the agentTeams service through internal/service')

    // A teammate whose Lead is not live has no snapshot to read: a reseed
    // still narrows the value it holds, so a stopped service clears it.
    let up = true
    let feed: ((session: unknown, key: string, value: unknown) => void) | undefined
    let onService: ((name: unknown) => void) | undefined
    const orphan = createTeamRosterStore({
      ...ctx,
      get: (name: string) => (name === 'agentTeams' ? (up ? {} : undefined) : name === 'agents' ? { list: () => [] } : undefined),
      inject(_deps: unknown, callback: (ctx: unknown) => void) {
        callback({
          sessionProjections: {
            onChanged: (listener: typeof feed) => { feed = listener; return () => undefined },
            snapshot: () => { throw new Error('no snapshot for a session that is not live') },
          },
          effect: () => undefined,
        })
      },
      on(name: string, listener: (name: unknown) => void) {
        if (name === 'internal/service') onService = listener
        return () => undefined
      },
    } as never)
    orphan.seed({ id: 'm1', header: { origin: 'subagent', parentSession: LEAD } })
    assert.equal(orphan.watchedId, LEAD)
    feed!({ id: LEAD }, TEAM_PROJECTION_KEY, team)
    assert.equal(orphan.read()?.members.length, 2, 'the Lead value arrives on the feed')
    up = false
    onService!('agentTeams')
    assert.equal(orphan.read(), undefined, 'no snapshot to read: the held value is narrowed again and clears')
    up = true
    onService!('agentTeams')
    assert.equal(orphan.read()?.members.length, 2, 'and comes back from the same held value')
    console.log('PASS team store re-narrows the held value when the watched Lead has no snapshot')
  }

  // ── /team ──────────────────────────────────────────────────────────────
  // The bundle ships in lockstep with DSH: the hint names the running kernel's version on a team line.
  assert.equal(teamBundleSpec('0.2.0-rc.2'), `${TEAM_BUNDLE}@0.2.0-rc.2`)
  assert.equal(teamBundleSpec('0.2.0-rc.1'), `${TEAM_BUNDLE}@0.2.0-rc.1`, 'rc.1 ships the same team code as rc.2')
  assert.equal(teamBundleSpec(undefined), `${TEAM_BUNDLE}@${UPSTREAM_VALIDATED_VERSION}`, 'an unknown kernel falls back to the validated line')
  assert.equal(teamBundleSpec('0.2.1-alpha.5'), `${TEAM_BUNDLE}@0.2.1-alpha.5`, 'alpha.5 ships the same team code as rc.2')
  assert.equal(teamBundleSpec('0.1.5-alpha.2'), undefined, 'a line without a readable team bundle names no bundle')
  assert.deepEqual(parseTeamArgs(''), { kind: 'status' })
  assert.deepEqual(parseTeamArgs(' status '), { kind: 'status' })
  assert.deepEqual(parseTeamArgs('on'), { kind: 'on' })
  assert.deepEqual(parseTeamArgs('off now'), { kind: 'off' })
  assert.deepEqual(parseTeamArgs('toggle'), { kind: 'unknown', sub: 'toggle' })

  const teamBundle = (enabled: boolean): BundleInfo => ({
    name: TEAM_BUNDLE, version: UPSTREAM_VALIDATED_VERSION, enabled, installed: true, optional: false, removable: true, rows: [], overrides: [],
  }) as BundleInfo
  function rig(options: { bundles?: BundleInfo[]; service?: boolean; manager?: boolean } = {}) {
    const calls: string[] = []
    const manager = {
      listBundles: () => Promise.resolve(options.bundles ?? [teamBundle(true)]),
      listPlugins: () => Promise.resolve([]),
      setBundleEnabled: (name: string, enabled: boolean) => {
        calls.push(`setBundleEnabled:${name}:${String(enabled)}`)
        return Promise.resolve({ changed: true, application: 'applied', stage: 'enable', target: name, enabled })
      },
    } as unknown as PluginManagerView
    const ctx = {
      get: (name: string) => (name === 'pluginManager' ? (options.manager === false ? undefined : manager)
        : name === 'agentTeams' ? (options.service === false ? undefined : {}) : undefined),
    }
    return { ctx, calls, manager }
  }
  const sink = (members: { total: number; active: number; unseen?: number }, lines: string[]) => ({
    binding: () => 1,
    busy: () => false,
    onLines: (next: readonly string[]) => { lines.push(...next) },
    members: () => ({ unseen: 0, ...members }),
  })
  const linesOf = async (outcome: ReturnType<ReturnType<typeof createTeamCommandEntry>>): Promise<string[]> => {
    assert.equal(outcome.kind, 'lines')
    return outcome.kind === 'lines' ? [...await outcome.lines] : []
  }

  {
    const { ctx } = rig()
    const entry = createTeamCommandEntry(ctx as never, { profileName: 'dsh-tui' })
    const status = (await linesOf(entry('', sink({ total: 2, active: 1 }, [])))).join('\n')
    assert.match(status, /Team bundle: on/)
    assert.match(status, /Team service: running/)
    assert.match(status, /Teammates in this session: 2, 1 running or provisioning/)
    const pending = (await linesOf(createTeamCommandEntry(rig({ service: false }).ctx as never, { profileName: 'dsh-tui' })('status', sink({ total: 0, active: 0 }, [])))).join('\n')
    assert.match(pending, /profile has the team on but the service is not running/)
    assert.match(pending, /No teammates in this session/)
    const missing = (await linesOf(createTeamCommandEntry(rig({ bundles: [], service: false }).ctx as never, { profileName: 'dsh-tui' })('', sink({ total: 0, active: 0 }, [])))).join('\n')
    const NOT_INSTALLED = new RegExp(`not installed\\. Install it here with /plugin install ${VALIDATED_SPEC} .*dsh plugin --profile dsh-tui add ${VALIDATED_SPEC}`)
    assert.match(missing, NOT_INSTALLED)
    // The entry passes the running host's version; it wins over this package's own resolution.
    const hosted = (await linesOf(createTeamCommandEntry(rig({ bundles: [], service: false }).ctx as never, { profileName: 'dsh-tui', kernelVersion: '0.2.0-rc.2' })('', sink({ total: 0, active: 0 }, [])))).join('\n')
    assert.match(hosted, /\/plugin install @deepseek-ai\/dsh-experimental-agent-team-profile@0\.2\.0-rc\.2 /)
    // A kernel no team bundle installs into is told to switch lines, not handed a bundle it cannot load.
    const older = (await linesOf(createTeamCommandEntry(rig({ bundles: [], service: false }).ctx as never, { profileName: 'dsh-tui', kernelVersion: '0.1.5-alpha.2' })('', sink({ total: 0, active: 0 }, [])))).join('\n')
    assert.match(older, /The running DSH 0\.1\.5-alpha\.2 has no team bundle this app can read: switch DSH to one of/)
    assert.doesNotMatch(older, /plugin install/, 'no install command for a kernel it cannot serve')
    const unmanaged = createTeamCommandEntry(rig({ manager: false }).ctx as never, { profileName: 'dsh-tui' })
    assert.match((await linesOf(unmanaged('off', sink({ total: 0, active: 0 }, [])))).join('\n'), /no profile plugin service/)
    assert.match((await linesOf(entry('toggle', sink({ total: 0, active: 0 }, [])))).join('\n'), /Usage: \/team/)
    console.log('PASS /team status (bundle, service, pending restart, not installed, no manager, usage)')
  }

  {
    // on: the enable flow asks its trust question, then writes.
    const { ctx, calls } = rig({ bundles: [teamBundle(false)] })
    const lines: string[] = []
    const outcome = createTeamCommandEntry(ctx as never, { profileName: 'dsh-tui' })('on', sink({ total: 0, active: 0 }, lines))
    assert.equal(outcome.kind, 'flow')
    if (outcome.kind !== 'flow') throw new Error('unreachable')
    const asked: PluginManageStep = await outcome.flow.begin()
    assert.equal(asked.kind === 'confirm' && asked.question.kind, 'trust')
    await outcome.flow.confirm()
    assert.deepEqual(calls, [`setBundleEnabled:${TEAM_BUNDLE}:true`])
    assert.ok(lines.some(line => line.includes(TEAM_BUNDLE)), lines.join(' | '))
  }
  {
    // on with the bundle already selected: no trust question, no write.
    for (const service of [true, false]) {
      const { ctx, calls } = rig({ bundles: [teamBundle(true)], service })
      const lines: string[] = []
      const outcome = createTeamCommandEntry(ctx as never, { profileName: 'dsh-tui' })('on', sink({ total: 0, active: 0 }, lines))
      if (outcome.kind !== 'flow') throw new Error('expected a flow')
      assert.equal((await outcome.flow.begin()).kind, 'done')
      assert.deepEqual(calls, [])
      assert.match(lines.join('\n'), /already on/)
      assert.equal(/service is not running/.test(lines.join('\n')), !service, lines.join(' | '))
    }
  }
  {
    // on without the package: the install hint, not the generic "no such target", and nothing written.
    const { ctx, calls } = rig({ bundles: [{ ...teamBundle(true), name: '@deepseek-ai/dsh-base' }] })
    const lines: string[] = []
    const outcome = createTeamCommandEntry(ctx as never, { profileName: 'dsh-tui' })('on', sink({ total: 0, active: 0 }, lines))
    if (outcome.kind !== 'flow') throw new Error('expected a flow')
    assert.equal((await outcome.flow.begin()).kind, 'done')
    assert.equal(lines.length, 1, lines.join(' | '))
    assert.match(lines[0]!, new RegExp(`not installed\\. Install it here with /plugin install ${VALIDATED_SPEC}`))
    assert.doesNotMatch(lines[0]!, /No such target|dsh-base/, 'no list of every addressable name')
    assert.deepEqual(calls, [])
  }
  {
    // off without the package: nothing to switch off, not the generic "no such target".
    const { ctx, calls } = rig({ bundles: [{ ...teamBundle(true), name: '@deepseek-ai/dsh-base' }] })
    const lines: string[] = []
    const outcome = createTeamCommandEntry(ctx as never, { profileName: 'dsh-tui' })('off', sink({ total: 0, active: 0 }, lines))
    if (outcome.kind !== 'flow') throw new Error('expected a flow')
    assert.equal((await outcome.flow.begin()).kind, 'done')
    assert.deepEqual(lines, ['The team bundle is not installed, so the team is already off; nothing to change.'])
    assert.deepEqual(calls, [])
  }
  {
    // off with nobody active writes straight away; with active members it asks first.
    const idle = rig()
    const quiet = createTeamCommandEntry(idle.ctx as never, { profileName: 'dsh-tui' })('off', sink({ total: 1, active: 0 }, []))
    if (quiet.kind !== 'flow') throw new Error('expected a flow')
    assert.equal((await quiet.flow.begin()).kind, 'done')
    assert.deepEqual(idle.calls, [`setBundleEnabled:${TEAM_BUNDLE}:false`])

    const busy = rig()
    const loud = createTeamCommandEntry(busy.ctx as never, { profileName: 'dsh-tui' })('off', sink({ total: 3, active: 2 }, []))
    if (loud.kind !== 'flow') throw new Error('expected a flow')
    const step = await loud.flow.begin()
    assert.deepEqual(step.kind === 'confirm' ? step.question : undefined, { kind: 'team-active', members: 2, unseen: 0 })
    assert.deepEqual(busy.calls, [], 'nothing is written before the answer')
    await loud.flow.confirm()
    assert.deepEqual(busy.calls, [`setBundleEnabled:${TEAM_BUNDLE}:false`])
    // From a teammate: siblings that may be running still ask first.
    const unseen = rig()
    const guarded = createTeamCommandEntry(unseen.ctx as never, { profileName: 'dsh-tui' })('off', sink({ total: 2, active: 0, unseen: 1 }, []))
    if (guarded.kind !== 'flow') throw new Error('expected a flow')
    const asked = await guarded.flow.begin()
    assert.deepEqual(asked.kind === 'confirm' ? asked.question : undefined, { kind: 'team-active', members: 0, unseen: 1 })
    assert.deepEqual(unseen.calls, [], 'nothing is written before the answer')
    const status = (await linesOf(createTeamCommandEntry(rig().ctx as never, { profileName: 'dsh-tui' })('', sink({ total: 2, active: 0, unseen: 1 }, [])))).join('\n')
    assert.match(status, /Teammates in this session: 2, 0 running or provisioning, 1 may be running \(not visible from a teammate\)/)
  }
  {
    // `/plugin disable <team bundle>` asks the same question; another bundle does not.
    const { manager } = rig({ bundles: [teamBundle(true), { ...teamBundle(true), name: 'other-bundle' }] })
    const plugin = createPluginManageEntry({ get: (name: string) => (name === 'pluginManager' ? manager : undefined) } as never, { profileName: 'dsh-tui' })
    const pluginSink = { binding: () => 1, busy: () => false, onLines: () => undefined, teamActiveMembers: () => ({ active: 1, unseen: 0 }) }
    const team = plugin(`disable ${TEAM_BUNDLE}`, pluginSink)
    const step = await team!.begin()
    assert.deepEqual(step.kind === 'confirm' ? step.question : undefined, { kind: 'team-active', members: 1, unseen: 0 })
    const other = await plugin('disable other-bundle', pluginSink)!.begin()
    assert.equal(other.kind, 'done', 'only the team bundle asks')
  }
  console.log('PASS /team on|off and /plugin disable through the lifecycle flow (trust, not installed on/off, team-active confirm, writes)')
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
console.log('ALL PASS')
