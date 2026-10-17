/**
 * DSH Agent Teams read side (issue #1241, phase 1): the `agentTeam` roster
 * store, team-message bubbles and the team tool cards, on the 0.2.1-alpha.5
 * shapes (Lead spawns `reviewer`, which messages the Lead back). The
 * projection and record shapes are unchanged since the 0.2.0-rc.2 recording;
 * the 0.2.0 message and result shapes are covered apart, by
 * verify-agent-teams-compat-0.2.0.ts. No team package is imported. Preset
 * delegation rows are covered by verify-bundled-presets.mjs.
 *
 * Run: node --import tsx/esm scripts/verify-agent-teams.ts
 */
import assert from 'node:assert/strict'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { isSubagentToolName } from '../src/dsh-adapter/channel/projection-helpers.js'
import type { ProjectionRegistryLike } from '../src/dsh-adapter/activity-store.js'
import { attachSessionProjection, createSessionProjectionStore } from '../src/dsh-adapter/session-projection-store.js'
import { asTeamView, createTeamRosterStore, teamRootOf, TEAM_PROJECTION_KEY } from '../src/dsh-adapter/team-roster.js'
import { teamToolCallView, teamToolResultView } from '../src/dsh-adapter/team-tools.js'
import { SubagentActivityStore } from '../src/dsh-adapter/subagents.js'
import { createProjectorHarness } from './lib/projector-harness.js'

const LEAD = 'lead-1'
const MATE = 'd760b893-aa5a-450f-8d8e-472b8c09e6cd'
const lead = { id: LEAD, name: 'lead', role: 'lead', phase: 'active' }
const reviewer = { id: MATE, name: 'reviewer', role: 'teammate', phase: 'active' }
const task = { id: 'task-1', revision: 1, subject: 'Review', description: 'review it', status: 'pending', blockedBy: [], writeScopes: ['src'], ready: true, writeScopeWarnings: [] }
/** What every root session publishes once the service is mounted. */
const baseline = { members: [lead], tasks: [] }
const team = { members: [lead, reviewer], tasks: [task] }

// ── narrowing ────────────────────────────────────────────────────────────
assert.equal(asTeamView(baseline, LEAD), undefined, 'the implicit one-member team is no team')
assert.deepEqual(asTeamView(team, LEAD), { leadSessionId: LEAD, members: team.members, tasks: team.tasks })
assert.equal(asTeamView({ members: [lead], tasks: [task] }, LEAD)?.tasks.length, 1, 'a task alone is a team')
assert.equal(asTeamView({ ...baseline, failure: 'bad record' }, LEAD)?.failure, 'bad record', 'a failure is always shown')
assert.equal(asTeamView({ members: [{ ...reviewer, phase: 'gone' }], tasks: [] }, LEAD), undefined, 'malformed rows drop the value')
assert.equal(asTeamView({ members: [lead], tasks: [{ ...task, status: 'deleted' }] }, LEAD), undefined)
assert.equal(asTeamView(undefined, LEAD), undefined)
console.log('PASS agentTeam narrowing (baseline hidden, teammate/task/failure shown, malformed dropped)')

// ── team root of a bound session ─────────────────────────────────────────
const leadSession = { id: LEAD, header: { version: 4, id: LEAD } }
const mateSession = { id: MATE, header: { version: 4, id: MATE, parentSession: LEAD, origin: 'subagent', delegationDepth: 1 } }
const agents = { list: () => [{ session: leadSession }, { session: mateSession }] }
assert.deepEqual(teamRootOf(leadSession, agents), { id: LEAD, session: leadSession })
assert.deepEqual(teamRootOf(mateSession, agents), { id: LEAD, session: leadSession }, 'a teammate reads its Lead')
assert.deepEqual(teamRootOf(mateSession, { list: () => [] }), { id: LEAD }, 'an unloaded Lead still names the watched id')
const forked = { id: 'fork-1', header: { parentSession: LEAD } }
assert.deepEqual(teamRootOf(forked, agents), { id: 'fork-1', session: forked }, 'a fork is its own root')
console.log('PASS team root (Lead itself, teammate → parentSession, fork stays own root)')

