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
    return `${branch.name} บนเครื่อง ตรงกับ ${branch.upstream}`
  }

  const parts: string[] = []

  if (ahead !== undefined) parts.push(`รอ push ${ahead}`)
  if (behind !== undefined) parts.push(`รอ pull ${behind}`)

  return `${branch.name} บนเครื่อง: ${parts.join(' · ')} commit`
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

// Where a branch name lives: on this machine, on the remote as last fetched, or both
// at this very commit. A tag or a detached HEAD is neither.
export type Chip = {
  text: string
  kind: 'head' | 'base' | 'local' | 'remote' | 'tag'
  where: 'local' | 'remote' | 'both' | 'none'
}

// `HEAD -> dev`, `origin/dev`, `tag: v1`: a local branch and its remote copy on the
// same commit become one chip that says so. `origin/HEAD` only points at another
// branch, so it is no chip of its own.
export function chipsOf(refs: readonly string[], remoteNames: ReadonlySet<string>): Chip[] {
  const chips: Chip[] = []
  const locals = new Set<string>()
  const isPointer = (ref: string) => ref !== 'HEAD' && ref.endsWith('/HEAD')
  let head = ''

  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      head = ref.slice('HEAD -> '.length)
      locals.add(head)
    } else if (!ref.startsWith('tag: ') && ref !== 'HEAD' && !isPointer(ref) && !remoteNames.has(ref)) {
      locals.add(ref)
    }
  }

  for (const ref of refs) {
    if (isPointer(ref)) continue
    if (ref === 'HEAD') {
      chips.push({ text: 'HEAD', kind: 'head', where: 'none' })
    } else if (ref.startsWith('tag: ')) {
      chips.push({ text: ref.slice('tag: '.length), kind: 'tag', where: 'none' })
    } else if (ref.startsWith('HEAD -> ') || locals.has(ref)) {
      const name = ref.startsWith('HEAD -> ') ? head : ref
      const synced = refs.some(
        other => remoteNames.has(other) && other.endsWith(`/${name}`),
      )

      chips.push({
        text: name,
        kind: name === head ? 'head' : name === 'main' || name === 'master' ? 'base' : 'local',
        where: synced ? 'both' : 'local',
      })
    } else {
      const local = [...locals].some(name => ref.endsWith(`/${name}`))

      if (!local) chips.push({ text: ref, kind: 'remote', where: 'remote' })
    }
  }

  // The checked-out branch reads first.
  return chips.sort((x, y) => rank(x) - rank(y))
}

const rank = (chip: Chip) => ['head', 'base', 'local', 'remote', 'tag'].indexOf(chip.kind)

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

const PALETTE = ['#6BA3E8', '#E88F8A', '#6CC287', '#D9B44A', '#BFA0F0', '#E8A6CA', '#6CBCC6', '#E5A273']
const paint = (color: number) => PALETTE[color % PALETTE.length]

const ROW = 38
const LANE = 20
const FONT = 17
const CHIP_FONT = 15
const CHIP_CHAR = CHIP_FONT * 0.62
const CHIP_HEIGHT = 26
const CHIP_LINE = 32
const CHIP_GAP = 5
const CHIP_PAD = 6
const ICON = 16
const ICON_ROOM = ICON + 3
const MAX_CHIPS = 12
const MAX_LABEL = 26
const MAX_LANES = 12
// Labels share the row while the message keeps this much; past that they get a line
// of their own under it, so every label shows at any width.
const MIN_SUBJECT = 200
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

