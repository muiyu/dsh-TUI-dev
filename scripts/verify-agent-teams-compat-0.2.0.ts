/**
 * compat(dsh 0.2.0, log): Agent Teams 0.2.0 durable shapes read as their
 * 0.2.1 equivalents (src/dsh-adapter/compat/agent-team-0.2.0.ts,
 * docs/agent-teams-design.md「兼容（0.2.0）」). Each case states one thing:
 * the 0.2.0 input produces exactly what the matching 0.2.1 input produces.
 * The 0.2.0 shapes are the ones recorded from the real 0.2.0-rc.2 team
 * service. Delete this script together with the compat module.
 *
 * Run: node --import tsx/esm scripts/verify-agent-teams-compat-0.2.0.ts
 */
import assert from 'node:assert/strict'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { createSubagentProjection } from '../src/dsh-adapter/channel/subagent-projection.js'
import { foldAgentViewEvents } from '../src/dsh-adapter/agent-view.js'
import { teamMailboxAsRelay, withoutTeammateReminder } from '../src/dsh-adapter/compat/agent-team-0.2.0.js'
import { teamToolResultView } from '../src/dsh-adapter/team-tools.js'

const LEAD = 'lead-1'
const MATE = 'd760b893-aa5a-450f-8d8e-472b8c09e6cd'
const messageId = 'team-message-6dc79833-e20b-4a30-bee5-99f2776e88f1'
const body = { type: 'text', text: 'reviewer report: diff ok' }

/** One delivery, as each line records it. */
const delivery = (source: unknown, content: readonly unknown[]) => ({
  type: 'user/message', seq: 21, time: 1792133614950,
  data: { role: 'user', id: '6e645a6d-4967-45bc-abee-06b1f92f5c23', content, source },
})
const mailboxSource = { kind: 'team-message', teamId: LEAD, messageId, senderId: MATE, senderName: 'reviewer' }
const relaySource = { kind: 'agent-message', form: 'relay', senderSessionId: MATE }
/** The identity block 0.2.0 spawn_teammate put before the first prompt (dsh-experimental-tool-agent-team 0.2.0-rc.2). */
const reminder = `<system-reminder>
You are teammate "reviewer".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`
const legacy = delivery(mailboxSource, [{ type: 'text', text: `Team message ${messageId} from reviewer:` }, body])
const current = delivery(relaySource, [{ type: 'text', text: 'Team message from reviewer:' }, body])

// ── the normalization itself ───────────────────────────────────────────────
{
  assert.deepEqual(teamMailboxAsRelay(legacy.data), current.data)
  // Framing that does not match this message's identity stays content.
  const reframed = [{ type: 'text', text: 'Team message other from reviewer:' }, body]
  assert.deepEqual(teamMailboxAsRelay({ source: mailboxSource, content: reframed }).content, [{ type: 'text', text: 'Team message from reviewer:' }, ...reframed])
  // Anything else comes back as the same object.
  for (const data of [{ source: { kind: 'user' }, content: [body] }, current.data]) {
    assert.equal(teamMailboxAsRelay(data), data)
  }
  for (const data of [{ source: { kind: 'user' }, content: [body] }, current.data, { source: { kind: 'user' }, content: [{ type: 'text', text: reminder.replace('Your Team Lead', 'My Team Lead') }, body] }]) {
    assert.equal(withoutTeammateReminder(data), data)
  }
  console.log('PASS mailbox delivery → relay (exact framing replaced, other framing kept, other messages untouched)')
}

// ── translator: transcript bubble, live and replay ─────────────────────────
{
  const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
  for (const replaying of [false, true]) {
    const translate = (event: unknown) => {
      const translator = createDshTranslator(deps)
      return replaying ? translator.translateReplay([event] as never) : translator.translateEvent(event as never)
    }
    assert.deepEqual(translate(legacy), translate(current), `same events (${replaying ? 'replay' : 'live'})`)
  }
  const reframedLegacy = delivery(mailboxSource, [{ type: 'text', text: 'Team message other from reviewer:' }, body])
  const message = createDshTranslator(deps).translateEvent(reframedLegacy as never).find(event => event.type === 'user.message')
  assert.ok(message?.type === 'user.message' && message.source === 'team-message' && message.text.startsWith('Team message other from reviewer:'))
  console.log('PASS translator reads a mailbox delivery as the relay (live + replay; foreign framing stays visible)')
}

