import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Changes, Compare, FileChange, FileGroup, FileKind, GraphData } from '../types'
import type { Tone } from './graph'
import {
  BRANCH_FORMAT,
  KIND_LABEL,
  LOG_FORMAT,
  PAGE,
  buildSvg,
  changesTone,
  compareTone,
  describeCompare,
  describeFile,
  describeTrack,
  parseBranches,
  parseDiffNames,
  parseLog,
  parseStatus,
  pickPending,
  splitPath,
  stampOf,
  syncOf,
  trackTone,
} from './graph'

const PANE = 'git-graph'
const TITLE = 'Git Graph'
const NONE = '__none__'
const POLL_MS = 5000
const MAX_COMPARES = 12
const MAX_PAGES = 15
const MAX_COMMIT_OPTIONS = 60
const MAX_BRANCH_ROWS = 60
const MAX_FILE_ROWS = 40
const CELL_PX = 8
const MIN_WIDTH = 160
const KIND_COLUMN = 7

// Words take theme keys, so they read on light and dark alike. Edges and surfaces
// are the same hues at low strength, which sit quietly on either theme.
type Paint = Tone | 'danger'
const TONES: Readonly<Record<Paint, { key: string; line: string; tint: string }>> = {
  calm: { key: 'subtle', line: '#80808073', tint: '#8080801a' },
  good: { key: 'success', line: '#22c55e8c', tint: '#22c55e1f' },
  ahead: { key: 'suggestion', line: '#3b82f680', tint: '#3b82f61a' },
  attention: { key: 'warning', line: '#f59e0b99', tint: '#f59e0b24' },
  danger: { key: 'error', line: '#ef44448c', tint: '#ef44441f' },
}
// The colors VS Code gives the same git states, whichever box the file sits in.
const KIND_PAINT: Readonly<Record<FileKind, Paint>> = {
  modified: 'attention',
  added: 'good',
  untracked: 'good',
  renamed: 'good',
  copied: 'good',
  deleted: 'danger',
  conflict: 'danger',
}
const CHANGES_STATE: Readonly<Record<Tone, string>> = {
  calm: '',
  good: 'ครบแล้ว',
  ahead: 'รอรวมกิ่ง',
  attention: 'มีไฟล์ค้าง',
}

const repoAtom = atom({ plugin: 'git-graph', key: 'repo' } as const, '', { shape: 'repo-1' })
const slotsAtom = atom({ plugin: 'git-graph', key: 'slots' } as const, [], { shape: 'slots-1' })
const menuAtom = atom({ plugin: 'git-graph', key: 'menu' } as const, false, { shape: 'menu-1' })
const changesOpenAtom = atom({ plugin: 'git-graph', key: 'changesOpen' } as const, true, { shape: 'changes-open-1' })
const pageAtom = atom({ plugin: 'git-graph', key: 'page' } as const, 0, { shape: 'page-1' })
const recentsAtom = atom({ plugin: 'git-graph', key: 'recents' } as const, [], { shape: 'recents-1' })
const dataAtom = atom({ plugin: 'git-graph', key: 'data' } as const, null, { shape: 'data-2' })
const detailAtom = atom({ plugin: 'git-graph', key: 'detail' } as const, null, { shape: 'detail-1' })

// Read-only git, and only these subcommands: this pane never changes a repo.
// GIT_OPTIONAL_LOCKS below keeps `status` from refreshing the index as it reads.
type ReadOnly = 'rev-parse' | 'symbolic-ref' | 'for-each-ref' | 'log' | 'rev-list' | 'show' | 'status' | 'diff'
type GitResult = { isOk: boolean; stdout: string; stderr: string; isCut: boolean }

