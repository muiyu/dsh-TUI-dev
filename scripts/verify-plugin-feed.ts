/**
 * 批 C-4 第 1 件：嫡系 feed（`tui-profile/feed/first-party.json`）。
 *
 *   A. 随包发布：`package.json` 的 `files` 含 `tui-profile/feed`（与
 *      `verify-package.mjs` 的真名单断言互补——一个查声明、一个查 tarball）；
 *   B. 清单形状：版本取值、字段集合（未知字段即红：`entires` 这种拼写错误
 *      会让清单静默变空）、条目非空、无重名；
 *   C. 条目策略：scoped 包名 + `scope` 与名字里的 scope 逐字一致 + **精确版本**
 *      （范围一律拒绝）；本包自身的条目必须存在且与本包 `package.json` 的版本一致
 *      ——"一个版本钉死一份清单"因此是机器可查的事实，而不是口头承诺；
 *   D. 判定：命中 / 版本不符 / 未列出 / 名字缺失 / 清单不可用，五条分支逐条断言，
 *      **fail-closed**：除命中之外一律 third-party；非 registry 来源（本地目录 /
 *      tarball / git）单独一条 —— 它自己的 manifest 会替自己背书，不能当证据；
 *   E. 坏基线：八条注入实测于 commit `236cbe85`（"feed 目录摘出 files / 版本写成范围 /
 *      scope 与包名不符 / 判定跳过版本比较 / 未命中嫡系也不问确认 / 确认步 Esc 仍发起安装 /
 *      流程不按 binding 加栅栏 / 同步抛错被吞"）；本文件负责其中前三条，
 *      施工图（未入库）只作过程记录。
 *
 * 清单是**包管理**层的策展名单，不是协议数据：本门禁不读 `tui-profile/registry/`，
 * 也不改它（C-2 已冻结）。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-feed.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { firstPartyVerdict, loadFirstPartyFeed, type FirstPartyFeedLoad } from '../src/dsh-adapter/plugin-feed.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FEED_DIR = 'tui-profile/feed'

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── A. 随包发布 ──────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[]; name: string; version: string }
check('package.json files ships the feed directory',
  (manifest.files ?? []).includes(FEED_DIR), JSON.stringify(manifest.files))

// ── B. 清单形状（真文件） ─────────────────────────────────────────────────────
const load = loadFirstPartyFeed()
check('the shipped feed loads', load.kind === 'ok', JSON.stringify(load))
if (load.kind !== 'ok') throw new Error('feed must load before the rest can be checked')
const { feed } = load
check('the shipped feed is the in-tree one', load.path === join(ROOT, FEED_DIR, 'first-party.json'), load.path)
check('the feed declares feedVersion 1 and carries entries',
  feed.feedVersion === 1 && feed.entries.length > 0, JSON.stringify(feed))

// ── C. 条目策略 ──────────────────────────────────────────────────────────────
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
for (const entry of feed.entries) {
  check(`feed entry ${entry.name} is a well-formed package name`, PACKAGE_NAME.test(entry.name), entry.name)
  // The scope rule is spelled out here rather than read from the module under
  // test: an assertion that asks the implementation what the rule is proves
  // nothing about the rule.
  const scoped = /^@[^/]+\/[^/]+$/u.test(entry.name)
  check(`feed entry ${entry.name} is scoped and its scope field matches the name verbatim`,
    scoped && entry.name.slice(0, entry.name.indexOf('/')) === entry.scope,
    `${entry.name} / ${entry.scope}`)
  check(`feed entry ${entry.name} pins an exact version, not a range`,
    EXACT_VERSION.test(entry.version), entry.version)
}
const names = feed.entries.map(entry => entry.name)
check('the feed lists no duplicate name', new Set(names).size === names.length, names.join(', '))
const own = feed.entries.find(entry => entry.name === manifest.name)
check('the feed pins the package this release publishes, at the version it publishes',
  own !== undefined && own.version === manifest.version, `${JSON.stringify(own)} vs ${manifest.name}@${manifest.version}`)

// ── D. 判定的分支 ───────────────────────────────────────────────────────────
const hit = firstPartyVerdict(load, { name: manifest.name, version: manifest.version, kind: 'registry' })
check('a listed name at the pinned version is first-party',
  hit.kind === 'first-party' && hit.entry.version === manifest.version && hit.corroboration === 'unavailable', JSON.stringify(hit))
check('the pinned name at another version is third-party (a range is not a hit)',
  firstPartyVerdict(load, { name: manifest.name, version: '0.0.1', kind: 'registry' }).kind === 'third-party', JSON.stringify(hit))
check('the pinned name with no version at all is third-party ("latest" is not the pinned artifact)',
  firstPartyVerdict(load, { name: manifest.name, kind: 'registry' }).kind === 'third-party')
check('an unlisted name is third-party',
  firstPartyVerdict(load, { name: 'verify-not-on-the-feed', version: '1.0.0', kind: 'registry' }).kind === 'third-party')
check('a spec that names no package is third-party',
  firstPartyVerdict(load, {}).kind === 'third-party')
// A directory or git checkout ships the manifest it is judged by: it would be
// vouching for itself, so the feed has nothing to say about it.
for (const kind of ['path', 'tarball', 'git'] as const) {
  const verdict = firstPartyVerdict(load, { name: manifest.name, version: manifest.version, kind })
  check(`a ${kind} spec is third-party even when it claims a pinned name@version`,
    verdict.kind === 'third-party' && verdict.reason === 'unverifiable-source', JSON.stringify(verdict))
}

// ── E. 清单不可用 / 形状不认识：一律 fail closed ─────────────────────────────
/** 一份临时清单，放在只有第二个候选能命中的布局里（与编译产物同形）。 */
function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-feed-'))
  mkdirSync(join(root, FEED_DIR), { recursive: true })
  writeFileSync(join(root, FEED_DIR, 'first-party.json'), source)
  return pathToFileURL(join(root, 'lib', 'types', 'dsh-adapter', 'probe.js')).href
}
/**
 * 每份坏清单都指名它该触发的**那条**规则：只断言"不可用"会让 fixture 路径写错
 * （于是"文件缺失"也满足条件）时整段照样全绿。
 */