// ── a teammate's first prompt ──────────────────────────────────────────────
{
  const deps = { tools: () => undefined, scope: () => ({}), attachments: () => undefined }
  const prompt = { type: 'text', text: 'Review src/ and report back.' }
  const first = (content: readonly unknown[]) => delivery({ kind: 'user' }, content)
  for (const replaying of [false, true]) {
    const translate = (event: unknown) => {
      const translator = createDshTranslator(deps)
      return replaying ? translator.translateReplay([event] as never) : translator.translateEvent(event as never)
    }
    const events = translate(first([{ type: 'text', text: reminder }, prompt]))
    assert.deepEqual(events, translate(first([prompt])), `the identity block is dropped (${replaying ? 'replay' : 'live'})`)
    const message = events.find(event => event.type === 'user.message')
    assert.ok(message?.type === 'user.message' && message.text === prompt.text, 'the bubble shows the task')
  }
  // The block alone (nothing after it) is somebody's text, kept.
  const alone = first([{ type: 'text', text: reminder }])
  assert.equal(withoutTeammateReminder(alone.data), alone.data)
  // Only a session's first prompt: a later message with the same blocks is
  // somebody's text, on the same translator and after a replay alike.
  const bubbleText = (events: readonly { type: string }[]) => events.flatMap(event => event.type === 'user.message' ? [(event as { text: string }).text] : [])
  const repeated = first([{ type: 'text', text: reminder }, prompt])
  const live = createDshTranslator(deps)
  assert.deepEqual(bubbleText([...live.translateEvent(repeated as never), ...live.translateEvent(repeated as never)]), [prompt.text, reminder.trim()])
  const resumed = createDshTranslator(deps)
  assert.deepEqual(bubbleText([...resumed.translateReplay([repeated] as never), ...resumed.translateEvent(repeated as never)]), [prompt.text, reminder.trim()])
  // A replay starts the count again.
  assert.deepEqual(bubbleText(resumed.translateReplay([repeated] as never)), [prompt.text])
  // agent-view: the first prompt and the summary name the task.
  const view = foldAgentViewEvents([repeated] as never, 0, { hasTurns: false, firstPrompt: '', summary: '', summaryKind: 'none', title: '', updatedAt: 0, lastTurnFailed: false })
  assert.equal(view.firstPrompt, prompt.text)
  assert.equal(view.summary, prompt.text)
  console.log('PASS teammate first prompt drops the 0.2.0 identity block (live + replay + agent-view; first prompt and exact template only)')
}

// ── subagent projection: the agent-message feed ────────────────────────────
{
  const folded = (event: unknown) => {
    const stateStub = { rows: [], subagents: [] as unknown[], subagentCost: [], emitCount: 0, emit() { this.emitCount += 1 }, emitStream() {} }
    const agent = { id: 'ag-1', status: 'idle', session: { id: LEAD } }
    const childSession = { id: 'sess-child-1' }
    const service = { prompt: async () => ({ messageId: 'msg-1' }), listChildren: async () => [] }
    const projection = createSubagentProjection(() => stateStub as never, { rowIds: { value: 0 }, agent: () => agent as never, subagents: () => service, lookupChild: () => undefined })
    projection.store.onSpawned('child-1', 'subagent')
    projection.store.linkSession('child-1', childSession)
    projection.onSessionEvent(childSession, event as never)
    return projection.control.message!.messages().map(({ observedAt: _observedAt, ...view }) => view)
  }
  const views = folded(legacy)
  assert.equal(views.length, 1)
  assert.deepEqual(views, folded(current))
  assert.equal(views[0]!.text, body.text, 'the feed shows the body, not the framing block')
  // The same delivery into the parent (the Lead's own feed).
  const parentFolded = (event: unknown) => {
    const stateStub = { rows: [], subagents: [] as unknown[], subagentCost: [], emitCount: 0, emit() { this.emitCount += 1 }, emitStream() {} }
    const agent = { id: 'ag-1', status: 'idle', session: { id: LEAD } }
    const service = { prompt: async () => ({ messageId: 'msg-1' }), listChildren: async () => [] }
    const projection = createSubagentProjection(() => stateStub as never, { rowIds: { value: 0 }, agent: () => agent as never, subagents: () => service, lookupChild: () => undefined })
    projection.onParentEvent(event, false, LEAD)
    return projection.control.message!.messages().map(view => view.text)
  }
  assert.deepEqual(parentFolded(legacy), [body.text], 'a 0.2.0 delivery into the Lead: body only')
  assert.deepEqual(parentFolded(current), [body.text], 'a 0.2.1 delivery into the Lead: body only')
  console.log('PASS subagent projection folds a mailbox delivery as the relay, the feed without the team framing')
}

// ── send_message result ────────────────────────────────────────────────────
{
  const args = JSON.stringify({ target: 'lead', message: 'reviewer report: diff ok' })
  assert.deepEqual(teamToolResultView('send_message', args, `{"messageId":"${messageId}","status":"queued"}`)?.content, [{ type: 'text', text: 'queued' }])
  assert.deepEqual(teamToolResultView('send_message', args, `{"messageId":"${messageId}","status":"accepted"}`)?.content, [{ type: 'text', text: 'accepted' }])
  console.log('PASS send_message mailbox status')
}
console.log('ALL PASS')
