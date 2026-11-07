import type { Branch, Changes, Commit, Compare, FileChange, FileKind } from '../types'

// Pure code only: parsing git's output, laying out lanes, drawing the SVG.
// Nothing here runs a command, so it can be tested with plain strings.

export const LOG_FORMAT = '%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ct%x1e'
export const BRANCH_FORMAT =
  '%(refname)%09%(refname:short)%09%(symref)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:unix)'

export function parseLog(stdout: string): Commit[] {
  return stdout
    .split('\x1e')
    .map(chunk => chunk.replace(/^\s+/, ''))
    .filter(chunk => chunk !== '')
    .map(chunk => {
      const [hash = '', parents = '', refs = '', subject = '', author = '', time = '0'] =
        chunk.split('\x1f')

      return {
        hash,
        parents: parents.split(' ').filter(p => p !== ''),
        refs: refs.split(', ').filter(r => r !== ''),
        subject,
        author,
        time: Number(time) || 0,
      }
    })
}

export function parseBranches(stdout: string): Branch[] {
  const branches: Branch[] = []

  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const [ref = '', name = '', symref = '', upstream = '', track = '', time = '0'] =
      line.split('\t')

    // origin/HEAD is a pointer to another branch, not a branch.
    if (symref !== '') continue
    branches.push({
      name,
      isRemote: ref.startsWith('refs/remotes/'),
      upstream,
      track,
      time: Number(time) || 0,
    })
  }

  // Local branches first, the most recently touched on top.
  return branches.sort(
    (x, y) => Number(x.isRemote) - Number(y.isRemote) || y.time - x.time,
  )
}

export function describeCompare({ a, b, ahead, behind }: Compare): string {
  if (ahead === 0 && behind === 0) return `${a} เท่ากับ ${b}`
  if (behind === 0) return `${a} นำ ${b} อยู่ ${ahead} commit`
  if (ahead === 0) return `${a} ตาม ${b} อยู่ ${behind} commit`

  return `${a} แยกทางกับ ${b}: นำ ${ahead} · ตาม ${behind} commit`
}

export function describeTrack(branch: Branch): string {
  if (branch.isRemote) return ''
  if (branch.upstream === '') return `${branch.name} ยังไม่มีบน remote`
  if (branch.track === 'gone') return `${branch.name}: กิ่งบน remote ถูกลบแล้ว`

  const ahead = /ahead (\d+)/.exec(branch.track)?.[1]
  const behind = /behind (\d+)/.exec(branch.track)?.[1]

  if (ahead === undefined && behind === undefined) {
    return `${branch.name} ตรงกับ ${branch.upstream}`
  }

  const parts: string[] = []

  if (ahead !== undefined) parts.push(`รอ push ${ahead}`)
  if (behind !== undefined) parts.push(`รอ pull ${behind}`)

  return `${branch.name}: ${parts.join(' · ')} commit`
}

const KIND_BY_LETTER: Readonly<Record<string, FileKind>> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
}

// `git status --porcelain=v1 -z`: "XY path\0", and a rename adds "from\0" after it.
export function parseStatus(stdout: string): FileChange[] {
  const parts = stdout.split('\0')
  const changes: FileChange[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''

    if (part.length < 4 || part[2] !== ' ') continue
    const x = part[0] ?? ' '
    const y = part[1] ?? ' '
    const path = part.slice(3)
    const xy = x + y
    const kind: FileKind =
      xy === '??'
        ? 'untracked'
        : x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD'
          ? 'conflict'
          : y === 'D'
            ? 'deleted'
            : (KIND_BY_LETTER[x === ' ' ? y : x] ?? 'modified')

    if (/[RC]/.test(xy)) {
      i += 1
      changes.push({ kind, path, from: parts[i] ?? '' })
    } else {
      changes.push({ kind, path })
    }
  }

  return changes
}

