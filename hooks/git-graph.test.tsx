import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Commit } from '../types'
import {
  buildSvg,
  changesTone,
  chipsOf,
  compareTone,
  describeCompare,
  describeFile,
  describeTrack,
  escapeXml,
  layoutGraph,
  parseBranches,
  parseDiffNames,
  parseLog,
  parseStatus,
  pickPending,
  splitPath,
  stampOf,
  trackTone,
} from './graph'

const commit = (hash: string, parents: string[], refs: string[] = []): Commit => ({
  hash,
  parents,
  refs,
  subject: `subject ${hash}`,
  author: 'a',
  time: 1000,
})

test('a straight history stays in one lane', () => {
  const { rows, lanes } = layoutGraph([commit('c', ['b']), commit('b', ['a']), commit('a', [])])

  expect(lanes).toBe(1)
  expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
  expect(rows[2]?.edges).toEqual([])
})

test('a merge opens a lane, and it bends back where its branch began', () => {
  // m merges x into b; both come from a.
  const { rows, lanes } = layoutGraph([
    commit('m', ['b', 'x']),
    commit('x', ['a']),
    commit('b', ['a']),
    commit('a', []),
  ])

  expect(lanes).toBe(2)
  const [m, x, b, a] = rows

  expect(m?.lane).toBe(0)
  expect(x?.lane).toBe(1)
  expect(m?.edges.map(edge => [edge.from, edge.to])).toEqual([[0, 0], [0, 1]])
  expect(b?.lane).toBe(0)
  // Both lanes wait for a: the second bends into the first on a's row.
  expect(a?.lane).toBe(0)
  expect(b?.edges.map(edge => [edge.from, edge.to]).sort()).toEqual([[0, 0], [1, 0]])
})

test('two branch tips side by side get lanes of their own', () => {
  const { rows } = layoutGraph([commit('t1', ['a']), commit('t2', ['a']), commit('a', [])])

  expect(rows[0]?.lane).toBe(0)
  expect(rows[1]?.lane).toBe(1)
  expect(rows[2]?.lane).toBe(0)
})

test('a window cut mid-history keeps edges running off the bottom', () => {
  const { rows } = layoutGraph([commit('c', ['b'])])

  expect(rows[0]?.edges.map(edge => edge.target)).toEqual(['b'])
})

test('git log output parses, refs and merges included', () => {
  const stdout =
    'aaa\x1fbbb ccc\x1fHEAD -> dev, origin/dev, tag: v1\x1fMerge x\x1fGolf\x1f1700000000\x1e\n' +
    'bbb\x1f\x1f\x1froot\x1fGolf\x1f1600000000\x1e\n'
  const [first, second] = parseLog(stdout)

  expect(first?.parents).toEqual(['bbb', 'ccc'])
  expect(first?.refs).toEqual(['HEAD -> dev', 'origin/dev', 'tag: v1'])
  expect(second?.parents).toEqual([])
  expect(second?.subject).toBe('root')
})

test('branches parse: origin/HEAD is dropped, locals come first', () => {
  const stdout = [
    'refs/remotes/origin/HEAD\torigin\trefs/remotes/origin/main\t\t\t1',
    'refs/remotes/origin/main\torigin/main\t\t\t\t500',
    'refs/heads/old\told\t\t\t\t100',
    'refs/heads/dev\tdev\t\torigin/dev\tahead 2, behind 1\t200',
  ].join('\n')
  const branches = parseBranches(stdout)

  expect(branches.map(one => one.name)).toEqual(['dev', 'old', 'origin/main'])
  expect(describeTrack(branches[0]!)).toBe('dev: รอ push 2 · รอ pull 1 commit')
  expect(describeTrack(branches[1]!)).toBe('old ยังไม่มีบน remote')
})

test('a comparison says who leads', () => {
  const base = { a: 'x', b: 'dev' }

  expect(describeCompare({ ...base, ahead: 3, behind: 0 })).toBe('x นำ dev อยู่ 3 commit')
  expect(describeCompare({ ...base, ahead: 0, behind: 2 })).toBe('x ตาม dev อยู่ 2 commit')
  expect(describeCompare({ ...base, ahead: 3, behind: 2 })).toBe('x แยกทางกับ dev: นำ 3 · ตาม 2 commit')
  expect(describeCompare({ ...base, ahead: 0, behind: 0 })).toBe('x เท่ากับ dev')
})

