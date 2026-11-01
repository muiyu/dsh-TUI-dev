/**
 * statusBar.pluginFieldsOrder 勾选式字段选择器回归。
 *
 * Locked behavior:
 *  S1. 行枚举：三个槽小标题；`*` 全勾，`''` 全不勾，显式名单按名单序 + 未列出
 *      的字段在其声明槽内追加（未勾选）；被换槽的行标注「改自 …」。
 *  S2. 勾选映射：`*` 起第一次取消 = 先实体化再移除；勾回 = 追加到该组末尾；
 *      取消到空 = 写 `''`（没有「至少保留一个」的拒绝）。
 *  S3. 预填与收口：`*` 进高级行编辑时草稿是三组骨架；原样保存仍写 `*`，
 *      改过之后才写成显式名单。
 *  S3c. 活注册表为空时从 `*` 打开高级行（草稿 `;;`）、原样保存仍写 `*`，
 *       不得把它钉成 `''`。
 *  S3d. 已固定的名单恰好等于骨架时，原样保存仍保留该名单，不收回 `*`。
 *  S4. 非法草稿：invalid、拒绝保存、零写入。
 *  S5. 未认领 key 显示为已勾选占位行；取消即移除。
 *  S6. 列表尾部的原始文本行进入既有草稿编辑器（与文本字段同一套语义）。
 *  S7. 底部帮助栏给出语法（定义 hint），悬停/聚焦即可读到。
 *
 * Run: node --import tsx/esm scripts/verify-plugin-field-picker.tsx
 */
export {}

process.env.FORCE_COLOR = '3'
// English UI copy is asserted below; pin the language before any module
// import resolves the startup lang (env > persisted > locale).
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen },
  { Settings },
  { SETTING_DEFINITIONS },
  { normalizePluginFieldsOrder, parsePluginFieldsOrder },
  { t },
  { settled, viewportLines },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Settings.js'),
  import('../src/settings/definitions.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 120
const ROWS = 34

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const DEFINITION = SETTING_DEFINITIONS['statusBar.pluginFieldsOrder']!

/** The live registry the screen enumerates (a snapshot, like Chat's). */
const FIELDS = [
  { key: 'build', text: 'build 42%', slot: 'left-tail', tone: 'dim', maxCells: 16, minColumns: 0 },
  { key: 'ci', text: 'CI ok', slot: 'left-tail', tone: 'dim', maxCells: 16, minColumns: 0 },
  { key: 'git', text: 'main', slot: 'right-head', tone: 'dim', maxCells: 16, minColumns: 0 },
  { key: 'pet', text: 'pet', slot: 'right-tail', tone: 'dim', maxCells: 16, minColumns: 0 },
] as const

type Fields = typeof FIELDS
let setFields: (next: readonly Fields[number][]) => void = () => {}

// In-memory settings host: one namespace, the dsh-tui section shape.
const writes: { ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }[] = []
const docs: Record<string, { revision: number; value: Record<string, unknown>; user: Record<string, unknown> }> = {}
const host = {
  listNamespaces: () => Object.entries(docs).map(([ns, doc]) => ({
    ns,
    revision: doc.revision,
    applies: 'live' as const,
    value: { ...doc.value },
    user: { ...doc.user },
  })),
  write: (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
    writes.push({ ns, ops })
    const doc = docs[ns]
    if (doc === undefined) return Promise.reject(new Error(`unknown namespace ${ns}`))
    doc.revision += 1
    for (const op of ops) {
      let parent = doc.value
      for (const segment of op.path.slice(0, -1)) {
        const child = parent[segment]
        if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
          parent = child as Record<string, unknown>
        } else {
          parent[segment] = {}
          parent = parent[segment] as Record<string, unknown>
        }
      }
      if (op.op === 'unset') delete parent[op.path[op.path.length - 1]!]
      else parent[op.path[op.path.length - 1]!] = op.value
    }
    return Promise.resolve()
  },
  credentialConfigured: () => Promise.resolve(false),
  writeCredential: () => Promise.resolve(),
}

