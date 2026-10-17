/**
 * Focused regression for the two upstream-facing behaviors added alongside
 * verify-permission-modes.mjs:
 *
 *   A. permissionPrefs.ts — the ~/.dsh-tui/permission.json round trip and
 *      its validation (safe command tokens only, junk reads as absent).
 *   B. channel/upstream-retry.ts — pure helpers (route selection, ops
 *      shape, policy freshness) and the ensureUpstreamRetry settings flow
 *      over a fake settings service (skip when absent/ns missing, one
 *      SETTINGS_CONFLICT retry, notify on success, quiet on refusal).
 *   C. the channel-level wiring — durable permission/preset events teach
 *      the preference (including ones the official /permission command
 *      appended on its own), in-plan switches do not, a fresh session is
 *      seeded with the remembered preset through the service write path,
 *      a session whose only plane events ARE the composition's own creation
 *      pin (dsh-permission-presets `session/created` → pinInitialPermission)
 *      still seeds, a session that ran a turn or switched to another
 *      identity does not, and the DSH_PERMISSION_MODE launch pin outranks
 *      the file.
 *   E. DSH's experimental `auto` preset — never remembered, never seeded
 *      from an old file, its unload migration to danger-full-access is not
 *      learned while a TUI-driven switch away from it is, Shift+Tab skips
 *      it until the session selected it once, the roster follows
 *      `permission-presets/catalog-changed`, and its label is localized.
 *
 * Runs against the compiled channel (imports ../lib/types/…). Run after
 * pnpm build: node scripts/verify-permission-prefs.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-permission-prefs-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const { readPermissionPref, writePermissionPref } = await import('../lib/types/permissionPrefs.js')
const {
  ensureUpstreamRetry,
  routesWithoutRetryPolicy,
  upstreamRetryOps,
  upstreamRetryPolicy,
  UPSTREAM_RETRY_MAX_RETRIES,
  UPSTREAM_RETRYABLE_CODES,
} = await import('../lib/types/dsh-adapter/channel/upstream-retry.js')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const { modeDisplayName } = await import('../lib/types/sessionModes.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 90))
}

const prefFile = () => join(isolatedHome, '.dsh-tui', 'permission.json')
const clearPref = () => { try { unlinkSync(prefFile()) } catch { /* absent */ } }

