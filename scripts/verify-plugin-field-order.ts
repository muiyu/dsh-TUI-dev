/**
 * statusBar.pluginFieldsOrder 的语法、归一化与渲染回归。
 *
 * 规则（/settings → Status bar → 插件底栏字段名单）：
 *  - `*`  = 全部插件字段（默认；各按声明槽、注册序，含以后注册的）
 *  - `''` = 一个都不显示（`;;` 同义）
 *  - 其余必须恰好三组：`a,b;c;d,e`，组序号 = 槽（left-tail / right-head /
 *    right-tail），组内顺序 = 该槽的显示顺序
 *  - 非法：组数 ≠ 3、`*` 混写、重复 key、空 token、非法字符
 *
 * 本脚本锁住纯函数面：解析、canonical 归一化、`applyPluginFieldsOrder` 的
 * 零分配/槽覆写/未知 key 跳过，以及两份契约常量（key 语法、槽名）与
 * `dsh-adapter/status.ts` 不漂移。渲染帧级用例在 verify-status-fields.tsx。
 *
 * Run: node --import tsx/esm scripts/verify-plugin-field-order.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ALL_PLUGIN_FIELDS,
  DEFAULT_STATUS_BAR,
  STATUS_FIELD_SLOTS,
  applyPluginFieldsOrder,
  formatPluginFieldsOrder,
  normalizePluginFieldsOrder,
  normalizeStatusBar,
  parsePluginFieldsOrder,
} from '../src/tuiDisplayPrefs.js'

let passed = 0

function check(name: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`✓ ${name}`)
}

// --- 形态：*, '', 三组 ------------------------------------------------------

check('P1 `*` 解析为全部', () => {
  assert.deepEqual(parsePluginFieldsOrder('*'), { mode: 'all' })
})

check("P2 空串解析为空", () => {
  assert.deepEqual(parsePluginFieldsOrder(''), { mode: 'none' })
})

check('P3 `;;` 解析为空（三个空组）', () => {
  assert.deepEqual(parsePluginFieldsOrder(';;'), { mode: 'none' })
})

check('P4 空组按位置保留', () => {
  assert.deepEqual(parsePluginFieldsOrder('a;;'), { mode: 'groups', groups: [['a'], [], []] })
  assert.deepEqual(parsePluginFieldsOrder(';b;'), { mode: 'groups', groups: [[], ['b'], []] })
  assert.deepEqual(parsePluginFieldsOrder(';;c'), { mode: 'groups', groups: [[], [], ['c']] })
})

check('P5 组内顺序保真', () => {
  assert.deepEqual(parsePluginFieldsOrder('a,b;;c'), {
    mode: 'groups',
    groups: [['a', 'b'], [], ['c']],
  })
  assert.deepEqual(parsePluginFieldsOrder('b,a;c;d'), {
    mode: 'groups',
    groups: [['b', 'a'], ['c'], ['d']],
  })
})

// --- 非法形态 ---------------------------------------------------------------

check('P6 组数必须恰好 3', () => {
  for (const value of ['a', 'a;b', 'a;b;c;d', ';']) {
    assert.deepEqual(parsePluginFieldsOrder(value), { mode: 'invalid', reason: 'groups' }, value)
  }
})

check('P7 `*` 必须单独出现', () => {
  for (const value of ['*;a;b', 'a;*;b', 'a;b;*', 'a*;;']) {
    assert.deepEqual(parsePluginFieldsOrder(value), { mode: 'invalid', reason: 'sentinel' }, value)
  }
})

check('P8 重复 key（含跨组）非法', () => {
  for (const value of ['a,a;;', 'a;;a', 'a;b;a', 'a,b;b;']) {
    assert.deepEqual(parsePluginFieldsOrder(value), { mode: 'invalid', reason: 'duplicate' }, value)
  }
})

check('P9 空 token 非法（打字错误不静默吞掉）', () => {
  for (const value of ['a,,b;;', ',a;;', 'a,;;', 'a;b,;']) {
    assert.deepEqual(parsePluginFieldsOrder(value), { mode: 'invalid', reason: 'token' }, value)
  }
})

check('P9b 只有空白的组按空组处理（不是空 token）', () => {
  assert.deepEqual(parsePluginFieldsOrder('a; ;b'), { mode: 'groups', groups: [['a'], [], ['b']] })
})

check('P10 非法字符非法、大小写归一', () => {
  for (const value of ['中文;;', 'a b;;', '-a;;', 'a::b;;']) {
    assert.deepEqual(parsePluginFieldsOrder(value), { mode: 'invalid', reason: 'token' }, value)
  }
  assert.deepEqual(parsePluginFieldsOrder('A-B:x1;;'), { mode: 'groups', groups: [['a-b:x1'], [], []] })
})

check('P11 空白与大小写归一为 canonical', () => {
  const parsed = parsePluginFieldsOrder(' a , B ; ; ')
  assert.equal(parsed.mode, 'groups')
  assert.equal(formatPluginFieldsOrder((parsed as { groups: string[][] }).groups), 'a,b;;')
  assert.equal(normalizePluginFieldsOrder(' a , B ; ; '), 'a,b;;')
  assert.equal(normalizePluginFieldsOrder(';;'), '')
  assert.equal(normalizePluginFieldsOrder('A;;'), 'a;;')
})

// --- 归一化 -----------------------------------------------------------------

check('P12 非字符串归一为默认 `*`', () => {
  for (const value of [undefined, null, 1, true, {}, [], '*']) {
    assert.equal(normalizePluginFieldsOrder(value), '*', String(value))
  }
})

check('P13 非法字符串原样保留（trim），渲染侧按全部', () => {
  assert.equal(normalizePluginFieldsOrder('a;b'), 'a;b')
  assert.equal(normalizePluginFieldsOrder('  a;b  '), 'a;b')
  const fields = [{ key: 'a', slot: 'left-tail' as const }]
  assert.equal(applyPluginFieldsOrder(fields, 'a;b'), fields)
})

check('P14 normalizeStatusBar：布尔键不变，名单显式值/默认值正确', () => {
  const base = normalizeStatusBar({})
  assert.equal(base.pluginFieldsOrder, '*')
  assert.equal(base.cwd, DEFAULT_STATUS_BAR.cwd)

  const off = normalizeStatusBar({ compact: false, cwd: false, pluginFieldsOrder: '' })
  assert.equal(off.compact, false)
  assert.equal(off.cwd, false)
  assert.equal(off.pluginFieldsOrder, '')

  // 布尔键上的垃圾值不会被抄进来（既有的收窄语义）。
  assert.equal(normalizeStatusBar({ model: 'nope' }).model, DEFAULT_STATUS_BAR.model)
  // 名单上的垃圾值归一为默认。
  assert.equal(normalizeStatusBar({ pluginFieldsOrder: 5 }).pluginFieldsOrder, '*')
  assert.equal(normalizeStatusBar({ pluginFieldsOrder: 'A,B;;' }).pluginFieldsOrder, 'a,b;;')
  // 一个键都不认识的输入仍然给出全部默认值。
  assert.deepEqual(normalizeStatusBar(null), { ...DEFAULT_STATUS_BAR })
})

// --- 渲染应用 ---------------------------------------------------------------

interface Entry { readonly key: string; readonly slot: 'left-tail' | 'right-head' | 'right-tail' }
const FIELDS: readonly Entry[] = [
  { key: 'a', slot: 'left-tail' },
  { key: 'b', slot: 'right-head' },
  { key: 'c', slot: 'right-tail' },
]

check('P15 `*` 与非法值返回入参引用（零分配）', () => {
  assert.equal(applyPluginFieldsOrder(FIELDS, '*'), FIELDS)
  assert.equal(applyPluginFieldsOrder(FIELDS, 'a'), FIELDS)
  assert.equal(applyPluginFieldsOrder(FIELDS, 'a;b'), FIELDS)
})

check("P16 空串返回空列表", () => {
  assert.deepEqual(applyPluginFieldsOrder(FIELDS, ''), [])
  assert.deepEqual(applyPluginFieldsOrder(FIELDS, ';;'), [])
})

check('P17 分组决定顺序与槽（用户覆写插件声明）', () => {
  const ordered = applyPluginFieldsOrder(FIELDS, 'c,a;;b')
  assert.deepEqual(ordered, [
    { key: 'c', slot: 'left-tail' },
    { key: 'a', slot: 'left-tail' },
    { key: 'b', slot: 'right-tail' },
  ])
  // 入参不被修改。
  assert.deepEqual(FIELDS.map(field => field.slot), ['left-tail', 'right-head', 'right-tail'])
})

check('P18 未列出的字段不出现，未知 key 静默跳过', () => {
  assert.deepEqual(applyPluginFieldsOrder(FIELDS, 'b;;'), [{ key: 'b', slot: 'left-tail' }])
  assert.deepEqual(applyPluginFieldsOrder(FIELDS, 'zz;;'), [])
  assert.deepEqual(applyPluginFieldsOrder(FIELDS, ';;zz'), [])
})

// --- 契约一致性 -------------------------------------------------------------

/** Quoted slot literals in one source fragment, in source order. */
function slotNames(source: string): string[] {
  return [...source.matchAll(/'([a-z]+(?:-[a-z]+)*)'/gu)].map(match => match[1] ?? '')
}