function makeChannel(): unknown {
  return {
    settingsHost: () => host,
    settingsSections: () => [{
      ns: 'dsh-tui',
      title: 'TUI',
      groups: [{ id: 'status-bar', title: 'Status bar' }],
      fields: [{
        path: ['statusBar', 'pluginFieldsOrder'],
        label: DEFINITION.label,
        hint: DEFINITION.hint,
        kind: 'text' as const,
        group: 'status-bar',
        // Mirrors plugin.ts: an illegal shape blocks the save, and an empty
        // draft is a SET of '' (not the editor's default clear).
        parse(text: string) {
          return parsePluginFieldsOrder(text).mode === 'invalid'
            ? undefined
            : { kind: 'set' as const, value: normalizePluginFieldsOrder(text) }
        },
      }],
    }],
    subscribeSettingsSections: () => () => {},
  }
}

class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

/** The set ops this scenario wrote for statusBar.pluginFieldsOrder, in order. */
const listWrites = (): string[] =>
  writes.filter(w => w.ns === 'dsh-tui')
    .flatMap(w => w.ops)
    .filter(op => op.op === 'set' && op.path.join('.') === 'statusBar.pluginFieldsOrder')
    .map(op => String(op.value))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** One rendered screen fixture: its own xterm buffer, stdout, stdin. */