// The colors VS Code's graph gives a ref: the current branch blue, the base branch
// orange, a remote purple. Each softened, with dark words so a label reads at a glance.
const STYLE = `
.bg{fill:#fff}.t{fill:#1f2328}.d{fill:#656d76}.h{fill:transparent}
.r:hover .h{fill:rgba(107,163,232,.14)}
.c-head{fill:#CFE3FB;stroke:#6BA3E8}.ct-head{fill:#12345C}.i-head{stroke:#12345C}
.c-base{fill:#FCE3CC;stroke:#E5A273}.ct-base{fill:#6B3A0C}.i-base{stroke:#6B3A0C}
.c-local{fill:#D9F2E0;stroke:#6CC287}.ct-local{fill:#14532D}.i-local{stroke:#14532D}
.c-remote{fill:#E9DFFB;stroke:#BFA0F0}.ct-remote{fill:#3F2A73}.i-remote{stroke:#3F2A73}
.c-tag{fill:#FDF8DC;stroke:#D9B44A}.ct-tag{fill:#6f4e00}.i-tag{stroke:#6f4e00}
.dot{stroke:#fff}
.ic{fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.s{transition:transform .25s ease-out}
.r:hover .s{transform:translateX(var(--x,0));transition:transform var(--d,1s) linear .35s}
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;font-size:${FONT}px}
.m{font-family:ui-monospace,Menlo,monospace;font-size:${CHIP_FONT}px}
@media (prefers-color-scheme:dark){
.bg{fill:#1c1c1e}.t{fill:#f2f2f2}.d{fill:#a1a1aa}.dot{stroke:#1c1c1e}
.c-head{fill:#2A4A70;stroke:#6BA3E8}.ct-head{fill:#E1EEFC}.i-head{stroke:#E1EEFC}
.c-base{fill:#4A2F18;stroke:#E5A273}.ct-base{fill:#FBE3CC}.i-base{stroke:#FBE3CC}
.c-local{fill:#1C3A28;stroke:#6CC287}.ct-local{fill:#D9F2E0}.i-local{stroke:#D9F2E0}
.c-remote{fill:#352A52;stroke:#BFA0F0}.ct-remote{fill:#E9DFFB}.i-remote{stroke:#E9DFFB}
.c-tag{fill:#3d2f00;stroke:#D9B44A}.ct-tag{fill:#f2d35e}.i-tag{stroke:#f2d35e}
}
`

// Drawn rather than typed: a font's cloud glyph is small and differs by machine.
const BRANCH_ICON =
  '<circle cx="4" cy="3" r="1.8"/><circle cx="4" cy="13" r="1.8"/><circle cx="12" cy="4" r="1.8"/><path d="M4 4.8v6.4M12 5.8c0 3-8 2.4-8 5.4"/>'
const CLOUD_ICON = '<path d="M4.6 13a3.4 3.4 0 0 1-.4-6.8A4.4 4.4 0 0 1 12.6 7a3 3 0 0 1-.1 6z"/>'

function chipWidthOf(chip: Chip, room: number): { label: string; width: number } {
  const label = cut(chip.text, room)
  const icons = chip.where === 'both' ? 2 : chip.where === 'none' ? 0 : 1

  return { label, width: Array.from(label).length * CHIP_CHAR + CHIP_PAD * 2 + icons * ICON_ROOM }
}