test('a local branch and its remote copy read as one chip, head first', () => {
  const chips = chipsOf(['origin/x', 'HEAD -> dev', 'origin/dev', 'tag: v1'], new Set(['origin/dev', 'origin/x']))

  expect(chips).toEqual([
    { text: 'dev ☁', kind: 'head' },
    { text: 'origin/x', kind: 'remote' },
    { text: 'v1', kind: 'tag' },
  ])
})

test('a hostile commit subject cannot reach the markup raw', () => {
  const evil = '</text><script>alert(1)</script>\u0001'
  const { source } = buildSvg([{ ...commit('c', []), subject: evil }], {
    width: 800,
    now: 2000,
    remoteNames: new Set(),
  })

  expect(source.includes('<script>')).toBe(false)
  expect(escapeXml(evil).includes('\u0001')).toBe(false)
})

test('a huge history stays under what a Svg takes', () => {
  const commits: Commit[] = Array.from({ length: 2000 }, (_, i) => ({
    ...commit(`h${i}`, i < 1999 ? [`h${i + 1}`] : []),
    subject: 'x'.repeat(120),
  }))
  const { source, rowsDrawn } = buildSvg(commits, {
    width: 800,
    now: 2000,
    remoteNames: new Set(),
  })

  expect(source.length <= 131072).toBe(true)
  expect(rowsDrawn > 0 && rowsDrawn < 2000).toBe(true)
})