// ---- A. permissionPrefs round trip and validation -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-prefs-unit-'))
  try {
    check('absent pref reads undefined', readPermissionPref(dir) === undefined)
    check('write reports success', writePermissionPref('danger-full-access', dir) === true)
    check('round trip keeps the identity', readPermissionPref(dir) === 'danger-full-access')
    const raw = JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8'))
    check('file shape is { permission }', raw.permission === 'danger-full-access')
    writeFileSync(join(dir, 'permission.json'), '{not json', 'utf8')
    check('corrupt file reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission: 'not safe' }), 'utf8')
    check('unsafe token reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission: '  ' }), 'utf8')
    check('blank identity reads undefined', readPermissionPref(dir) === undefined)
    writeFileSync(join(dir, 'permission.json'), JSON.stringify(['danger-full-access']), 'utf8')
    check('non-object document reads undefined', readPermissionPref(dir) === undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- B. upstream-retry helpers and the settings ensure flow ---------------
{
  check('policy retries 5 times', upstreamRetryPolicy().maxRetries === UPSTREAM_RETRY_MAX_RETRIES && UPSTREAM_RETRY_MAX_RETRIES === 5)
  check('policy covers the stock codes plus STREAM_CLOSED',
    UPSTREAM_RETRYABLE_CODES.includes('STREAM_CLOSED') && UPSTREAM_RETRYABLE_CODES.includes('TRANSPORT') && UPSTREAM_RETRYABLE_CODES.includes('EMPTY_RESPONSE'))
  const first = upstreamRetryPolicy()
  const second = upstreamRetryPolicy()
  check('policy objects are fresh per call', first !== second && JSON.stringify(first) === JSON.stringify(second))
  const section = {
    providers: {
      zhipu: { baseURL: 'https://example', models: [] },
      deepseek: { baseURL: 'https://example', retryPolicy: { mode: 'always' } },
      broken: null,
      relay: 'scalar',
    },
  }
  check('routes without a retryPolicy are selected exactly', JSON.stringify(routesWithoutRetryPolicy(section)) === JSON.stringify(['zhipu', 'broken', 'relay']))
  check('non-object sections select nothing', routesWithoutRetryPolicy(undefined).length === 0 && routesWithoutRetryPolicy('nope').length === 0 && routesWithoutRetryPolicy({ providers: 7 }).length === 0)
  const ops = upstreamRetryOps(['zhipu', 'relay'])
  check('ops address the retryPolicy field', JSON.stringify(ops[0]?.path) === JSON.stringify(['providers', 'zhipu', 'retryPolicy']) && ops[0]?.op === 'set')
  check('ops carry the widened policy', ops[1]?.value?.retryableCodes?.includes('STREAM_CLOSED') === true && ops[1]?.value?.maxRetries === 5)
  check('wanted filtering keeps only requested routes', JSON.stringify(routesWithoutRetryPolicy(section, ['zhipu', 'deepseek'])) === JSON.stringify(['zhipu']))
  check('wanted filtering drops unknown routes', routesWithoutRetryPolicy(section, ['native-adapter-route']).length === 0)

  // A settings fake whose describe() reflects successful mutations, so
  // idempotency (a seeded route drops out) is observable.
  const makeSettings = (rows, behavior = {}) => {
    const live = rows.map(row => ({ ...row, value: structuredClone(row.value) }))
    const mutations = []
    const notifies = []
    const warnings = []
    const apply = (ns, opsToApply) => {
      const row = live.find(candidate => candidate.ns === ns)
      if (row === undefined) return
      for (const op of opsToApply) {
        let node = row.value
        for (const key of op.path.slice(0, -1)) {
          if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
          node = node[key]
        }
        node[op.path[op.path.length - 1]] = structuredClone(op.value)
      }
    }
    const settings = {
      describe: () => live,
      mutate: async (ns, opsToApply, revision) => {
        mutations.push({ ns, opsToApply, revision, attempt: mutations.length + 1 })
        if (behavior.conflictOnce && mutations.length === 1) { const error = new Error('stale'); error.code = 'SETTINGS_CONFLICT'; throw error }
        if (behavior.refuse) throw new Error('refused')
        apply(ns, opsToApply)
      },
    }
    const ctx = {
      on: () => () => {},
      get: name => (name === 'settings' ? settings : undefined),
      logger: { warn: message => warnings.push(String(message)) },
    }
    const notify = (text, options) => notifies.push({ text, options })
    return { settings, ctx, notify, mutations: () => mutations, notifies, warnings }
  }

  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 4, value: section }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('ensure mutates the llm-pi-ai namespace once', env.mutations().length === 1 && env.mutations()[0]?.ns === 'llm-pi-ai')
    check('ensure seeds exactly the requested unclaimed route', env.mutations()[0]?.opsToApply?.length === 1 && env.mutations()[0]?.opsToApply?.[0]?.path?.[1] === 'zhipu', JSON.stringify(env.mutations()[0]?.opsToApply?.map(op => op.path?.[1])))
    check('ensure passes the observed revision', env.mutations()[0]?.revision === 4)
    check('ensure notifies once on success, naming the route', env.notifies.length === 1 && env.notifies[0]?.options?.color === 'success' && env.notifies[0]?.text?.includes('zhipu') === true)
    // The write landed in the resolved section: a second seeding for the
    // same route (the next bind) is a read-only no-op.
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a seeded route drops out of later seedings', env.mutations().length === 1 && env.notifies.length === 1)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }], { conflictOnce: true })
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu', 'relay'])
    check('a stale revision is retried exactly once', env.mutations().length === 2 && env.mutations()[1]?.revision === 2 && env.mutations()[1]?.opsToApply?.length === 2)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }], { refuse: true })
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a refused write warns and never throws', env.warnings.length === 1 && env.notifies.length === 0 && env.mutations().length === 1)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: { providers: { deepseek: { retryPolicy: { mode: 'always' } } } } }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['deepseek'])
    check('routes that already declare a policy are left alone', env.mutations().length === 0 && env.notifies.length === 0)
  }
  {
    const env = makeSettings([{ ns: 'llm-pi-ai', revision: 2, value: section }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['native-adapter-route'])
    check('a route the section does not know writes nothing', env.mutations().length === 0 && env.notifies.length === 0)
  }
  {
    const env = makeSettings([{ ns: 'other-ns', revision: 1, value: {} }])
    await ensureUpstreamRetry(env.ctx, env.notify, ['zhipu'])
    check('a missing llm-pi-ai namespace writes nothing', env.mutations().length === 0)
  }
  {
    const ctx = { on: () => () => {}, get: () => undefined, logger: { warn: () => {} } }
    const notified = []
    await ensureUpstreamRetry(ctx, text => notified.push(text), ['zhipu'])
    check('no settings service writes nothing', notified.length === 0)
  }
}