// ── store over a fake registry ───────────────────────────────────────────
{
  const published = new Map<string, unknown>([[LEAD, team]])
  let feed: ((session: { readonly id: unknown }, key: string, value: unknown, seq: number) => void) | undefined
  const registry: ProjectionRegistryLike = {
    onChanged(listener) { feed = listener; return () => { feed = undefined } },
    snapshot(session, keys) {
      assert.deepEqual(keys, [TEAM_PROJECTION_KEY])
      return { values: { [TEAM_PROJECTION_KEY]: published.get(String((session as { id: unknown }).id)) } }
    },
  }
  let effect: (() => void) | undefined
  const ctx = {
    inject(_deps: unknown, callback: (ctx: unknown) => void) {
      callback({ sessionProjections: registry, effect: (fn: () => () => void) => { effect = fn() } })
    },
  }
  const store = createSessionProjectionStore({ key: TEAM_PROJECTION_KEY, narrow: asTeamView, watch: session => teamRootOf(session, agents) })
  let emits = 0
  store.subscribe(() => { emits++ })
  store.seed(mateSession)
  assert.equal(store.read(), undefined, 'no registry yet: nothing to read')
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(store.read()?.members[1]?.name, 'reviewer', 'a late registry seeds the bound teammate with its Lead team')
  assert.equal(store.read()?.leadSessionId, LEAD)
  assert.equal(emits, 1)
  const before = store.read()
  feed!({ id: LEAD }, TEAM_PROJECTION_KEY, team, 3)
  assert.equal(store.read(), before, 'the same value reference is no change')
  feed!({ id: 'other-root' }, TEAM_PROJECTION_KEY, { members: [lead, reviewer], tasks: [] }, 4)
  feed!({ id: LEAD }, 'workingActivity', {}, 5)
  assert.equal(emits, 1, 'other sessions and other keys are ignored')
  feed!({ id: LEAD }, TEAM_PROJECTION_KEY, baseline, 6)
  assert.equal(store.read(), undefined, 'a value that reads as no team clears the store')
  assert.equal(emits, 2)
  published.set('plain-1', baseline)
  store.seed({ id: 'plain-1' })
  assert.equal(store.read(), undefined)
  assert.equal(emits, 2, 'binding a session without a team emits nothing')
  effect!()
  assert.equal(feed, undefined, 'the feed listener goes with the injected fiber')
}
{
  // A registry that leaves is never read again; its value clears, and the
  // read-failure warning re-arms for the next registry.
  let reads = 0
  let fail = false
  const registry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot() {
      reads++
      if (fail) throw new Error('disposed')
      return { values: { [TEAM_PROJECTION_KEY]: team } }
    },
  }
  let effect: (() => void) | undefined
  const ctx = {
    inject(_deps: unknown, callback: (ctx: unknown) => void) {
      callback({ sessionProjections: registry, effect: (fn: () => () => void) => { effect = fn() } })
    },
  }
  const warnings: string[] = []
  const store = createSessionProjectionStore({ key: TEAM_PROJECTION_KEY, narrow: asTeamView, warn: message => { warnings.push(message) } })
  store.seed(leadSession)
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(store.read()?.leadSessionId, LEAD)
  fail = true
  store.reseed()
  store.reseed()
  assert.equal(warnings.length, 1, 'one registry warns once')
  effect!()
  assert.equal(store.read(), undefined, 'a registry that left clears the value')
  const left = reads
  store.reseed()
  assert.equal(reads, left, 'a registry that left is not read again')
  assert.equal(store.read(), undefined, 'a reseed without a registry keeps nothing stale')
  attachSessionProjection(ctx as never, TEAM_PROJECTION_KEY, store as never)
  assert.equal(warnings.length, 2, 'a new registry re-arms the warning')
  fail = false
  store.reseed()
  assert.equal(store.read()?.leadSessionId, LEAD, 'a registry that comes back seeds again')
}
{
  // The composition-root store: the channel reads it by the bound session id.
  const registry: ProjectionRegistryLike = {
    onChanged: () => () => undefined,
    snapshot: session => ({ values: { [TEAM_PROJECTION_KEY]: String((session as { id: unknown }).id) === LEAD ? team : undefined } }),
  }
  const ctx = {
    get: (name: string) => (name === 'agents' ? agents : name === 'agentTeams' ? {} : undefined),
    logger: { warn: () => undefined },
    inject(_deps: unknown, callback: (ctx: unknown) => void) { callback({ sessionProjections: registry, effect: () => undefined }) },
    on: () => () => undefined,
  }
  const store = createTeamRosterStore(ctx as never)
  store.seed(mateSession)
  assert.equal(store.teamOf(MATE)?.leadSessionId, LEAD, 'inside a teammate the channel reads the Lead team')
  assert.equal(store.teamOf(LEAD), undefined, 'only the seeded session reads it')
  assert.equal(store.teamOf('claude-session'), undefined, 'a session that never seeds (another backend) reads no stale team')
  // A plain child of the Lead watches the same parent but is on no team.
  store.seed({ id: 'plain-child', header: { version: 4, id: 'plain-child', parentSession: LEAD, origin: 'subagent', delegationDepth: 1 } })
  assert.equal(store.watchedId, LEAD)
  assert.equal(store.teamOf('plain-child'), undefined, 'a non-teammate child of the Lead reads no team')
  store.seed(leadSession)
  assert.equal(store.teamOf(LEAD)?.leadSessionId, LEAD, 'the Lead reads its own team')
}
console.log('PASS team store (late registry seed, teammate → Lead, identity, isolation, baseline clear, disposal, registry leaving, read by bound id)')