test('the open tool reads its repo off the event and opens the pane', async ($, on) => {
  const repos: (string | undefined)[] = []

  on('process.run', (_, e) => {
    repos.push(e.init?.cwd)

    return {
      value: { exitCode: 0, stdout: '/r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }))

  const ran = await $.tool.call({ tool: 'mcp__git-graph__open', repo: '/r' } as never)

  expect(ran.deny).toBeUndefined()
  expect(repos[0]).toBe('/r')
  expect(typeof (ran as { result?: unknown }).result).toBe('string')
})

test('a later page keeps its lanes and takes what comes down from above', () => {
  const commits: Commit[] = Array.from({ length: 120 }, (_, i) =>
    commit(`h${i}`, i < 119 ? [`h${i + 1}`] : []),
  )
  const first = buildSvg(commits, { width: 800, now: 2000, remoteNames: new Set(), start: 0, count: 50 })
  const second = buildSvg(commits, { width: 800, now: 2000, remoteNames: new Set(), start: 50, count: 50 })

  expect(first.rowsDrawn).toBe(50)
  expect(second.rowsDrawn).toBe(50)
  expect(second.source.includes('subject h50')).toBe(true)
  expect(second.source.includes('subject h49')).toBe(false)
  expect(second.source.length < 70000).toBe(true)
})

test('a repo with many branches and commits draws on the desktop', async ($, on) => {
  const names = Array.from({ length: 120 }, (_, i) => `b${i}`)
  const log = Array.from({ length: 101 }, (_, i) =>
    `h${i}\x1fh${i + 1}\x1f\x1fsubject ${i}\x1fa\x1f1000\x1e`,
  ).join('\n')

  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    const stdout = argv.includes('log')
      ? log
      : argv.includes('rev-list')
        ? '1\t2\n'
        : argv.includes('symbolic-ref')
          ? 'b0\n'
          : argv.includes('for-each-ref')
            ? names.map(n => `refs/heads/${n}\t${n}\t\t\t\t1000`).join('\n')
            : '/r\n'

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__git-graph__open', repo: '/r' } as never)

  const ui = await $.ui.mount({
    plugin: 'git-graph',
    component: 'Pane',
    requestId: 'git-graph',
    surface: 'desktop',
    props: {
      title: 'Git Graph',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  expect((await ui.find({ type: 'Text', text: /b1 ตาม b0 อยู่ 2 commit|b1 แยกทางกับ b0/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'older' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('labels share a row with the commit, and a long message slides on hover', () => {
  const long = 'x'.repeat(150)
  const commits = [{ ...commit('c', ['b'], ['HEAD -> dev']), subject: long }, commit('b', ['a']), commit('a', [])]
  const narrow = buildSvg(commits, { width: 400, now: 2000, remoteNames: new Set() })
  const wide = buildSvg(commits, { width: 800, now: 2000, remoteNames: new Set() })

  expect(narrow.height).toBe(wide.height)
  expect(narrow.height).toBe(3 * 38 + 19)
  expect(narrow.source.includes(`${long}<tspan`)).toBe(true)
  expect(narrow.source.includes('--x:-')).toBe(true)
  // The app removes this element, so the drawing must not lean on it.
  expect(narrow.source.includes('foreignObject')).toBe(false)
})

test('a message that fits does not slide', () => {
  const { source } = buildSvg([commit('c', [])], { width: 800, now: 2000, remoteNames: new Set() })

  expect(source.includes('--x:-')).toBe(false)
})

test('a narrow pane keeps one label and counts the rest', () => {
  const commits = [commit('c', [], ['HEAD -> dev', 'x', 'y'])]
  const { source } = buildSvg(commits, { width: 400, now: 2000, remoteNames: new Set() })

  expect(source.includes('>+2</text>')).toBe(true)
})

test('a full page of 100 long commits fits what a pane can take', () => {
  const commits: Commit[] = Array.from({ length: 100 }, (_, i) => ({
    ...commit(`${'f'.repeat(38)}${i}`, i < 99 ? [`${'f'.repeat(38)}${i + 1}`] : []),
    subject: 'ก'.repeat(150),
    author: 'someone with a long name',
  }))
  const { rowsDrawn, source } = buildSvg(commits, { width: 420, now: 2000, remoteNames: new Set(), count: 100 })

  expect(rowsDrawn).toBe(100)
  expect(source.length < 88000).toBe(true)
})

test('the branch list ticks any number of branches, and the log follows', async ($, on) => {
  const names = ['dev', 'a', 'b', 'c', 'd']
  const calls: (readonly string[])[] = []

  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]

    calls.push(argv)
    const stdout = argv.includes('log')
      ? 'h1\x1f\x1fHEAD -> dev\x1fone\x1fa\x1f1000\x1e'
      : argv.includes('rev-list')
        ? '1\t0\n'
        : argv.includes('symbolic-ref')
          ? 'dev\n'
          : argv.includes('for-each-ref')
            ? names.map(n => `refs/heads/${n}\t${n}\t\t\t\t1000`).join('\n')
            : '/r\n'

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__git-graph__open', repo: '/r' } as never)

  const ui = await $.ui.mount({
    plugin: 'git-graph',
    component: 'Pane',
    requestId: 'git-graph',
    surface: 'desktop',
    props: {
      title: 'Git Graph',
      isFocused: false,
      bodyColumns: 50,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  // A press starts work it does not wait for: let the host's replies come in.
  const settle = () =>
    new Promise<void>(resolve => {
      ;(globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, 30)
    })

  expect((await ui.find({ type: 'Button', key: 'branch:a' })) === undefined).toBe(true)
  await ui.press({ key: 'branches' })
  await settle()

  for (const name of ['a', 'b', 'c', 'd']) {
    await ui.press({ key: `branch:${name}` })
    await settle()
  }

  const logs = calls.filter(argv => argv.includes('log'))
  const last = logs[logs.length - 1] ?? []

  for (const name of ['a', 'b', 'c', 'd']) expect(last.includes(name)).toBe(true)
  expect(last.includes('--branches')).toBe(false)

  await ui.press({ key: 'branch-all' })
  await settle()
  const after = calls.filter(argv => argv.includes('log')).at(-1) ?? []

  expect(after.includes('--branches')).toBe(true)
  await ui.unmount()
})

test('a very narrow pane stays top-aligned and its label stays clear of the lanes', () => {
  const commits = [commit('c', [], ['HEAD -> feature/a-very-long-branch-name'])]
  const { source } = buildSvg(commits, { width: 180, now: 2000, remoteNames: new Set() })
  const chipX = Number(/class="c-head" x="([\d.]+)"/.exec(source)?.[1] ?? 0)

  expect(source.includes('preserveAspectRatio="xMinYMin meet"')).toBe(true)
  expect(chipX >= 36).toBe(true)
})

// Both strings are what git 2.54 printed for a real repo, with staged and unstaged
// changes, a rename, a Thai file name with a space, and files not yet added.
test('status reads staged, unstaged, renamed, Thai and untracked files', () => {
  const stdout = 'D  added.txt\0R  mod2.txt\0mod.txt\0 M ไฟล์ ไทย.txt\0?? added.txt\0?? untracked.txt\0'

  expect(parseStatus(stdout)).toEqual([
    { kind: 'deleted', path: 'added.txt' },
    { kind: 'renamed', path: 'mod2.txt', from: 'mod.txt' },
    { kind: 'modified', path: 'ไฟล์ ไทย.txt' },
    { kind: 'untracked', path: 'added.txt' },
    { kind: 'untracked', path: 'untracked.txt' },
  ])
})

test('status tells a conflict and a file deleted after staging', () => {
  expect(parseStatus('UU a\0AA b\0DD c\0MD d\0AM e\0').map(one => one.kind)).toEqual([
    'conflict',
    'conflict',
    'conflict',
    'deleted',
    'added',
  ])
  expect(parseStatus('')).toEqual([])
})

test('a diff of names reads every kind, with a rename from and to', () => {
  const stdout = 'A\0added.txt\0D\0gone.txt\0M\0mod.txt\0R100\0old.txt\0new.txt\0'

  expect(parseDiffNames(stdout)).toEqual([
    { kind: 'added', path: 'added.txt' },
    { kind: 'deleted', path: 'gone.txt' },
    { kind: 'modified', path: 'mod.txt' },
    { kind: 'renamed', path: 'new.txt', from: 'old.txt' },
  ])
  expect(parseDiffNames('')).toEqual([])
})

test('a file reads in Thai, and a rename shows both names', () => {
  expect(describeFile({ kind: 'modified', path: 'a.ts' })).toBe('แก้ไข · a.ts')
  expect(describeFile({ kind: 'renamed', path: 'b.ts', from: 'a.ts' })).toBe('เปลี่ยนชื่อ · a.ts → b.ts')
})

test('dev against main, with sensible stand-ins, and nothing to compare says so', () => {
  const local = (...names: string[]) =>
    names.map(name => ({ name, isRemote: false, upstream: '', track: '', time: 0 }))

  expect(pickPending(local('dev', 'main', 'x'), 'x')).toEqual({ from: 'dev', to: 'main' })
  expect(pickPending(local('x', 'master'), 'x')).toEqual({ from: 'x', to: 'master' })
  expect(pickPending(local('main'), 'main')).toBe(null)
  expect(pickPending(local('x'), 'x')).toBe(null)
  expect(pickPending([{ name: 'main', isRemote: true, upstream: '', track: '', time: 0 }], 'x')).toBe(null)
})

test('a stamp changes with the text and stays short', () => {
  expect(stampOf('a') === stampOf('b')).toBe(false)
  expect(stampOf('x'.repeat(100000)).length < 20).toBe(true)
})

const mountWith = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  answers: { status?: string; diff?: string; isDiffOk?: boolean; heads?: string[]; head?: string },
) => {
  const calls: (readonly string[])[] = []
  const heads = answers.heads ?? ['dev', 'main']

  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]

    calls.push(argv)
    const isDiff = argv.includes('diff')
    const stdout = isDiff
      ? (answers.diff ?? '')
      : argv.includes('status')
        ? (answers.status ?? '')
        : argv.includes('log')
          ? 'h1\x1f\x1fHEAD -> dev\x1fone\x1fa\x1f1000\x1e'
          : argv.includes('rev-list')
            ? '1\t0\n'
            : argv.includes('symbolic-ref')
              ? `${answers.head ?? 'dev'}\n`
              : argv.includes('for-each-ref')
                ? heads.map(n => `refs/heads/${n}\t${n}\t\t\t\t1000`).join('\n')
                : '/r\n'

    return {
      value: {
        exitCode: isDiff && answers.isDiffOk === false ? 128 : 0,
        stdout,
        stderr: isDiff && answers.isDiffOk === false ? 'fatal: no merge base' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }))
  await $.tool.call({ tool: 'mcp__git-graph__open', repo: '/r' } as never)

  const ui = await $.ui.mount({
    plugin: 'git-graph',
    component: 'Pane',
    requestId: 'git-graph',
    surface: 'desktop',
    props: {
      title: 'Git Graph',
      isFocused: false,
      bodyColumns: 50,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  return { ui, calls }
}

test('Changes lists uncommitted files and what dev has not given main', async ($, on) => {
  const { ui, calls } = await mountWith($, on, {
    status: ' M hooks/a.ts\0?? ใหม่.txt\0',
    diff: 'M\0hooks/b.ts\0',
  })
  const has = async (text: RegExp) => (await ui.find({ type: 'Text', text })) !== undefined

  expect(await has(/ยังไม่ commit บน dev/)).toBe(true)
  expect(await has(/^2 ไฟล์$/)).toBe(true)
  expect(await has(/^a\.ts$/)).toBe(true)
  expect(await has(/^hooks\/$/)).toBe(true)
  expect(await has(/^แก้ไข$/)).toBe(true)
  expect(await has(/^ใหม่\.txt$/)).toBe(true)
  expect(await has(/^ไฟล์ใหม่$/)).toBe(true)
  expect(await has(/dev ยังไม่เข้า main/)).toBe(true)
  expect(await has(/^1 ไฟล์$/)).toBe(true)
  expect(await has(/^b\.ts$/)).toBe(true)
  expect(calls.some(argv => argv.includes('refs/heads/main...refs/heads/dev'))).toBe(true)
  await ui.unmount()
})

test('Changes folds up, keeping its counts on the button', async ($, on) => {
  const { ui } = await mountWith($, on, { status: ' M a.ts\0' })

  await ui.press({ key: 'changes' })
  expect((await ui.find({ type: 'Text', text: /^a\.ts$/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /ยังไม่ commit 1/ })) !== undefined).toBe(true)
  await ui.press({ key: 'changes' })
  expect((await ui.find({ type: 'Text', text: /^a\.ts$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('Changes says when there is nothing, and when it cannot compare', async ($, on) => {
  const { ui } = await mountWith($, on, { isDiffOk: false })

  expect((await ui.find({ type: 'Text', text: /^ไม่มีไฟล์ค้าง$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /เทียบ dev กับ main ไม่ได้: fatal: no merge base/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a repo with no main says there is nothing to compare, and runs no diff', async ($, on) => {
  const { ui, calls } = await mountWith($, on, { heads: ['dev'] })

  expect((await ui.find({ type: 'Text', text: /ไม่มีกิ่ง dev กับ main ให้เทียบ/ })) !== undefined).toBe(true)
  expect(calls.some(argv => argv.includes('diff'))).toBe(false)
  await ui.unmount()
})

test('a long list stops at 40 rows and counts the rest', async ($, on) => {
  const status = Array.from({ length: 45 }, (_, i) => ` M f${i}.ts\0`).join('')
  const { ui } = await mountWith($, on, { status })

  expect((await ui.find({ type: 'Text', text: /^f39\.ts$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^f40\.ts$/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /และอีก 5 ไฟล์/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the pane only ever runs read-only git', async ($, on) => {
  const { ui, calls } = await mountWith($, on, { status: ' M a.ts\0', diff: 'M\0b.ts\0' })
  const allowed = ['rev-parse', 'symbolic-ref', 'for-each-ref', 'log', 'rev-list', 'show', 'status', 'diff']

  for (const argv of calls.filter(one => one[0] === 'git')) {
    expect(allowed.includes(argv[3] ?? '')).toBe(true)
  }
  await ui.unmount()
})

test('a file edited in any window shows up on the next poll, with no ref moving', async ($, on) => {
  const clock = mock.clock(on)
  let status = ''

  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    const stdout = argv.includes('status')
      ? status
      : argv.includes('symbolic-ref')
        ? 'dev\n'
        : argv.includes('for-each-ref')
          ? 'refs/heads/dev\tdev\t\t\t\t1000'
          : argv.includes('log')
            ? ''
            : '/r\n'

    return {
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('tool.register', () => ({ value: { name: 'mcp__git-graph__open' } }) as never)
  on('store.get', () => ({ value: [] }) as never)
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'git-graph' }] }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'git-graph',
    component: 'Pane',
    requestId: 'git-graph',
    surface: 'desktop',
    props: {
      title: 'Git Graph',
      isFocused: false,
      bodyColumns: 50,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  expect((await ui.find({ type: 'Text', text: /^a\.ts$/ })) === undefined).toBe(true)
  status = ' M a.ts\0'
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: /^a\.ts$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a path splits into its folder and its name', () => {
  expect(splitPath('hooks/a/b.ts')).toEqual({ dir: 'hooks/a/', name: 'b.ts' })
  expect(splitPath('b.ts')).toEqual({ dir: '', name: 'b.ts' })
})

test('tones say what a line asks of the person', () => {
  const branch = { name: 'x', isRemote: false, upstream: 'origin/x', track: '', time: 0 }
  const group = (total: number, error = '') => ({ files: [], total, isPartial: false, error })
  const pending = (total: number, error = '') => ({ ...group(total, error), from: 'dev', to: 'main' })

  expect(compareTone({ a: 'x', b: 'y', ahead: 0, behind: 0 })).toBe('good')
  expect(compareTone({ a: 'x', b: 'y', ahead: 2, behind: 0 })).toBe('ahead')
  expect(compareTone({ a: 'x', b: 'y', ahead: 0, behind: 2 })).toBe('attention')
  expect(compareTone({ a: 'x', b: 'y', ahead: 1, behind: 2 })).toBe('attention')
  expect(trackTone(branch)).toBe('good')
  expect(trackTone({ ...branch, track: 'ahead 1' })).toBe('ahead')
  expect(trackTone({ ...branch, track: 'behind 1' })).toBe('attention')
  expect(trackTone({ ...branch, track: 'gone' })).toBe('attention')
  expect(trackTone({ ...branch, upstream: '' })).toBe('ahead')
  expect(changesTone({ uncommitted: group(0), pending: pending(0) })).toBe('good')
  expect(changesTone({ uncommitted: group(0), pending: null })).toBe('good')
  expect(changesTone({ uncommitted: group(0), pending: pending(3) })).toBe('ahead')
  expect(changesTone({ uncommitted: group(1), pending: pending(3) })).toBe('attention')
  expect(changesTone({ uncommitted: group(0), pending: pending(0, 'no base') })).toBe('attention')
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`every zone draws on the ${surface}`, async ($, on) => {
    on('process.run', (_, e) => {
      const argv = e.argv as readonly string[]
      const stdout = argv.includes('status')
        ? ' M hooks/a.ts\0R  new.txt\0old.txt\0'
        : argv.includes('diff')
          ? 'M\0b.ts\0'
          : argv.includes('log')
            ? 'h1\x1f\x1fHEAD -> dev\x1fone\x1fa\x1f1000\x1e'
            : argv.includes('rev-list')
              ? '1\t0\n'
              : argv.includes('symbolic-ref')
                ? 'dev\n'
                : argv.includes('for-each-ref')
                  ? 'refs/heads/dev\tdev\t\t\t\t1000\nrefs/heads/main\tmain\t\t\t\t1000'
                  : '/r\n'

      return {
        value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('store.set', () => ({ value: undefined }))
    await $.tool.call({ tool: 'mcp__git-graph__open', repo: '/r' } as never)

    const ui = await $.ui.mount({
      plugin: 'git-graph',
      component: 'Pane',
      requestId: 'git-graph',
      surface,
      props: {
        title: 'Git Graph',
        isFocused: false,
        bodyColumns: 36,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })

    for (const text of [/^Changes$/, /^มีไฟล์ค้าง$/, /^กิ่ง$/, /^ประวัติ commit$/, /^เดิม old\.txt$/]) {
      expect((await ui.find({ type: 'Text', text })) !== undefined).toBe(true)
    }
    await ui.unmount()
  })
}

test('with nothing waiting, Changes is one green line with nothing to hide', async ($, on) => {
  const { ui } = await mountWith($, on, {})

  expect((await ui.find({ type: 'Text', text: /^ครบแล้ว$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^ไม่มีไฟล์ค้าง$/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /ยังไม่ commit บน dev/ })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'changes' })) === undefined).toBe(true)
  await ui.unmount()
})

test('with one side empty, both boxes show and the empty one says so', async ($, on) => {
  const { ui } = await mountWith($, on, { diff: 'M\0b.ts\0' })

  expect((await ui.find({ type: 'Text', text: /ยังไม่ commit บน dev/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^ไม่มีไฟล์ค้าง$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^b\.ts$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the graph draws in the earth palette, with no blue or pink left', () => {
  const { source } = buildSvg([commit('c', ['b'], ['HEAD -> dev', 'tag: v1', 'origin/dev']), commit('b', [])], {
    width: 600,
    now: 2000,
    remoteNames: new Set(['origin/dev']),
  })

  for (const old of ['#2f81f7', '#db61a2', '#a371f7', '#ddf4ff', '#10304f']) expect(source.includes(old)).toBe(false)
  expect(source.includes('#6E4F3A')).toBe(true)
})