async function openScreen(stored: string, fields: readonly Fields[number][] = FIELDS) {
  docs['dsh-tui'] = { revision: 1, value: { statusBar: { pluginFieldsOrder: stored } }, user: {} }
  writes.length = 0
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 20, allowProposedApi: true })
  class Stdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const stdin = new FakeStdin()
  const instance = await render(
    <AlternateScreen>
      <Harness fields={fields} />
    </AlternateScreen>,
    { stdout: new Stdout() as never, stdin: stdin as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const view = (): string => viewportLines(term, ROWS).join('\n')
  const has = (s: string): boolean => view().includes(s)
  return { stdin, view, has, close: async () => { await instance.unmount() } }
}

/** The live-registry case needs the prop to change under an open screen. */
function Harness({ fields }: { fields: readonly Fields[number][] }) {
  const [live, setLive] = React.useState<readonly Fields[number][]>(fields)
  setFields = next => setLive(next)
  return React.createElement(Settings, {
    channel: makeChannel() as never,
    onClose: () => {},
    statusFields: live,
  })
}

/** Open the Status bar subpage; the focus lands on the first field row. */
async function openPicker(stored: string, fields: readonly Fields[number][] = FIELDS) {
  const screen = await openScreen(stored, fields)
  screen.stdin.write('\r')
  if (!await settled(() => screen.has('Plugin field list'), { timeoutMs: 4000 })) return null
  await sleep(80) // 固定窗:pacing 焦点落在第一行只改颜色，无可 settle 的文本锚点
  return screen
}

async function arrow(stdin: FakeStdin, direction: 'down' | 'up', times: number): Promise<void> {
  const key = direction === 'down' ? '\x1b[B' : '\x1b[A'
  for (let i = 0; i < times; i++) {
    stdin.write(key)
    await sleep(60) // 固定窗:pacing 焦点步进只改颜色，无可 settle 条件
  }
}

// ── S1. rows: slots, checked state, moved annotation ───────────────────────
{
  const auto = await openPicker('*')
  if (auto === null) { check('S1 picker subpage opens', false); process.exit(1) }
  check('S1 three slot subheads render',
    auto.has(t('settings-fields-slot-left-tail'))
    && auto.has(t('settings-fields-slot-right-head'))
    && auto.has(t('settings-fields-slot-right-tail')))
  check('S1 `*` starts with every row checked',
    auto.has('[✓ ] · build 42%') && auto.has('[✓ ] · CI ok')
    && auto.has('[✓ ] · main') && auto.has('[✓ ] · pet'))
  check('S1 advanced row shows the stored `*`', auto.has('*'))
  await auto.close()
}

{
  const listed = await openPicker('build;;')
  if (listed === null) { check('S1 listed scenario opens', false); process.exit(1) }
  check('S1 listed key checked, unlisted ones unchecked in their slots',
    listed.has('[✓ ] · build 42%') && listed.has('[  ] · CI ok')
    && listed.has('[  ] · main') && listed.has('[  ] · pet'))
  await listed.close()
}

{
  const moved = await openPicker(';;build')
  if (moved === null) { check('S1 moved scenario opens', false); process.exit(1) }
  check('S1 a key listed in another group is marked as moved',
    moved.has(t('settings-fields-moved', { slot: t('settings-fields-slot-left-tail') })),
    moved.view().split('\n').filter(line => line.includes('build')).join(' | '))
  await moved.close()
}

// ── S2. toggle mapping: materialize, append, collapse to '' ────────────────
{
  const screen = await openPicker('*')
  if (screen === null) { check('S2 scenario opens', false); process.exit(1) }
  // Row order under `*`: build, ci, git, pet  ->  git is the third row.
  await arrow(screen.stdin, 'down', 2)
  screen.stdin.write('\r')
  check('S2 first toggle materializes the list without the key',
    await settled(() => listWrites().includes('build,ci;;pet'), { timeoutMs: 4000 }),
    listWrites().join(' | '))
  check('S2 the unticked row turns empty', await settled(() => screen.has('[  ] · main'), { timeoutMs: 4000 }))
  // Tick it back: appended to the end of its own group (right group head).
  await arrow(screen.stdin, 'up', 0)
  screen.stdin.write('\r')
  check('S2 ticking appends to the end of its slot group',
    await settled(() => listWrites().includes('build,ci;git;pet'), { timeoutMs: 4000 }),
    listWrites().join(' | '))
  await screen.close()
}

{
  // `''` (none) is reachable: unticking the last listed key writes an empty set.
  const screen = await openPicker('build;;')
  if (screen === null) { check('S2 none scenario opens', false); process.exit(1) }
  screen.stdin.write('\r')
  check('S2 unticking the last key writes an empty list, no refusal',
    await settled(() => listWrites().includes(''), { timeoutMs: 4000 })
    && !screen.has(t('settings-panels-min-one')),
    listWrites().join(' | '))
  await screen.close()
}

// ── S3. prefill + no-op commit ─────────────────────────────────────────────
{
  const screen = await openPicker('*')
  if (screen === null) { check('S3 scenario opens', false); process.exit(1) }
  // Four rows, then the advanced row.
  await arrow(screen.stdin, 'down', FIELDS.length)
  screen.stdin.write('\r')
  check('S3 entering the advanced row pre-fills the three-group skeleton',
    await settled(() => screen.has('build,ci;git;pet▌'), { timeoutMs: 4000 }),
    screen.view().split('\n').filter(line => line.includes('Advanced')).join(' | '))
  screen.stdin.write('\r')
  check('S3 saving the untouched skeleton keeps the automatic `*`',
    await settled(() => listWrites().includes('*'), { timeoutMs: 4000 })
    && !listWrites().some(value => value === 'build,ci;git;pet'),
    listWrites().join(' | '))
  await screen.close()
}

// ── S3b. a real edit commits the explicit list ─────────────────────────────
{
  const screen = await openPicker('*')
  if (screen === null) { check('S3b scenario opens', false); process.exit(1) }
  await arrow(screen.stdin, 'down', FIELDS.length)
  screen.stdin.write('\r')
  await settled(() => screen.has('build,ci;git;pet▌'), { timeoutMs: 4000 })
  // Delete the last key ("pet") char by char, then confirm.
  // 固定窗:pacing 退格是同步写入，逐字符之间只留一个渲染步
  for (let i = 0; i < 3; i++) { screen.stdin.write('\x7f'); await sleep(30) }
  screen.stdin.write('\r')
  check('S3b an edited list is written verbatim (canonical)',
    await settled(() => listWrites().includes('build,ci;git;'), { timeoutMs: 4000 }),
    listWrites().join(' | '))
  await screen.close()
}

// ── S3c. no registered fields: an untouched skeleton must still keep `*` ───
{
  const screen = await openPicker('*', [])
  if (screen === null) { check('S3c scenario opens', false); process.exit(1) }
  // The advanced row is the only focusable row when the registry is empty.
  screen.stdin.write('\r')
  await settled(() => screen.has(';;▌'), { timeoutMs: 4000 })
  screen.stdin.write('\r')
  check('S3c an untouched skeleton with no fields keeps the automatic `*`',
    await settled(() => listWrites().includes('*'), { timeoutMs: 4000 })
    && !listWrites().includes(''), listWrites().join(' | '))
  await screen.close()
}

// ── S3d. an explicit list equal to the skeleton must not collapse to `*` ───
{
  const screen = await openPicker('build,ci;git;pet')
  if (screen === null) { check('S3d scenario opens', false); process.exit(1) }
  await arrow(screen.stdin, 'down', FIELDS.length)
  screen.stdin.write('\r')
  await settled(() => screen.has('build,ci;git;pet▌'), { timeoutMs: 4000 })
  screen.stdin.write('\r')
  check('S3d an unedited explicit list stays pinned (no silent collapse to `*`)',
    await settled(() => listWrites().includes('build,ci;git;pet'), { timeoutMs: 4000 })
    && !listWrites().includes('*'), listWrites().join(' | '))
  await screen.close()
}

// ── S4. illegal draft blocks the save ──────────────────────────────────────
{
  const screen = await openPicker('*')
  if (screen === null) { check('S4 scenario opens', false); process.exit(1) }
  await arrow(screen.stdin, 'down', FIELDS.length)
  screen.stdin.write('\r')
  await settled(() => screen.has('build,ci;git;pet▌'), { timeoutMs: 4000 })
  // Wipe the draft and type a one-group value ("build"): groups ≠ 3.
  for (let i = 0; i < 20; i++) { screen.stdin.write('\x7f') }
  // 固定窗:pacing 逐字符输入之间留一个渲染步，避免整串被当作一次 paste
  for (const char of 'build') { screen.stdin.write(char); await sleep(20) }
  screen.stdin.write('\r')
  check('S4 illegal list keeps the editor open with the invalid notice',
    await settled(() => screen.has(t('settings-field-invalid')), { timeoutMs: 4000 }))
  check('S4 illegal list writes nothing', !listWrites().some(value => value === 'build'), listWrites().join(' | '))
  await screen.close()
}

// ── S5. unclaimed keys are checked placeholders ────────────────────────────
{
  const screen = await openPicker('build;;future:slot')
  if (screen === null) { check('S5 scenario opens', false); process.exit(1) }
  check('S5 unclaimed key renders as a checked row',
    /\[✓ \][^\n]*future:slot/u.test(screen.view()), screen.view().split('\n').filter(l => l.includes('future')).join(' | '))
  check('S5 unclaimed row explains itself', screen.has(t('settings-fields-unclaimed')))
  // Rows: build, ci | git | future:slot, pet — untick the ghost at index 3.
  await arrow(screen.stdin, 'down', 3)
  screen.stdin.write('\r')
  check('S5 unticking the placeholder removes only it',
    await settled(() => listWrites().includes('build;;'), { timeoutMs: 4000 }),
    listWrites().join(' | '))
  await screen.close()
}

// ── S6. the advanced row edits like a text field (Esc discards) ────────────
{
  const screen = await openPicker('build;;')
  if (screen === null) { check('S6 scenario opens', false); process.exit(1) }
  await arrow(screen.stdin, 'down', 4)
  screen.stdin.write('\r')
  await settled(() => screen.has('build;;▌'), { timeoutMs: 4000 })
  screen.stdin.write('x')
  screen.stdin.write('\x1b') // Esc
  check('S6 Esc leaves the draft uncommitted', await settled(() => !screen.has('build;;x▌'), { timeoutMs: 4000 }))
  check('S6 Esc writes nothing', listWrites().length === 0, listWrites().join(' | '))
  await screen.close()
}

// ── S7. the help bar carries the grammar hint ──────────────────────────────
{
  const screen = await openPicker('*')
  if (screen === null) { check('S7 scenario opens', false); process.exit(1) }
  const hintHead = DEFINITION.hint.slice(0, 24)
  check('S7 focused row shows the definition hint (grammar in the help bar)',
    await settled(() => screen.has(hintHead), { timeoutMs: 4000 }),
    screen.view().split('\n').slice(-3).join(' | '))
  await screen.close()
}

// ── S8. the picker follows the live registry ───────────────────────────────
{
  const screen = await openPicker('build;;')
  if (screen === null) { check('S8 scenario opens', false); process.exit(1) }
  setFields([...FIELDS, { key: 'extra', text: 'extra', slot: 'right-head', tone: 'dim', maxCells: 16, minColumns: 0 }])
  check('S8 a field registered while the screen is open appears as a row',
    await settled(() => screen.has('[  ] · extra'), { timeoutMs: 4000 }),
    screen.view().split('\n').filter(line => line.includes('extra')).join(' | '))
  await screen.close()
}

console.log(failed === 0 ? '\nall picker checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