function drawChip(chip: Chip, label: string, chipWidth: number, x: number, y: number): string {
  const iconAt = (at: number, shape: string) =>
    `<g class="ic i-${chip.kind}" transform="translate(${at} ${y - ICON / 2})">${shape}</g>`
  const leading = chip.where === 'local' || chip.where === 'both'
  const labelX = x + CHIP_PAD + (chip.where === 'none' ? 0 : ICON_ROOM)

  return (
    `<rect class="c-${chip.kind}" x="${x}" y="${y - CHIP_HEIGHT / 2}" width="${chipWidth}" height="${CHIP_HEIGHT}" rx="6"/>` +
    (leading ? iconAt(x + CHIP_PAD, BRANCH_ICON) : '') +
    (chip.where === 'remote' ? iconAt(x + CHIP_PAD, CLOUD_ICON) : '') +
    `<text class="m ct-${chip.kind}" x="${labelX}" y="${y + 5}">${escapeXml(label)}</text>` +
    (chip.where === 'both' ? iconAt(x + chipWidth - CHIP_PAD - ICON, CLOUD_ICON) : '')
  )
}

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
  const edgeRight = width - 6
  const usable = Math.max(40, edgeRight - textX)
  // A label cut only where it could not fit a line of its own, clear of the lanes.
  const labelRoom = Math.max(4, Math.min(MAX_LABEL, Math.floor((usable - CHIP_PAD * 2 - ICON_ROOM * 2) / CHIP_CHAR)))
  const laneX = (lane: number) => LANE / 2 + 6 + lane * LANE
  // Each row is as tall as its labels need, so each row's place adds up from the top.
  const plans = rows.map(row => {
    const all = chipsOf(row.commit.refs, remoteNames)
    const chips = all.slice(0, MAX_CHIPS).map(chip => ({ chip, ...chipWidthOf(chip, labelRoom) }))
    const inlineWidth = chips.reduce((sum, one) => sum + one.width + CHIP_GAP, 0)
    const isInline = chips.length === 0 || inlineWidth <= usable - MIN_SUBJECT
    const placed: { index: number; x: number; line: number }[] = []
    let x = textX
    let line = 0

    if (!isInline) {
      chips.forEach((one, index) => {
        if (x > textX && x + one.width > edgeRight) {
          x = textX
          line += 1
        }
        placed.push({ index, x, line })
        x += one.width + CHIP_GAP
      })
    }

    return { all, chips, isInline, placed, height: ROW + (isInline ? 0 : (line + 1) * CHIP_LINE) }
  })
  const ys: number[] = []

  plans.reduce((top, plan, index) => {
    ys[index] = top + ROW / 2

    return top + plan.height
  }, 0)
  const height = plans.reduce((sum, plan) => sum + plan.height, 0) + ROW / 2
  const lines: string[] = []
  const dots: string[] = []
  const texts: string[] = []
  // Edges run down to the next row; the drawing's own edges cut what leaves the page.
  const drawEdges = (row: Row, y: number, y2: number) => {
    for (const edge of row.edges) {
      const x1 = laneX(edge.from)
      const x2 = laneX(edge.to)
      const d =
        x1 === x2
          ? `M${x1} ${y}V${y2}`
          : `M${x1} ${y}C${x1} ${y + (y2 - y) * 0.55} ${x2} ${y2 - (y2 - y) * 0.55} ${x2} ${y2}`

      lines.push(`<path d="${d}" stroke="${paint(edge.color)}"/>`)
    }
  }

  // What comes down from the page above.
  if (above !== undefined) drawEdges(above, -ROW / 2, ROW / 2)

  rows.forEach((row, index) => {
    const y = ys[index] ?? 0
    const plan = plans[index]

    if (plan === undefined) return
    drawEdges(row, y, ys[index + 1] ?? y + ROW)

    const isHead = row.commit.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '))
    const isMerge = row.commit.parents.length > 1

    dots.push(
      `<circle class="dot" cx="${laneX(row.lane)}" cy="${y}" r="${isHead ? 7.5 : isMerge ? 4.5 : 6}" fill="${paint(row.color)}" stroke-width="2"/>`,
    )

    const extra = plan.all.length - plan.chips.length
    let right = edgeRight
    let chipMarks = ''

    if (plan.isInline) {
      for (const one of [...plan.chips].reverse()) {
        right -= one.width
        chipMarks += drawChip(one.chip, one.label, one.width, right, y)
        right -= CHIP_GAP
      }
    } else {
      for (const spot of plan.placed) {
        const one = plan.chips[spot.index]

        if (one !== undefined) {
          chipMarks += drawChip(one.chip, one.label, one.width, spot.x, y + ROW / 2 + CHIP_LINE / 2 + spot.line * CHIP_LINE - 3)
        }
      }
      if (extra > 0) {
        chipMarks += `<text class="m d" x="${textX}" y="${y + plan.height - ROW / 2 - 4}">+${extra}</text>`
      }
    }

    const subject = cut(row.commit.subject, MAX_SUBJECT)
    const age = ageOf(row.commit.time, now)
    const after = `  ${age} · ${cut(row.commit.author, 30)}`
    const hasInlineChips = plan.isInline && plan.chips.length > 0
    // Measured by estimate, so a slide goes a little past the end rather than short.
    const room = (hasInlineChips ? right - 8 : edgeRight) - textX
    const textWidth = (Array.from(subject).length + Array.from(after).length) * FONT * SLIDE_CHAR
    const slide = Math.ceil(textWidth - room + 16)
    const motion =
      slide > 0
        ? ` style="--x:-${slide}px;--d:${Math.min(20, Math.max(1, slide / SLIDE_SPEED)).toFixed(1)}s"`
        : ''
    const tooltip = escapeXml(
      `${row.commit.hash.slice(0, 8)} · ${row.commit.author} · ${age}\n${subject}${plan.all.length > 0 ? `\n${plan.all.map(chip => chip.text).join(', ')}` : ''}`,
    )
    // The label's backing hides the message as it passes beneath.
    const backing = hasInlineChips
      ? `<rect class="bg" x="${right}" y="${y - ROW / 2}" width="${width - right}" height="${ROW}"/>`
      : ''

    texts.push(
      `<g class="r"><title>${tooltip}</title>` +
        `<rect class="h" x="${textX - 4}" y="${y - ROW / 2}" width="${width - textX + 4}" height="${plan.height}"/>` +
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