// ---- C. channel-level persistence, seeding, and the deployment pin --------
const makeEnv = ({ history = [], withCommand = false, settings, options, defaultPreset = 'workspace-write', withAuto = false } = {}) => {
  const commands = []
  const warnings = []
  const handlers = new Map()
  const events = [...history]
  /** Runs between the external `/permission` switch and its event append. */
  let beforeCommand = () => {}
  /** Models the command settling without appending the user's target. */
  let skipTarget = false
  const permissionCommand = { name: 'permission' }
  const registry = {
    // The composition default dsh-permission-presets pins into every fresh
    // session (mirrors the service's `defaultPreset` getter); undefined models
    // a service that does not answer it at all (null = omit the getter).
    ...(defaultPreset === null ? {} : { defaultPreset }),
    names: ['read-only', 'workspace-write', 'balanced', 'safe', ...(withAuto ? ['auto'] : [])],
    entries: new Map([
      ['read-only', { value: 'read-only', name: 'Read only' }],
      ['workspace-write', { value: 'workspace-write', name: 'Workspace write' }],
      ['balanced', { value: 'balanced', name: 'Balanced' }],
      ['safe', { value: 'safe', name: 'Safe' }],
      // The real registry hands `auto` out bare: no label, no description.
      ...(withAuto ? [['auto', { value: 'auto', name: 'auto' }]] : []),
    ]),
    // Mirrors the real service derive(): folded knob state over the
    // composition defaults, so a fresh session reads its effective preset
    // (never undefined) exactly like dsh-permission-presets does.
    current(subject) {
      const bundles = {
        'read-only': ['read-only', 'ask'],
        'workspace-write': ['workspace-write', 'ask'],
        balanced: ['workspace-write', 'ask'],
        safe: ['workspace-write', 'ask'],
        ...(this.names.includes('auto') ? { auto: ['danger-full-access', 'ask'] } : {}),
      }
      let sandbox
      let approval
      let preset
      for (const event of (Array.isArray(subject) ? subject : subject?.events ?? [])) {
        if (event.type === 'sandbox/mode') sandbox = event.data?.mode
        if (event.type === 'approval/policy') approval = event.data?.policy
        if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') preset = event.data.preset
      }
      sandbox ??= 'workspace-write'
      approval ??= 'ask'
      if (preset !== undefined && bundles[preset]?.[0] === sandbox && bundles[preset]?.[1] === approval) return preset
      for (const [name, spec] of Object.entries(bundles)) {
        if (spec[0] === sandbox && spec[1] === approval) return name
      }
      return 'custom'
    },
    optionOf(name) { return this.entries.get(name) },
    resolve(name) {
      const bundles = {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        balanced: { sandbox: 'workspace-write', approval: 'ask' },
        safe: { sandbox: 'workspace-write', approval: 'ask' },
        auto: { sandbox: 'danger-full-access', approval: 'ask' },
      }
      return { ...bundles[name] }
    },
    set(session, name) {
      if (!this.entries.has(name)) throw new Error(`unknown preset ${name}`)
      session.append('permission/preset', { preset: name })
    },
  }
  const services = {
    planMode: { get: () => ({}) },
    commands: {
      list: () => [],
      find: (_agent, name) => (withCommand && name === 'permission' ? permissionCommand : undefined),
      execute: async (_agent, line) => {
        if (!withCommand) return undefined
        beforeCommand()
        if (skipTarget) return { result: { kind: 'error', text: 'blocked' } }
        const target = line.replace(/^\/permission\s*/, '').trim().split(/\s+/)[0]
        if (target !== undefined && target !== '') agent.session.append('permission/preset', { preset: target })
        return { result: { kind: 'success', text: '' } }
      },
    },
    ...(withCommand ? { tuiPluginHost: { grants: { allows: () => true } } } : {}),
    approval: { setPolicy: (agent, policy) => agent.session.append('approval/policy', { policy }) },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    permissionPresets: registry,
    ...(settings === undefined ? {} : { settings }),
  }
  const ctx = {
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    get: name => services[name],
    logger: { warn: message => warnings.push(String(message)) },
  }
  const agent = {
    id: 'a1',
    status: 'idle',
    ...(options === undefined ? {} : { options }),
    session: {
      id: 's1',
      seq: 0,
      events,
      append(type, data) {
        const event = { type, seq: events.length + 1, time: Date.now(), data }
        events.push(event)
        handlers.get('session/event')?.(agent.session, event)
      },
    },
    ctx: { on: () => () => {} },
  }
  return {
    ctx, agent, registry, commands, warnings, events, handlers,
    setBeforeCommand: fn => { beforeCommand = fn },
    setSkipTarget: value => { skipTarget = value },
  }
}