// ── team messages ────────────────────────────────────────────────────────
const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
{
  // What 0.2.1-alpha.5 records: the sender only in the framing block, the
  // generic agent-message relay as the source.
  const relayed = {
    type: 'user/message', seq: 21, time: 1792133614950,
    data: {
      role: 'user', id: '6e645a6d-4967-45bc-abee-06b1f92f5c23',
      content: [{ type: 'text', text: 'Team message from reviewer:' }, { type: 'text', text: 'reviewer report: diff ok' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: MATE },
    },
  }
  for (const replaying of [false, true]) {
    const translator = createDshTranslator(deps)
    const events = replaying ? translator.translateReplay([relayed] as never) : translator.translateEvent(relayed as never)
    const message = events.find(event => event.type === 'user.message')
    assert.ok(message !== undefined && message.type === 'user.message')
    assert.equal(message.source, 'team-message')
    assert.equal(message.sender, 'reviewer')
    assert.equal(message.text, 'reviewer report: diff ok', 'the framing block is dropped')
    const harness = createProjectorHarness()
    harness.apply(events, replaying)
    assert.deepEqual(harness.state.rows.filter(row => row.kind === 'user').map(row => ({ text: row.text, sender: row.sender, label: row.label, seq: row.seq })),
      [{ text: 'reviewer report: diff ok', sender: 'reviewer', label: 'team-message', seq: 21 }], 'one bubble in the receiving transcript')
    assert.equal(harness.state.lastUserText, '', 'a peer message is not the human prompt')
  }
  // A relay without the team framing (the legacy send_message) is no team message.
  const legacy = { ...relayed, data: { ...relayed.data, content: [{ type: 'text', text: 'plain relay' }] } }
  const harness = createProjectorHarness()
  harness.apply(createDshTranslator(deps).translateEvent(legacy as never))
  assert.deepEqual(harness.state.rows.filter(row => row.kind === 'user'), [])
  // Framing on a non-relay source is the human's own text.
  const typed = { ...relayed, data: { ...relayed.data, source: { kind: 'user' } } }
  const own = createDshTranslator(deps).translateEvent(typed as never).find(event => event.type === 'user.message')
  assert.ok(own?.type === 'user.message' && own.source === 'user')
  // Other injected sources stay hidden.
  const injected = { ...relayed, data: { ...relayed.data, source: { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: MATE } } }
  const hidden = createProjectorHarness()
  hidden.apply(createDshTranslator(deps).translateEvent(injected as never))
  assert.deepEqual(hidden.state.rows.filter(row => row.kind === 'user'), [])
  // Inside the teammate the agent-message feed owns it: no line of its own.
  const store = new SubagentActivityStore()
  store.onSpawned(MATE)
  store.onSessionEvent(MATE, { ...relayed, data: { ...relayed.data, content: [{ type: 'text', text: 'Team message from lead:' }, { type: 'text', text: 'check src/ too' }], source: { ...relayed.data.source, senderSessionId: LEAD } } })
  assert.deepEqual(store.get(MATE)?.outputEvents, [], 'a team message adds no line to the child')
}
console.log('PASS team message (live + replay → sender bubble from the framing name, not the last prompt; legacy relay, typed framing and other injected stay hidden; the child leaves it to the agent-message feed)')

// ── tool cards ───────────────────────────────────────────────────────────
assert.equal(isSubagentToolName('spawn_teammate'), true, 'spawn_teammate renders as the subagent row')
assert.deepEqual(teamToolCallView('send_message', JSON.stringify({ target: 'reviewer', message: 'check src/\nthen report' })),
  { card: 'generic', title: '→ reviewer · check src/', displayKey: 'tool-name-team-message', category: 'other' })
assert.equal(teamToolCallView('send_message', JSON.stringify({ agent_id: 'x', message: 'legacy' })), undefined, 'the legacy control keeps the plain card')
assert.equal(teamToolCallView('interrupt_agent', JSON.stringify({ agent_id: 'x' })), undefined)
assert.equal(teamToolCallView('list_agents', '{}'), undefined, 'a list call cannot tell team from legacy')
assert.equal(teamToolCallView('team_task_update', JSON.stringify({ task_id: 'task-1', expected_revision: 1, action: 'reassign', owner: 'reviewer' }))?.title, 'task-1 reassign → reviewer')
assert.equal(teamToolCallView('team_task_list', JSON.stringify({ status: 'pending', ready: true }))?.title, 'status=pending ready=true')
assert.equal(teamToolCallView('team_task_list', '{}'), undefined, 'an unfiltered list keeps the plain card, never a blank title')
assert.equal(teamToolCallView('bash', '{}'), undefined)
const sendArgs = JSON.stringify({ target: 'lead', message: 'reviewer report: diff ok' })
assert.deepEqual(teamToolResultView('send_message', sendArgs, '{"sent":true}'),
  { card: 'generic', displayKey: 'tool-name-team-message', category: 'other', title: '→ lead · reviewer report: diff ok', content: [{ type: 'text', text: 'sent' }] })
assert.equal(teamToolResultView('send_message', sendArgs, '{"messageId":"m"}'), undefined, 'the legacy control result stays raw')
assert.equal(teamToolResultView('send_message', sendArgs, 'message delivered to agent x'), undefined, 'plain text results stay raw')
assert.deepEqual(teamToolResultView('list_agents', '{}', '[{"target":"lead","role":"lead","status":"running","diagnostics":[]},{"target":"reviewer","role":"teammate","status":"inactive","diagnostics":[]}]')?.content,
  [{ type: 'text', text: 'lead running · reviewer inactive' }])
assert.deepEqual(teamToolResultView('wait_agent', '{}', '{"timedOut":false,"noProgress":{"message":"m"}}')?.content, [{ type: 'text', text: 'noProgress' }])
assert.deepEqual(teamToolResultView('wait_agent', '{}', '{"timedOut":false,"noProgress":false}')?.content, [{ type: 'text', text: 'changed' }])
assert.deepEqual(teamToolResultView('team_task_create', JSON.stringify({ subject: 'Review', description: 'r' }), JSON.stringify(task))?.content, [{ type: 'text', text: 'task-1 r1 · pending' }])
assert.deepEqual(teamToolResultView('team_task_list', '{}', JSON.stringify({ tasks: [task, { ...task, id: 'task-2', status: 'in_progress', ownerName: 'reviewer' }] }))?.content,
  [{ type: 'text', text: 'task-1 r1 · pending' }, { type: 'text', text: 'task-2 r1 · in_progress · reviewer' }])
assert.deepEqual(teamToolResultView('team_task_list', '{}', '{"tasks":[]}')?.content, [], 'an empty board is an empty card')
assert.equal(teamToolResultView('team_task_get', '{}', '{"unexpected":true}'), undefined, 'an unknown shape stays raw')
{
  // The translator asks a presenter-less tool's team fallback; a real presenter wins.
  const call = (tool: unknown) => createDshTranslator({ ...deps, tools: () => ({ get: () => tool }) as never })
    .translateEvent({ type: 'tool/call', seq: 30, time: 1, data: { callId: 'c1', name: 'send_message', arguments: sendArgs, turn: 1, step: 1 } } as never)
    .find(event => event.type === 'tool.call')
  const fallback = call({})
  assert.ok(fallback?.type === 'tool.call' && fallback.presentation !== undefined && 'title' in fallback.presentation && fallback.presentation.title === '→ lead · reviewer report: diff ok')
  const owned = call({ presentCall: () => ({ card: 'generic', title: 'own' }) })
  assert.ok(owned?.type === 'tool.call' && owned.presentation !== undefined && 'title' in owned.presentation && owned.presentation.title === 'own')
}
{
  // The team refuses a teammate before it writes the member:
  // only the call and its error are on the log, and the error shows once.
  const spawnArgs = JSON.stringify({ name: 'reviewer', description: 'Review the diff', prompt: 'review' })
  const spawnCall = { type: 'tool/call', seq: 40, time: 1, data: { callId: 'spawn-1', name: 'spawn_teammate', arguments: spawnArgs, turn: 1, step: 1 } }
  const refused = 'teammate name "reviewer" was already used in this Team'
  const spawnResult = (isError: boolean) => ({
    type: 'tool/result', seq: 41, time: 2,
    data: {
      turn: 1, step: 1,
      message: { id: 'msg-spawn', role: 'tool', content: [{ type: 'text', text: isError ? refused : '{"id":"m1","name":"reviewer"}' }], source: { kind: 'tool', callId: 'spawn-1' }, toolCallId: 'spawn-1', ...isError ? { isError: true } : {} },
      ...isError ? { error: { name: 'TeamError', code: 'TEAM_MEMBER_NAME_TAKEN', reason: refused } } : {},
    },
  })
  for (const replaying of [false, true]) {
    // Exercise the real replay seed path (prepareReplayEvents + the
    // translator's replay-mode reset), not just the projector's replay flag.
    const translateAll = (translator: ReturnType<typeof createDshTranslator>, events: unknown[]) =>
      replaying ? translator.translateReplay(events as never) : events.flatMap(event => translator.translateEvent(event as never))
    const translator = createDshTranslator(deps)
    const harness = createProjectorHarness()
    harness.apply(translateAll(translator, [spawnCall, spawnResult(true)]), replaying)
    const cards = harness.state.rows.filter(row => row.kind === 'tool')
    assert.equal(cards.length, 1, `a refused spawn shows one card (${replaying ? 'replay' : 'live'})`)
    assert.equal(cards[0]!.tool?.name, 'spawn_teammate')
    assert.equal(cards[0]!.tool?.status, 'error')
    assert.match(cards[0]!.tool?.errorText ?? '', /already used in this Team/, 'the upstream reason is on the card')
    const accepted = createProjectorHarness()
    const fresh = createDshTranslator(deps)
    accepted.apply(translateAll(fresh, [spawnCall, spawnResult(false)]), replaying)
    assert.deepEqual(accepted.state.rows.filter(row => row.kind === 'tool'), [], 'an accepted spawn leaves the teammate to the subagent row')
    // A spawn that fails after writing its member (start failure, interrupt):
    // the failed member carries the error on the roster, so no card.
    const member = (seq: number, phase: string) => ({ type: 'team/member', seq, time: 1, data: { version: 2, teamId: 'lead', member: { id: 'm1', name: 'reviewer', description: 'Review the diff', provider: 'p', phase } } })
    const written = createProjectorHarness()
    const late = createDshTranslator(deps)
    written.apply(translateAll(late, [spawnCall, member(41, 'provisioning'), member(42, 'failed'), { ...spawnResult(true), seq: 43 }]), replaying)
    assert.deepEqual(written.state.rows.filter(row => row.kind === 'tool'), [], `a spawn failing after its member is written stays on the roster (${replaying ? 'replay' : 'live'})`)
  }
}
console.log('PASS team tool cards (spawn_teammate → subagent row, a refused spawn → one error card live and on replay, none once its member is written, one-line call/result summaries, legacy names and unknown shapes stay raw)')