const MALFORMED: readonly (readonly [string, string, string])[] = [
  ['未知顶层字段（拼写错误会让清单静默变空）', JSON.stringify({ feedVersion: 1, entires: [] }), 'unexpected top-level fields'],
  ['未知 feedVersion', JSON.stringify({ feedVersion: 2, entries: [{ name: '@probe/x', scope: '@probe', version: '1.0.0' }] }), 'unknown feedVersion'],
  ['条目缺字段', JSON.stringify({ feedVersion: 1, entries: [{ name: '@probe/x', version: '1.0.0' }] }), 'unrecognized entry'],
  ['条目带未知字段', JSON.stringify({ feedVersion: 1, entries: [{ name: '@probe/x', scope: '@probe', version: '1.0.0', extra: 1 }] }), 'unrecognized entry'],
  ['scope 与包名不符', JSON.stringify({ feedVersion: 1, entries: [{ name: '@probe/x', scope: '@other', version: '1.0.0' }] }), 'unrecognized entry'],
  ['非 scoped 包名', JSON.stringify({ feedVersion: 1, entries: [{ name: 'probe', scope: '@probe', version: '1.0.0' }] }), 'unrecognized entry'],
  ['空清单', JSON.stringify({ feedVersion: 1, entries: [] }), 'no entries'],
  ['不是 JSON', '{ nope', 'not JSON'],
]
for (const [label, source, expected] of MALFORMED) {
  const broken: FirstPartyFeedLoad = loadFirstPartyFeed(fixture(source))
  check(`an unavailable feed names the rule it broke (${label})`,
    broken.kind === 'unavailable' && broken.reason.includes(expected), JSON.stringify(broken))
  check(`an unavailable feed never vouches for anything (${label})`,
    firstPartyVerdict(broken, { name: '@probe/x', version: '1.0.0', kind: 'registry' }).kind === 'third-party')
}
const missing = loadFirstPartyFeed(pathToFileURL(join(mkdtempSync(join(tmpdir(), 'dsh-no-feed-')), 'lib', 'types', 'dsh-adapter', 'probe.js')).href)
check('a missing feed file is unavailable, not silently empty',
  missing.kind === 'unavailable' && missing.reason.includes('missing'), JSON.stringify(missing))

console.log(`verify-plugin-feed OK (${passed} checks)`)