const baseOptions = { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false }
const AUTO_SEED = [
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
  { type: 'permission/preset', data: { preset: 'balanced' } },
]

{
  clearPref()
  const env = makeEnv({ history: AUTO_SEED })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('observer: no switch leaves no preference file', !existsSync(prefFile()))
  // The official /permission command appending on its own (typed input,
  // another UI over the same registry) is the primary teaching path.
  env.agent.session.append('permission/preset', { preset: 'safe' })
  await settle()
  check('observer: durable identity switches teach the preference', readPermissionPref() === 'safe', readPermissionPref())
  // In-plan switches are transient: the exit restore re-seats the pre-plan
  // preset, so the file must keep the last out-of-plan identity.
  env.agent.session.append('plan/mode', { active: true })
  env.agent.session.append('permission/preset', { preset: 'read-only' })
  await settle()
  check('observer: in-plan switches do not teach the preference', readPermissionPref() === 'safe', readPermissionPref())
  env.agent.session.append('plan/mode', { active: false })
  env.agent.session.append('permission/preset', { preset: 'safe' })
  await settle()
  check('observer: post-plan restore teaches again', readPermissionPref() === 'safe')
}

{
  clearPref()
  writePermissionPref('balanced')
  const env = makeEnv()
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const taught = env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'balanced')
  check('seed: a fresh session adopts the remembered preset', taught, JSON.stringify(env.events.map(event => event.type)))
  check('seed: the derived mode follows the identity', channel.mode.id === 'permission:balanced', channel.mode.id)
}

{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({ history: [{ type: 'sandbox/mode', data: { mode: 'read-only' } }] })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const untouched = !env.events.some(event => event.type === 'permission/preset')
  check('seed: a session with its own plane events is left alone', untouched)
}

// The composition writes permission/preset + sandbox/mode + approval/policy
// into EVERY fresh session at creation (`session/created` →
// pinInitialPermission), so holding those events is not a user choice: a
// still-untouched session must seed, or the remembered pick could never apply.
{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: the composition creation pin does not block the remembered preset',
    env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
    JSON.stringify(env.events.map(event => event.type)),
  )
}

{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'turn/start', data: {} },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: a session that ran a turn keeps its own planes',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
  )
}

