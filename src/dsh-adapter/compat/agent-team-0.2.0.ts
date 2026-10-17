/**
 * Agent Teams 0.2.0 durable shapes, read as their 0.2.1 equivalents.
 *
 * The readers that meet these shapes call in here first, so the rest of the
 * adapter knows only the 0.2.1 forms (docs/agent-teams-design.md「兼容（0.2.0）」):
 * the translator and the subagent projection for mailbox deliveries, the
 * translator and agent-view for a teammate's first prompt. Session previews
 * (sessions/digest.ts) and the recap read no teammate session today: the
 * listings previews serve skip `origin: subagent`, and the recap reads only
 * the bound session. Route them here when a teammate session opens there.
 * The shapes are log compatibility, not host compatibility: a 0.2.1 host
 * still resumes sessions recorded under 0.2.0, so dropping the 0.2.0 host
 * line alone does not retire this module. It retires when reading
 * 0.2.0-era team logs is given up; then delete this file and its callers
 * (`grep -rn "compat(dsh 0.2.0"`).
 *
 * @module
 */

/** The 0.2.0 mailbox source a target session recorded for a team message. */
interface MailboxSource {
  readonly kind: 'team-message'
  readonly messageId?: unknown
  readonly senderId: string
  readonly senderName: string
}

function mailboxSourceOf(source: unknown): MailboxSource | undefined {
  const shape = source as { kind?: unknown; senderId?: unknown; senderName?: unknown } | null | undefined
  return shape?.kind === 'team-message' && typeof shape.senderId === 'string' && typeof shape.senderName === 'string'
    ? shape as MailboxSource
    : undefined
}

/**
 * A team message delivered by the 0.2.0 mailbox, as the relay it became:
 * source `{ kind: 'agent-message', form: 'relay', senderSessionId }`, first
 * block `Team message from <name>:`. The 0.2.0 framing block
 * (`Team message <id> from <name>:`) is replaced only when it matches this
 * message's identity exactly; otherwise it stays as content, as it did.
 * @param data - the message's source and content (other fields are kept).
 * @returns `data`, or a copy in the 0.2.1 form.
 */
export function teamMailboxAsRelay<T extends { readonly source?: unknown; readonly content?: unknown }>(data: T): T {
  const { source, content } = data
  const mailbox = mailboxSourceOf(source)
  if (mailbox === undefined || !Array.isArray(content)) return data
  const first = content[0] as { type?: unknown; text?: unknown } | undefined
  const legacyFraming = `Team message ${String(mailbox.messageId)} from ${mailbox.senderName}:`
  const body = first?.type === 'text' && first.text === legacyFraming ? content.slice(1) : content
  return {
    ...data,
    source: { kind: 'agent-message', form: 'relay', senderSessionId: mailbox.senderId },
    content: [{ type: 'text', text: `Team message from ${mailbox.senderName}:` }, ...body],
  } as T
}

/** The identity block 0.2.0 `spawn_teammate` put before a teammate's first prompt, around the name. */
const REMINDER_HEAD = '<system-reminder>\nYou are teammate "'
const REMINDER_TAIL = `".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`

function isTeammateReminder(block: unknown): boolean {
  const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown }
  if (type !== 'text' || typeof text !== 'string') return false
  if (text.length < REMINDER_HEAD.length + REMINDER_TAIL.length) return false
  if (!text.startsWith(REMINDER_HEAD) || !text.endsWith(REMINDER_TAIL)) return false
  return !text.slice(REMINDER_HEAD.length, text.length - REMINDER_TAIL.length).includes('\n')
}

/**
 * A teammate's first prompt without the leading `<system-reminder>` identity
 * block (0.2.1 carries it as a system-prompt context). Matched against the
 * whole 0.2.0 template, on a human-sourced message with more blocks after it;
 * callers apply it to the first prompt they read (a translator: the first
 * since its replay or reset). A reader that starts mid-log — a subagent
 * transcript page, the live translator after `history()` replayed on its own
 * instance — counts its first prompt as one, so only that prompt, pasted as
 * the exact template plus more blocks, could lose the block.
 * @param data - the message's source and content (other fields are kept).
 * @returns `data`, or a copy without the block.
 */
export function withoutTeammateReminder<T extends { readonly source?: unknown; readonly content?: unknown }>(data: T): T {
  const { source, content } = data
  if ((source as { kind?: unknown } | null | undefined)?.kind !== 'user') return data
  if (!Array.isArray(content) || content.length < 2 || !isTeammateReminder(content[0])) return data
  return { ...data, content: content.slice(1) } as T
}

/**
 * The 0.2.0 `send_message` result: the mailbox status of the queued message
 * (0.2.1 answers `{ sent: true }`).
 * @param value - the parsed tool result.
 * @returns `accepted` / `queued`, or `undefined` for anything else.
 */
export function legacySendMessageStatus(value: Readonly<Record<string, unknown>>): string | undefined {
  return value.status === 'accepted' || value.status === 'queued' ? value.status : undefined
}