check('P19 key 语法与槽名不漂移', () => {
  const statusSource = readFileSync(new URL('../src/dsh-adapter/status.ts', import.meta.url), 'utf8')
  assert.match(statusSource, /\^\[a-z\]\[a-z0-9_-\]\*\(:\[a-z\]\[a-z0-9_-\]\*\)\*\$/u)
  // Whole-set comparison in both directions: merely finding each name
  // somewhere in the file would not catch a slot ADDED to status.ts (the
  // footer renderer only handles the three below, so such a field would be
  // admitted and then silently never render).
  const unionLine = /export type TuiStatusFieldSlot =([^\n]+)/u.exec(statusSource)?.[1] ?? ''
  assert.deepEqual(slotNames(unionLine), [...STATUS_FIELD_SLOTS])
  const setLine = /const FIELD_SLOTS = new Set<TuiStatusFieldSlot>\(\[([^\]]*)\]\)/u.exec(statusSource)?.[1] ?? ''
  assert.deepEqual(slotNames(setLine), [...STATUS_FIELD_SLOTS])
  assert.deepEqual([...STATUS_FIELD_SLOTS], ['left-tail', 'right-head', 'right-tail'])
})

check('P20 默认值就是 `*`（升级零变化）', () => {
  assert.equal(DEFAULT_STATUS_BAR.pluginFieldsOrder, ALL_PLUGIN_FIELDS)
  assert.equal(ALL_PLUGIN_FIELDS, '*')
})

console.log(`\n${passed} checks passed`)