// `git diff --name-status -z`: "M\0path\0", and "R100\0from\0to\0" for a rename.
export function parseDiffNames(stdout: string): FileChange[] {
  const parts = stdout.split('\0')
  const changes: FileChange[] = []
  let i = 0

  while (i + 1 < parts.length) {
    const letter = (parts[i] ?? '')[0] ?? ''
    const first = parts[i + 1] ?? ''
    const kind = KIND_BY_LETTER[letter]

    if (kind === undefined || first === '') {
      i += 1
    } else if (letter === 'R' || letter === 'C') {
      changes.push({ kind, path: parts[i + 2] ?? '', from: first })
      i += 3
    } else {
      changes.push({ kind, path: first })
      i += 2
    }
  }

  return changes
}

// dev against main when the repo has them; otherwise the checked-out branch stands
// in for dev, and master for main.
export function pickPending(
  branches: readonly Branch[],
  head: string,
): { from: string; to: string } | null {
  const local = new Set(branches.filter(one => !one.isRemote).map(one => one.name))
  const to = local.has('main') ? 'main' : local.has('master') ? 'master' : ''
  const from = local.has('dev') ? 'dev' : head

  return to === '' || from === '' || from === to ? null : { from, to }
}

export const KIND_LABEL: Readonly<Record<FileKind, string>> = {
  modified: 'แก้ไข',
  added: 'เพิ่ม',
  deleted: 'ลบ',
  renamed: 'เปลี่ยนชื่อ',
  copied: 'คัดลอก',
  untracked: 'ไฟล์ใหม่',
  conflict: 'ชนกัน',
}

export function describeFile({ kind, path, from }: FileChange): string {
  return `${KIND_LABEL[kind]} · ${from === undefined ? path : `${from} → ${path}`}`
}

export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/') + 1

  return { dir: path.slice(0, cut), name: path.slice(cut) }
}

// What a line or a zone means, so the pane can color it: good needs nothing,
// ahead is work on its way, attention is work waiting on the person.
export type Tone = 'calm' | 'good' | 'ahead' | 'attention'

export function compareTone({ ahead, behind }: Compare): Tone {
  if (ahead === 0 && behind === 0) return 'good'

  return behind === 0 ? 'ahead' : 'attention'
}

export function trackTone(branch: Branch): Tone {
  if (branch.upstream === '') return 'ahead'
  if (branch.track === 'gone' || branch.track.includes('behind')) return 'attention'

  return branch.track === '' ? 'good' : 'ahead'
}

export function changesTone({ uncommitted, pending }: Changes): Tone {
  if (uncommitted.error !== '' || pending?.error || uncommitted.total > 0) return 'attention'

  return (pending?.total ?? 0) > 0 ? 'ahead' : 'good'
}

// A short stamp of a long text, so the poll keeps no copy of the whole file list.
export function stampOf(text: string): string {
  let hash = 0x811c9dc5

  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }

  return `${text.length}:${(hash >>> 0).toString(16)}`
}

export type Edge = { from: number; to: number; color: number; target: string }
export type Row = {
  commit: Commit
  lane: number
  color: number
  // Edges leaving this row, towards the next one.
  edges: Edge[]
}

export function layoutGraph(commits: readonly Commit[]): { rows: Row[]; lanes: number } {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  const rows: Row[] = []
  let nextColor = 0
  let widest = 0

  const claim = (avoid: number): number => {
    let slot = lanes.findIndex((held, i) => held === null && i !== avoid)

    if (slot === -1) slot = Math.max(lanes.length, avoid + 1)
    while (lanes.length <= slot) {
      lanes.push(null)
      colors.push(0)
    }
    colors[slot] = nextColor++

    return slot
  }

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash)

    if (lane === -1) lane = claim(-1)
    const color = colors[lane] ?? 0

    // Every lane waiting for this commit ends here.
    lanes.forEach((held, i) => {
      if (held === commit.hash) lanes[i] = null
    })

    const edges: Edge[] = []
    const fresh = new Set<number>()

    commit.parents.forEach((parent, order) => {
      const existing = lanes.indexOf(parent)

      // A first parent held further right keeps this lane too, so the main line
      // stays straight and the other lane bends into it at the parent's row.
      if (existing !== -1 && !(order === 0 && existing > lane)) {
        edges.push({ from: lane, to: existing, color: colors[existing] ?? 0, target: parent })
      } else if (order === 0) {
        lanes[lane] = parent
        fresh.add(lane)
        edges.push({ from: lane, to: lane, color, target: parent })
      } else {
        const slot = claim(lane)

        lanes[slot] = parent
        fresh.add(slot)
        edges.push({ from: lane, to: slot, color: colors[slot] ?? 0, target: parent })
      }
    })

    // Lanes that only pass through this row.
    lanes.forEach((held, i) => {
      if (held !== null && !fresh.has(i)) {
        edges.push({ from: i, to: i, color: colors[i] ?? 0, target: held })
      }
    })

    widest = Math.max(widest, lanes.length, lane + 1)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.pop()
    }
    rows.push({ commit, lane, color, edges })
  }

  // A lane waiting for the next row's commit bends into that commit's lane.
  rows.forEach((row, index) => {
    const next = rows[index + 1]

    if (next === undefined) return
    row.edges = row.edges.map(edge =>
      edge.target === next.commit.hash ? { ...edge, to: next.lane } : edge,
    )
  })

  return { rows, lanes: widest }
}