async function git(
  $: EngineInterface,
  cwd: string,
  command: ReadOnly,
  args: readonly string[],
): Promise<GitResult> {
  try {
    const ran = await $.process.run(
      ['git', '-c', 'log.showSignature=false', command, ...args],
      {
        cwd,
        env: { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
        timeoutMs: 20000,
      },
    )

    return { isOk: ran.exitCode === 0, stdout: ran.stdout, stderr: ran.stderr, isCut: ran.isStdoutTruncated }
  } catch (error) {
    return { isOk: false, stdout: '', stderr: String(error), isCut: false }
  }
}

// What the pane depends on: the refs, and which files sit uncommitted.
async function fingerprint($: EngineInterface, root: string): Promise<{ stamp: string; status: GitResult }> {
  const [refs, head, status] = await Promise.all([
    git($, root, 'for-each-ref', ['--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    git($, root, 'rev-parse', ['--abbrev-ref', 'HEAD']),
    git($, root, 'status', ['--porcelain=v1', '-z', '--untracked-files=all']),
  ])

  return { stamp: `${head.stdout}\n${refs.stdout}\n${stampOf(status.stdout)}`, status }
}

function toGroup(ran: GitResult, parse: (stdout: string) => FileChange[], failure: string): FileGroup {
  if (!ran.isOk) {
    return { files: [], total: 0, isPartial: false, error: `${failure}: ${ran.stderr.slice(0, 200)}` }
  }
  const files = parse(ran.stdout)

  return { files: files.slice(0, MAX_FILE_ROWS), total: files.length, isPartial: ran.isCut, error: '' }
}

const NO_CHANGES: Changes = {
  uncommitted: { files: [], total: 0, isPartial: false, error: '' },
  pending: null,
}

async function compareOne(
  $: EngineInterface,
  root: string,
  a: string,
  b: string,
): Promise<Compare | null> {
  const ran = await git($, root, 'rev-list', ['--left-right', '--count', '--end-of-options', `${a}...${b}`])
  const [ahead, behind] = ran.stdout.trim().split(/\s+/).map(Number)

  if (!ran.isOk || ahead === undefined || behind === undefined) return null

  return { a, b, ahead, behind }
}

// Each load starts after the last one; an older one that ends late is dropped.
let loadNumber = 0

async function load($: EngineInterface): Promise<void> {
  const mine = ++loadNumber
  const repo = await read($, repoAtom)
  const empty: GraphData = {
    root: '',
    head: '',
    branches: [],
    commits: [],
    compares: [],
    changes: NO_CHANGES,
    fingerprint: '',
    error: '',
  }

  if (repo === '') {
    await update($, dataAtom, () => empty)

    return
  }

  const top = await git($, repo, 'rev-parse', ['--show-toplevel'])

  if (!top.isOk) {
    if (mine === loadNumber) {
      await update($, dataAtom, () => ({ ...empty, error: `${repo} ไม่ใช่โฟลเดอร์ git` }))
    }

    return
  }

  const root = top.stdout.trim()
  const [headRan, branchRan, { stamp, status }, page, wanted] = await Promise.all([
    git($, root, 'symbolic-ref', ['--short', '-q', 'HEAD']),
    git($, root, 'for-each-ref', [`--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']),
    fingerprint($, root),
    read($, pageAtom),
    read($, slotsAtom),
  ])
  const branches = parseBranches(branchRan.stdout)
  const known = new Set(branches.map(branch => branch.name))
  const slots = [...new Set(wanted)].filter(name => known.has(name))
  const head = headRan.stdout.trim()
  const logRan = await git($, root, 'log', [
    '--topo-order',
    `--max-count=${(page + 1) * PAGE + 1}`,
    `--format=${LOG_FORMAT}`,
    '--decorate=short',
    ...(slots.length > 0 ? ['--end-of-options', ...slots] : ['--branches', '--remotes', '--tags', 'HEAD']),
    '--',
  ])

  // None or one picked: every local branch against it. Two or three: each pair.
  // More than that: each against the checked-out one, so the list stays readable.
  const base = slots.includes(head) ? head : (slots[0] ?? head)
  const pairs: [string, string][] = (
    slots.length === 2 || slots.length === 3
      ? slots.flatMap((a, i) => slots.slice(i + 1).map((b): [string, string] => [a, b]))
      : (slots.length > 3 ? slots : branches.filter(branch => !branch.isRemote).map(branch => branch.name))
          .filter(name => name !== base)
          .map((name): [string, string] => [name, base])
  ).slice(0, MAX_COMPARES)
  const compares = base === ''
    ? []
    : (await Promise.all(pairs.map(([a, b]) => compareOne($, root, a, b)))).filter(
        (one): one is Compare => one !== null,
      )

  // Three dots: what `from` changed since the two split, not what `to` gained since.
  const pair = pickPending(branches, head)
  const pending =
    pair === null
      ? null
      : {
          ...pair,
          ...toGroup(
            await git($, root, 'diff', [
              '--name-status',
              '-z',
              '--end-of-options',
              `refs/heads/${pair.to}...refs/heads/${pair.from}`,
              '--',
            ]),
            parseDiffNames,
            `เทียบ ${pair.from} กับ ${pair.to} ไม่ได้`,
          ),
        }

  if (mine !== loadNumber) return
  await update($, dataAtom, () => ({
    root,
    head,
    branches,
    commits: parseLog(logRan.stdout),
    compares,
    changes: { uncommitted: toGroup(status, parseStatus, 'อ่านไฟล์ที่ยังไม่ commit ไม่ได้'), pending },
    fingerprint: stamp,
    error: logRan.isOk ? '' : `อ่าน git log ไม่ได้: ${logRan.stderr.slice(0, 200)}`,
  }))
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  const trimmed = path.trim()

  if (trimmed !== '~' && !trimmed.startsWith('~/')) return trimmed
  const home = await $.process.run(['printenv', 'HOME'])

  return `${home.stdout.trim()}${trimmed.slice(1)}`
}

async function useRepo($: EngineInterface, path: string): Promise<void> {
  const repo = await expandHome($, path)

  if (repo === '') return
  await update($, repoAtom, () => repo)
  await update($, slotsAtom, () => [])
  await update($, pageAtom, () => 0)
  await update($, detailAtom, () => null)
  await load($)

  const data = await read($, dataAtom)

  if (data === null || data.root === '') return
  const recents = [data.root, ...(await read($, recentsAtom)).filter(one => one !== data.root)].slice(0, 6)

  await update($, repoAtom, () => data.root)
  await update($, recentsAtom, () => recents)
  await $.store.set('recents', recents)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-graph',
      description: 'Show the Git graph pane',
      argumentHint: '[repo path]',
    })
    await $.tool.register({
      name: 'open',
      description:
        'Open the read-only Git graph pane beside the chat. Pass repo to show a repository other than the session folder.',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string', description: 'Absolute path of a git repository' } },
      },
      isDeferred: true,
    })

    const stored = await $.store.get('recents')
    const recents = Array.isArray(stored)
      ? stored.filter((one): one is string => typeof one === 'string')
      : []

    await update($, recentsAtom, () => recents)

    const here = await git($, e.cwd, 'rev-parse', ['--show-toplevel'])

    if (here.isOk) {
      await useRepo($, here.stdout.trim())
      void $.ui.open({ id: PANE, title: TITLE })
    } else if (recents[0] !== undefined && (await read($, repoAtom)) === '') {
      await update($, repoAtom, () => recents[0] ?? '')
      await load($)
    }

    // Refs moved or a file changed (in any window): draw it again. A slow repo
    // skips a tick rather than stacking `git status` on top of itself.
    let isPolling = false

    $.clock.every(POLL_MS, () => {
      if (isPolling) return
      isPolling = true
      void (async () => {
        try {
          const panes = await $.ui.panes()

          if (!panes.some(pane => pane.id === PANE)) return
          const data = await read($, dataAtom)

          if (data === null || data.root === '') return
          if ((await fingerprint($, data.root)).stamp !== data.fingerprint) await load($)
        } finally {
          isPolling = false
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'git-graph' }, async ($, e) => {
    if (e.args.trim() !== '') await useRepo($, e.args)
    else await load($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Git Graph pane opened.' }
  })

  on('tool.call', { tool: 'mcp__git-graph__open' }, async ($, e) => {
    // A tool's input fields sit on the event itself, as `e.command` does for Bash.
    const repo = (e as unknown as { repo?: unknown }).repo

    if (typeof repo === 'string' && repo.trim() !== '') await useRepo($, repo)
    else await load($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const data = await read($, dataAtom)

    return {
      // A registered tool answers the model with text, not an object.
      result: JSON.stringify({
        isPlaced: opened.isPlaced,
        reason: opened.isPlaced ? '' : opened.reason,
        repo: data?.root ?? '',
        error: data?.error ?? '',
        commits: data?.commits.length ?? 0,
        branches: data?.branches.map(one => one.name) ?? [],
        compares: data?.compares.map(describeCompare) ?? [],
        uncommitted: data?.changes.uncommitted.files.map(describeFile) ?? [],
        uncommittedTotal: data?.changes.uncommitted.total ?? 0,
        pending:
          data?.changes.pending == null
            ? null
            : {
                from: data.changes.pending.from,
                to: data.changes.pending.to,
                total: data.changes.pending.total,
                files: data.changes.pending.files.map(describeFile),
                error: data.changes.pending.error,
              },
      }),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Code } = ui
    const [repo, slots, isMenuOpen, isChangesOpen, savedPage, recents, data, detail] = await Promise.all([
      read($, repoAtom),
      read($, slotsAtom),
      read($, menuAtom),
      read($, changesOpenAtom),
      read($, pageAtom),
      read($, recentsAtom),
      read($, dataAtom),
      read($, detailAtom),
    ])
    const branches = data?.branches ?? []
    const commits = data?.commits ?? []
    // Never wider than the pane: the app would shrink the drawing to fit and leave
    // a gap in its fixed-height frame.
    const width = Math.max(MIN_WIDTH, e.props.bodyColumns * CELL_PX)
    const remoteNames = new Set(branches.filter(one => one.isRemote).map(one => one.name))
    const picked = slots.filter(name => branches.some(one => one.name === name))
    const tracked = branches
      .filter(one => (picked.length > 0 ? picked.includes(one.name) : one.name === data?.head))
      .map(one => ({ line: describeTrack(one), tone: trackTone(one) }))
      .filter(one => one.line !== '')
    const isTerminal = e.surface === 'terminal'
    const colorOf = (paint: Paint) => TONES[paint].key
    const zone = (paint: Paint) => ({
      borderStyle: 'round',
      borderColor: isTerminal ? TONES[paint].key : TONES[paint].line,
      ...(isTerminal ? {} : { backgroundColor: TONES[paint].tint }),
    })

    const showBranches = (change: (current: string[]) => string[]) => {
      void (async () => {
        await update($, slotsAtom, change)
        await update($, pageAtom, () => 0)
        await load($)
      })()
    }

    const repoControls = 'Input' in ui && (
      <Box flexDirection="column" gap={1}>
        {'Select' in ui && recents.length > 1 && (
          <ui.Select
            key="recent"
            label="repo ล่าสุด"
            value={repo}
            options={recents.map(one => ({ value: one, label: one.split('/').pop() ?? one }))}
            onSelect={value => void useRepo($, value)}
          />
        )}
        <ui.Input
          key="repo"
          label="เปิด repo อื่น"
          placeholder="~/apps/ชื่อโปรเจกต์"
          submitLabel="เปิด"
          onSubmit={value => void useRepo($, value)}
        />
      </Box>
    )

    if (data === null || data.root === '') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={data?.error ? 'error' : undefined}>
            {data?.error || 'โฟลเดอร์ของ session นี้ไม่ใช่ git · ใส่ path ของ repo ด้านล่าง'}
          </Text>
          {repoControls}
        </Box>
      )
    }

    // The checked-out branch first, what is ticked always, then the newest.
    const listed = [
      ...new Set([
        ...(data.head === '' ? [] : [data.head]),
        ...picked,
        ...branches.map(one => one.name),
      ]),
    ].slice(0, Math.max(MAX_BRANCH_ROWS, picked.length + 1))
    const summary =
      picked.length === 0 ? 'ทุกกิ่ง' : picked.length <= 2 ? picked.join(', ') : `${picked.length} กิ่ง`
    const lastPage = Math.max(0, Math.ceil(commits.length / PAGE) - 1)
    const page = Math.min(savedPage, lastPage)
    const shown = commits.slice(page * PAGE, (page + 1) * PAGE)
    const hasOlder = commits.length > (page + 1) * PAGE && page + 1 < MAX_PAGES
    const turnPage = (to: number) => {
      void (async () => {
        await update($, pageAtom, () => Math.max(0, to))
        await load($)
      })()
    }
    const { uncommitted, pending } = data.changes
    const countOf = (group: FileGroup) => (group.error !== '' ? '?' : `${group.total}${group.isPartial ? '+' : ''}`)
    const fileRow = (file: FileChange) => {
      const { dir, name } = splitPath(file.path)

      return (
        <Box flexDirection="row" gap="sm">
          <Box width={KIND_COLUMN} flexShrink={0}>
            <Text weight="semibold" color={colorOf(KIND_PAINT[file.kind])}>
              {KIND_LABEL[file.kind]}
            </Text>
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold">{name}</Text>
            {dir !== '' && (
              <Text size="footnote" dimColor>
                {dir}
              </Text>
            )}
            {file.from !== undefined && (
              <Text size="footnote" dimColor>
                เดิม {file.from}
              </Text>
            )}
          </Box>
        </Box>
      )
    }
    // Each group is a box of its own state's color; an empty one stays quiet.
    const fileGroup = (title: string, group: FileGroup, tone: Tone) => {
      const isBusy = group.total > 0 || group.error !== ''
      const color = isBusy ? colorOf(tone) : undefined

      return (
        <Box flexDirection="column" gap="xs" padding="md" {...zone(isBusy ? tone : 'calm')}>
          <Box flexDirection="row" justifyContent="space-between" gap="sm">
            <Box flexShrink={1}>
              <Text weight="semibold" color={color}>
                {title}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text weight="semibold" color={color}>
                {countOf(group)} ไฟล์
              </Text>
            </Box>
          </Box>
          {group.error !== '' && <Text color={colorOf('danger')}>{group.error}</Text>}
          {group.error === '' && group.total === 0 && <Text>ไม่มีไฟล์ค้าง</Text>}
          {group.files.map(fileRow)}
          {group.total > group.files.length && (
            <Text size="footnote" dimColor>
              และอีก {group.total - group.files.length} ไฟล์
            </Text>
          )}
          {group.isPartial && (
            <Text size="footnote" dimColor>
              รายการยาวเกินที่อ่านได้ จึงนับไม่ครบ
            </Text>
          )}
        </Box>
      )
    }
    const zoneTitle = (title: string) => (
      <Text size="heading" weight="semibold">
        {title}
      </Text>
    )
    const tone = changesTone(data.changes)
    const drawn =
      'Svg' in ui
        ? buildSvg(commits, {
            width,
            now: Date.now() / 1000,
            remoteNames,
            start: page * PAGE,
            count: PAGE,
          })
        : null

    return (
      <Box flexDirection="column" gap="lg">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Box flexDirection="column" flexShrink={1}>
            <Text size="footnote" dimColor>
              {data.root.split('/').pop()}
            </Text>
            <Box flexDirection="row" alignItems="center" gap="sm">
              <Text size="title" weight="bold">
                {data.head === '' ? 'detached HEAD' : data.head}
              </Text>
              {syncOf(branches.find(one => one.name === data.head)) !== '' && (
                <Text weight="semibold">{syncOf(branches.find(one => one.name === data.head))}</Text>
              )}
            </Box>
          </Box>
          <Button key="refresh" label="รีเฟรช" onPress={() => void load($)} />
        </Box>

        {data.error !== '' && <Text color={colorOf('danger')}>{data.error}</Text>}

        <Box flexDirection="column" gap="md" padding="md" {...zone(tone === 'good' ? 'good' : 'calm')}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box flexDirection="column" flexShrink={1}>
              {zoneTitle('Changes')}
              <Text weight="semibold" color={tone === 'good' ? colorOf('good') : undefined}>
                {CHANGES_STATE[tone]}
              </Text>
            </Box>
            {tone !== 'good' && (
              <Button
                key="changes"
                label={isChangesOpen ? 'ซ่อน' : 'แสดง'}
                onPress={() => void update($, changesOpenAtom, open => !open)}
              />
            )}
          </Box>
          {tone !== 'good' && isChangesOpen && (
            <Box flexDirection="column" gap="md">
              {fileGroup(`ยังไม่ commit บน ${data.head === '' ? 'detached HEAD' : data.head}`, uncommitted, 'attention')}
              {pending !== null && fileGroup(`${pending.from} ยังไม่เข้า ${pending.to}`, pending, 'ahead')}
            </Box>
          )}
          {tone !== 'good' && !isChangesOpen && (
            <Text size="footnote">
              ยังไม่ commit {countOf(uncommitted)}
              {pending === null ? '' : ` · ${pending.from} ยังไม่เข้า ${pending.to} ${countOf(pending)}`}
            </Text>
          )}
          {pending === null && (tone === 'good' || isChangesOpen) && (
            <Text size="footnote" dimColor>
              ไม่มีกิ่ง dev กับ main ให้เทียบ
            </Text>
          )}
        </Box>

        <Box flexDirection="column" gap="md" padding="md" {...zone('calm')}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box flexShrink={0}>{zoneTitle('กิ่ง')}</Box>
            <Button
              key="branches"
              label={`แสดง: ${summary} ${isMenuOpen ? '▴' : '▾'}`}
              onPress={() => void update($, menuAtom, open => !open)}
            />
          </Box>
          {isMenuOpen && (
            <Box flexDirection="column" gap={1}>
              <Button
                key="branch-all"
                plain
                label={`${picked.length === 0 ? '☑' : '☐'} ทุกกิ่ง`}
                onPress={() => showBranches(() => [])}
              />
              {listed.map(name => (
                <Button
                  key={`branch:${name}`}
                  plain
                  label={`${picked.includes(name) ? '☑' : '☐'} ${name}${name === data.head ? ' (กิ่งปัจจุบัน)' : ''}`}
                  onPress={() =>
                    showBranches(current =>
                      current.includes(name) ? current.filter(one => one !== name) : [...current, name],
                    )
                  }
                />
              ))}
              {listed.length < branches.length && (
                <Text size="footnote" dimColor>
                  แสดง {listed.length} จาก {branches.length} กิ่ง เรียงจากล่าสุด
                </Text>
              )}
            </Box>
          )}
          <Box flexDirection="column" gap="xs">
            {tracked.slice(0, MAX_COMPARES).map(one => (
              <Text weight="semibold" color={colorOf(one.tone)}>
                {one.line}
              </Text>
            ))}
            {data.compares.map(one => (
              <Text weight="semibold" color={colorOf(compareTone(one))}>
                {describeCompare(one)}
              </Text>
            ))}
          </Box>
        </Box>

        <Box flexDirection="column" gap="xs">
          {zoneTitle('ประวัติ commit')}
          <Text size="footnote" dimColor>
            รูปกิ่ง = บนเครื่อง · รูปเมฆ = บน remote เช่น GitHub ตาม fetch หรือ push ล่าสุด
          </Text>
        </Box>
        {commits.length === 0 && <Text dimColor>ยังไม่มี commit ให้แสดง</Text>}

        {drawn !== null && 'Svg' in ui && drawn.rowsDrawn > 0 && (
          <ui.Svg
            source={drawn.source}
            alt={`กราฟ ${drawn.rowsDrawn} commit ของ ${data.root}`}
            width={width}
            height={drawn.height}
            isInteractive
          />
        )}
        {drawn === null &&
          shown.map(one => (
            <Text wrap="truncate-end">
              {one.hash.slice(0, 7)} {one.subject}
            </Text>
          ))}
        {drawn !== null && drawn.rowsDrawn > 0 && drawn.rowsDrawn < shown.length && (
          <Text dimColor>
            หน้านี้ยาวเกินที่แอปรับได้ จึงแสดง {drawn.rowsDrawn} จาก {shown.length} commit
          </Text>
        )}
        {(page > 0 || hasOlder) && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {page > 0 && <Button key="newer" label="ใหม่กว่า" onPress={() => turnPage(page - 1)} />}
            <Text dimColor>
              commit {page * PAGE + 1}–{page * PAGE + (drawn?.rowsDrawn ?? shown.length)}
            </Text>
            {hasOlder && <Button key="older" label="เก่ากว่า" onPress={() => turnPage(page + 1)} />}
          </Box>
        )}

        {'Select' in ui && shown.length > 0 && (
          <ui.Select
            key="commit"
            label={shown.length > MAX_COMMIT_OPTIONS ? `ดูรายละเอียด (${MAX_COMMIT_OPTIONS} commit บนสุด)` : 'ดูรายละเอียด commit'}
            value={
              detail !== null && shown.slice(0, MAX_COMMIT_OPTIONS).some(one => one.hash === detail.hash)
                ? detail.hash
                : NONE
            }
            options={[
              { value: NONE, label: '— เลือก commit —' },
              ...shown.slice(0, MAX_COMMIT_OPTIONS).map(one => ({
                value: one.hash,
                label: `${one.hash.slice(0, 7)} ${one.subject.slice(0, 70)}`,
              })),
            ]}
            onSelect={value => {
              void (async () => {
                if (value === NONE) {
                  await update($, detailAtom, () => null)

                  return
                }
                const shown = await git($, data.root, 'show', [
                  '--stat',
                  '--no-color',
                  '--date=format:%Y-%m-%d %H:%M',
                  '--format=%h · %an · %ad%n%n%B',
                  '--end-of-options',
                  value,
                ])

                await update($, detailAtom, () => ({
                  hash: value,
                  text: shown.isOk ? shown.stdout.slice(0, 20000) : shown.stderr.slice(0, 500),
                }))
              })()
            }}
          />
        )}
        {detail !== null && <Code source={detail.text} />}

        {repoControls && (
          <Box flexDirection="column" padding="md" {...(isTerminal ? {} : { backgroundColor: TONES.calm.tint })}>
            {repoControls}
          </Box>
        )}
      </Box>
    )
  })
}