{
  clearPref()
  writePermissionPref('balanced')
  const env = makeEnv({
    history: [
      { type: 'permission/preset', data: { preset: 'safe' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: an identity the composition did not pin is a user choice',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'balanced'),
  )
}

// Fail-closed: without the composition default the pin cannot be recognized,
// so plane events count as a user choice again — the guard must not turn an
// unknown default into a seed.
{
  clearPref()
  writePermissionPref('safe')
  const env = makeEnv({
    defaultPreset: null,
    history: [
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ],
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check(
    'seed: an unknown composition default fails closed (no seed)',
    !env.events.some(event => event.type === 'permission/preset' && event.data?.preset === 'safe'),
  )
}

{
  clearPref()
  writePermissionPref('balanced')
  process.env.DSH_PERMISSION_MODE = 'workspace-write'
  const env = makeEnv()
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('seed: a DSH_PERMISSION_MODE pin outranks the file', !env.events.some(event => event.type === 'permission/preset'))
  delete process.env.DSH_PERMISSION_MODE
}

{
  clearPref()
  writePermissionPref('gone-from-the-roster')
  const env = makeEnv()
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('seed: an identity off the mounted roster is skipped', !env.events.some(event => event.type === 'permission/preset'))
  clearPref()
}

// ---- E. DSH's experimental `auto` preset -----------------------------------
const presetEvents = (events, from = 0) => events.slice(from)
  .filter(event => event.type === 'permission/preset')
  .map(event => event.data?.preset)

{
  clearPref()
  writePermissionPref('balanced')
  const env = makeEnv({ withAuto: true, history: AUTO_SEED })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  env.agent.session.append('permission/preset', { preset: 'auto' })
  await settle()
  check('auto: selecting it does not teach the preference', readPermissionPref() === 'balanced', readPermissionPref())
  check('auto: the indicator shows the localized label', ['Auto review', '自动授权审查'].includes(modeDisplayName(channel.mode)), modeDisplayName(channel.mode))
  // dsh-experimental-auto-review moves every Auto session to
  // danger-full-access when it unloads; that is not the user's choice.
  env.agent.session.append('permission/preset', { preset: 'danger-full-access' })
  await settle()
  check('auto: the unload migration is not learned', readPermissionPref() === 'balanced', readPermissionPref())
  env.agent.session.append('permission/preset', { preset: 'auto' })
  await settle()
  await channel.runPermissionPreset('safe')
  await settle()
  check('auto: a TUI-driven switch away from it is learned', readPermissionPref() === 'safe', readPermissionPref())
  // An unload migration racing a pending TUI switch to another target is
  // still the plugin's doing, not the user's choice.
  env.agent.session.append('permission/preset', { preset: 'auto' })
  await settle()
  const pending = channel.runPermissionPreset('gone-with-the-plugin')
  env.agent.session.append('permission/preset', { preset: 'danger-full-access' })
  await pending
  await settle()
  check('auto: an unload migration during a pending switch elsewhere is not learned', readPermissionPref() === 'safe', readPermissionPref())
  // The typed target is matched against the roster, not compared verbatim.
  env.agent.session.append('permission/preset', { preset: 'auto' })
  await settle()
  const typed = channel.runPermissionPreset('Workspace-Write')
  env.agent.session.append('permission/preset', { preset: 'workspace-write' })
  await typed
  await settle()
  check('auto: a switch typed in another case is learned', readPermissionPref() === 'workspace-write', readPermissionPref())
  // The unload migration stays unlearned when a plan round-trip re-seats it.
  env.agent.session.append('permission/preset', { preset: 'auto' })
  env.agent.session.append('permission/preset', { preset: 'danger-full-access' })
  env.agent.session.append('plan/mode', { active: true })
  env.agent.session.append('permission/preset', { preset: 'read-only' })
  env.agent.session.append('plan/mode', { active: false })
  env.agent.session.append('permission/preset', { preset: 'danger-full-access' })
  await settle()
  check('auto: a plan exit re-seating the unload migration is not learned', readPermissionPref() === 'workspace-write', readPermissionPref())
}

{
  clearPref()
  writePermissionPref('auto')
  const env = makeEnv({ withAuto: true })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('auto: an old remembered auto never seeds a fresh session', !presetEvents(env.events).includes('auto'), JSON.stringify(presetEvents(env.events)))
  clearPref()
}

{
  clearPref()
  const env = makeEnv({
    withAuto: true,
    history: [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'permission/preset', data: { preset: 'safe' } },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  check('auto: the roster carries it', channel.permissionPresets().options.some(option => option.value === 'auto'))
  const before = env.events.length
  await channel.cycleMode()
  await settle()
  check('auto: Shift+Tab skips it before the session selected it', !presetEvents(env.events, before).includes('auto'), JSON.stringify(presetEvents(env.events, before)))
}

{
  clearPref()
  const env = makeEnv({
    withAuto: true,
    history: [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'permission/preset', data: { preset: 'auto' } },
      { type: 'permission/preset', data: { preset: 'safe' } },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const before = env.events.length
  await channel.cycleMode()
  await settle()
  check('auto: Shift+Tab reaches it once the session selected it', presetEvents(env.events, before)[0] === 'auto', JSON.stringify(presetEvents(env.events, before)))
}

{
  // A configured static mode on Auto's atoms (danger-full-access + ask) must
  // never canonicalize into the session-only preset.
  clearPref()
  const env = makeEnv({
    withAuto: true,
    history: [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, {
    ...baseOptions,
    modes: [
      { id: 'default', sandbox: 'workspace-write', approval: 'ask' },
      { id: 'yolo-ask', sandbox: 'danger-full-access', approval: 'ask' },
    ],
  })
  await settle()
  const before = env.events.length
  await channel.cycleMode()
  await settle()
  check('auto: a static mode on its atoms never canonicalizes into it', !presetEvents(env.events, before).includes('auto'), JSON.stringify(presetEvents(env.events, before)))
}

{
  // A single configured mode with no runtime extras: Shift+Tab still
  // re-applies it when the session's atoms drifted (the skip loop must cover
  // the starting entry).
  clearPref()
  const env = makeEnv({
    history: [
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ],
  })
  env.registry.names = ['read-only', 'workspace-write']
  const channel = createChannel(env.ctx, env.agent, {
    ...baseOptions,
    modes: [{ id: 'ro', sandbox: 'read-only', approval: 'ask' }],
  })
  await settle()
  const before = env.events.length
  await channel.cycleMode()
  await settle()
  const after = env.events.slice(before)
  check('cycle: a single-mode cycle re-applies its atoms',
    after.some(event => event.type === 'sandbox/mode' && event.data?.mode === 'read-only')
      && after.some(event => event.type === 'approval/policy' && event.data?.policy === 'ask'),
    JSON.stringify(after.map(event => [event.type, event.data])))
}

{
  clearPref()
  const env = makeEnv({ history: AUTO_SEED })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  let renders = 0
  channel.subscribe(() => { renders += 1 })
  env.registry.names.push('auto')
  env.registry.entries.set('auto', { value: 'auto', name: 'auto' })
  const changed = env.handlers.get('permission-presets/catalog-changed')
  check('catalog: the channel listens for catalog changes', typeof changed === 'function')
  changed?.()
  await settle()
  check('catalog: a change re-renders', renders > 0, String(renders))
  check('catalog: the roster gains auto', channel.permissionPresets().options.some(option => option.value === 'auto'))
}

// Real Cordis hands a fresh traceable proxy per `ctx.get`; key the memoized
// snapshot by the concrete service behind it, or the cache never hits.
{
  clearPref()
  const env = makeEnv({ withAuto: true, history: AUTO_SEED })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const rawGet = env.ctx.get
  env.ctx.get = name => {
    const service = rawGet(name)
    if (name !== 'permissionPresets' || service === undefined) return service
    return new Proxy(service, {
      get(target, prop, receiver) {
        if (prop === Symbol.for('cordis.original')) return target
        return Reflect.get(target, prop, receiver)
      },
    })
  }
  const first = channel.permissionPresets()
  const second = channel.permissionPresets()
  check('catalog: the snapshot cache keys on the concrete service, not the traceable proxy', first === second)
}

{
  clearPref()
  const env = makeEnv({
    withAuto: true,
    withCommand: true,
    history: [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'permission/preset', data: { preset: 'auto' } },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const outcome = await channel.runExternalCommandOutcome('permission', ' safe')
  await settle()
  check('auto: the external /permission path learns a switch away from it',
    outcome?.kind === 'success' && readPermissionPref() === 'safe',
    `${outcome?.kind} ${readPermissionPref()}`)
}

{
  // The dangerous shape: the user's external switch is still pending when the
  // auto bundle unloads and migrates the session to danger-full-access. The
  // migration must not be learned just because a switch is in flight.
  clearPref()
  const env = makeEnv({
    withAuto: true,
    withCommand: true,
    history: [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
      { type: 'permission/preset', data: { preset: 'auto' } },
    ],
  })
  const channel = createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  env.setBeforeCommand(() => {
    env.agent.session.append('permission/preset', { preset: 'danger-full-access' })
    env.setSkipTarget(true)
  })
  const outcome = await channel.runExternalCommandOutcome('permission', ' safe')
  await settle()
  check('auto: an unload migration during a pending external switch is not learned',
    outcome?.kind === 'error' && readPermissionPref() === undefined,
    `${outcome?.kind} ${readPermissionPref()}`)
}

// ---- D. upstream retry follows the route the session actually uses --------
{
  const mutations = []
  const section = {
    providers: {
      zhipu: { baseURL: 'https://zhipu.example', models: [] },
      deepseek: { baseURL: 'https://deepseek.example', models: [], retryPolicy: { mode: 'always' } },
    },
  }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: section }],
    mutate: async (ns, opsToApply, revision) => { mutations.push({ ns, opsToApply, revision }) },
  }
  const env = makeEnv({
    settings,
    options: { provider: 'zhipu', model: 'glm-5.3' },
  })
  createChannel(env.ctx, env.agent, baseOptions)
  await settle()
  const seeded = mutations[0]?.opsToApply ?? []
  check('retry: the bind seeds the route in use', mutations.length === 1 && seeded.length === 1 && seeded[0]?.path?.[1] === 'zhipu', JSON.stringify(seeded.map(op => op.path)))
  check('retry: routes with their own policy and dormant channels stay untouched', !JSON.stringify(seeded).includes('deepseek'))
}

if (failed > 0) {
  console.error(`permission-prefs verification failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('permission-prefs verification passed')
}