export type Chip = { text: string; kind: 'head' | 'local' | 'remote' | 'tag' }

// `HEAD -> dev`, `origin/dev`, `tag: v1`: a local branch and its remote copy on
// the same commit become one chip.
export function chipsOf(refs: readonly string[], remoteNames: ReadonlySet<string>): Chip[] {
  const chips: Chip[] = []
  const locals = new Set<string>()
  let head = ''

  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      head = ref.slice('HEAD -> '.length)
      locals.add(head)
    } else if (!ref.startsWith('tag: ') && ref !== 'HEAD' && !remoteNames.has(ref)) {
      locals.add(ref)
    }
  }

  for (const ref of refs) {
    if (ref === 'HEAD') {
      chips.push({ text: 'HEAD', kind: 'head' })
    } else if (ref.startsWith('tag: ')) {
      chips.push({ text: ref.slice('tag: '.length), kind: 'tag' })
    } else if (ref.startsWith('HEAD -> ') || locals.has(ref)) {
      const name = ref.startsWith('HEAD -> ') ? head : ref
      const synced = refs.some(
        other => remoteNames.has(other) && other.endsWith(`/${name}`),
      )

      chips.push({
        text: synced ? `${name} ☁` : name,
        kind: name === head ? 'head' : 'local',
      })
    } else {
      const local = [...locals].some(name => ref.endsWith(`/${name}`))

      if (!local) chips.push({ text: ref, kind: 'remote' })
    }
  }

  // The checked-out branch reads first.
  return chips.sort((x, y) => rank(x) - rank(y))
}

const rank = (chip: Chip) => ['head', 'local', 'remote', 'tag'].indexOf(chip.kind)

export function ageOf(time: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60))

  if (minutes < 60) return `${minutes} นาที`
  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours} ชม.`
  const days = Math.floor(hours / 24)

  if (days < 30) return `${days} วัน`
  const months = Math.floor(days / 30)

  if (months < 12) return `${months} เดือน`

  return `${Math.floor(days / 365)} ปี`
}

// A commit's subject is someone else's text: it never reaches the markup raw.
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cut(text: string, room: number): string {
  const chars = Array.from(text)

  return chars.length <= room ? text : `${chars.slice(0, Math.max(1, room - 1)).join('')}…`
}

const PALETTE = ['#A5532A', '#5F6F3A', '#47636E', '#B08A3C', '#7A5C48', '#8F3A2B', '#6F7F6A', '#9A7B5B']
const paint = (color: number) => PALETTE[color % PALETTE.length]

const ROW = 38
const LANE = 20
const FONT = 17
const CHIP_FONT = 15
const CHIP_CHAR = CHIP_FONT * 0.62
const MAX_LANES = 12
// A narrow pane keeps one label on a row, so the message still has room.
const NARROW_BELOW = 620
const MAX_SUBJECT = 400
// Pointing at a row slides a message too long for it: the app's frame cannot scroll
// sideways (it hides overflow and removes foreignObject), but it does run CSS hover.
const SLIDE_CHAR = 0.56
const SLIDE_SPEED = 60
export const SVG_LIMIT = 131072
// One page of commits. A pane past 100,000 characters is reported to draw nothing
// on the desktop, so a page stays well under that with room for the controls.
export const PAGE = 100
const DRAW_LIMIT = 88000

const STYLE = `
.bg{fill:#fff}.t{fill:#2B2620}.d{fill:#6B6053}.h{fill:transparent}
.r:hover .h{fill:rgba(156,79,36,.10)}
.c-head{fill:#6E4F3A}.ct-head{fill:#fff}
.c-local{fill:#EFE6D8;stroke:#A08468}.ct-local{fill:#4A3526}
.c-remote{fill:#EEEAE3;stroke:#B5AB9C}.ct-remote{fill:#4F483E}
.c-tag{fill:#F3E7C8;stroke:#B08A3C}.ct-tag{fill:#5E4A12}
.dot{stroke:#fff}
.s{transition:transform .25s ease-out}
.r:hover .s{transform:translateX(var(--x,0));transition:transform var(--d,1s) linear .35s}
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;font-size:${FONT}px}
.m{font-family:ui-monospace,Menlo,monospace;font-size:${CHIP_FONT}px}
@media (prefers-color-scheme:dark){
.bg{fill:#1c1c1e}.t{fill:#F0EBE3}.d{fill:#A79C8E}.dot{stroke:#1c1c1e}
.c-local{fill:#3A2E24;stroke:#A08468}.ct-local{fill:#EADCC8}
.c-remote{fill:#33302B;stroke:#7A7063}.ct-remote{fill:#DDD6CA}
.c-tag{fill:#3A3018;stroke:#B08A3C}.ct-tag{fill:#E8D49A}
}
`

function drawRows(
  rows: readonly Row[],
  { width, now, remoteNames, textX, above }: {
    width: number
    now: number
    remoteNames: ReadonlySet<string>
    textX: number
    above: Row | undefined
  },
): string {
  const isNarrow = width < NARROW_BELOW
  const maxChips = isNarrow ? 1 : 3
  // A very narrow pane cuts the label, so it never covers the graph's lanes.
  const chipRoom = Math.max(4, Math.min(isNarrow ? 18 : 26, Math.floor((width - textX - 24) / CHIP_CHAR)))
  const laneX = (lane: number) => LANE / 2 + 6 + lane * LANE
  const rowY = (index: number) => ROW / 2 + index * ROW
  const height = rows.length * ROW + ROW / 2
  const lines: string[] = []
  const dots: string[] = []
  const texts: string[] = []
  // Edges run a full row down; the drawing's own edges cut what leaves the page.
  const drawEdges = (row: Row, y: number) => {
    for (const edge of row.edges) {
      const x1 = laneX(edge.from)
      const x2 = laneX(edge.to)
      const y2 = y + ROW
      const d =
        x1 === x2
          ? `M${x1} ${y}V${y2}`
          : `M${x1} ${y}C${x1} ${y + ROW * 0.55} ${x2} ${y2 - ROW * 0.55} ${x2} ${y2}`

      lines.push(`<path d="${d}" stroke="${paint(edge.color)}"/>`)
    }
  }

  // What comes down from the page above.
  if (above !== undefined) drawEdges(above, rowY(-1))

  rows.forEach((row, index) => {
    const y = rowY(index)

    drawEdges(row, y)

    const isHead = row.commit.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '))
    const isMerge = row.commit.parents.length > 1

    dots.push(
      `<circle class="dot" cx="${laneX(row.lane)}" cy="${y}" r="${isHead ? 7.5 : isMerge ? 4.5 : 6}" fill="${paint(row.color)}" stroke-width="2"/>`,
    )

    const chips = chipsOf(row.commit.refs, remoteNames)
    const shown = chips.slice(0, maxChips)
    const extra = chips.length - shown.length
    let right = width - 6
    let chipMarks = ''

    if (extra > 0) {
      right -= 28
      chipMarks += `<text class="m d" x="${right + 3}" y="${y + 5}">+${extra}</text>`
    }
    for (const chip of [...shown].reverse()) {
      const label = cut(chip.text, chipRoom)
      const chipWidth = Array.from(label).length * CHIP_CHAR + 12

      right -= chipWidth
      chipMarks +=
        `<rect class="c-${chip.kind}" x="${right}" y="${y - 13}" width="${chipWidth}" height="26" rx="6"/>` +
        `<text class="m ct-${chip.kind}" x="${right + 6}" y="${y + 5}">${escapeXml(label)}</text>`
      right -= 5
    }

    const subject = cut(row.commit.subject, MAX_SUBJECT)
    const age = ageOf(row.commit.time, now)
    const after = `  ${age} · ${cut(row.commit.author, 30)}`
    // Measured by estimate, so a slide goes a little past the end rather than short.
    const room = (chips.length > 0 ? right - 8 : width - 6) - textX
    const textWidth = (Array.from(subject).length + Array.from(after).length) * FONT * SLIDE_CHAR
    const slide = Math.ceil(textWidth - room + 16)
    const motion =
      slide > 0
        ? ` style="--x:-${slide}px;--d:${Math.min(20, Math.max(1, slide / SLIDE_SPEED)).toFixed(1)}s"`
        : ''
    const tooltip = escapeXml(
      `${row.commit.hash.slice(0, 8)} · ${row.commit.author} · ${age}\n${subject}${chips.length > 0 ? `\n${chips.map(chip => chip.text).join(', ')}` : ''}`,
    )
    // The label's backing hides the message as it passes beneath.
    const backing =
      chips.length > 0
        ? `<rect class="bg" x="${right}" y="${y - ROW / 2}" width="${width - right}" height="${ROW}"/>`
        : ''

    texts.push(
      `<g class="r"><title>${tooltip}</title>` +
        `<rect class="h" x="${textX - 4}" y="${y - ROW / 2}" width="${width - textX + 4}" height="${ROW}"/>` +
        `<g clip-path="url(#k)"><text class="t s" x="${textX}" y="${y + 6}"${motion}>${escapeXml(subject)}<tspan class="d">${escapeXml(after)}</tspan></text></g>` +
        backing +
        chipMarks +
        '</g>',
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">` +
    `<style>${STYLE}</style>` +
    `<defs><clipPath id="k"><rect x="${textX}" y="0" width="${width - textX}" height="${height}"/></clipPath>` +
    `<clipPath id="g"><rect x="0" y="0" width="${textX - 6}" height="${height}"/></clipPath></defs>` +
    `<rect class="bg" width="${width}" height="${height}"/>` +
    texts.join('') +
    `<g clip-path="url(#g)"><g fill="none" stroke-width="2.25">${lines.join('')}</g>${dots.join('')}</g>` +
    '</svg>'
  )
}

// The graph as one SVG, or fewer rows than asked where the markup would pass
// what a Svg element takes.
export function buildSvg(
  commits: readonly Commit[],
  options: {
    width: number
    now: number
    remoteNames: ReadonlySet<string>
    start?: number
    count?: number
  },
): { source: string; rowsDrawn: number; height: number } {
  // Lanes come from all the history up to here, so a later page lines up with
  // the one before it.
  const { rows } = layoutGraph(commits)
  const start = options.start ?? 0
  const page = rows.slice(start, start + (options.count ?? rows.length))
  const above = rows[start - 1]
  const lanes = Math.max(
    1,
    ...page.map(row => row.lane + 1),
    ...page.flatMap(row => row.edges.map(edge => Math.max(edge.from, edge.to) + 1)),
    ...(above?.edges.map(edge => edge.to + 1) ?? []),
  )
  const textX = Math.min(lanes, MAX_LANES) * LANE + 16
  const { width, now, remoteNames } = options
  let drawn = page.length

  while (drawn > 0) {
    const source = drawRows(page.slice(0, drawn), {
      width,
      now,
      remoteNames,
      above,
      textX,
    })

    if (source.length <= DRAW_LIMIT) {
      return { source, rowsDrawn: drawn, height: Number(/height="([\d.]+)"/.exec(source)?.[1] ?? 0) }
    }
    drawn = Math.floor(drawn * 0.8)
  }

  return { source: '', rowsDrawn: 0, height: 0 }
}
