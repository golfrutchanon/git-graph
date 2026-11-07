export type Commit = {
  hash: string
  parents: string[]
  refs: string[]
  subject: string
  author: string
  time: number
}

export type Branch = {
  name: string
  isRemote: boolean
  upstream: string
  track: string
  time: number
}

export type Compare = { a: string; b: string; ahead: number; behind: number }

export type FileKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict'

export type FileChange = { kind: FileKind; path: string; from?: string }

// One list of files. `files` holds the first few of `total`, so the session's
// state stays small when a repo has thousands of them.
export type FileGroup = { files: FileChange[]; total: number; isPartial: boolean; error: string }

export type Changes = {
  uncommitted: FileGroup
  // Files `from` has changed that `to` does not have yet; null with nothing to compare.
  pending: (FileGroup & { from: string; to: string }) | null
}

export type GraphData = {
  root: string
  head: string
  branches: Branch[]
  commits: Commit[]
  compares: Compare[]
  changes: Changes
  fingerprint: string
  error: string
}

export type CommitDetail = { hash: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': {
      repo: Shaped<string>
      slots: Shaped<string[]>
      menu: Shaped<boolean>
      changesOpen: Shaped<boolean>
      page: Shaped<number>
      recents: Shaped<string[]>
      data: Shaped<GraphData | null>
      detail: Shaped<CommitDetail | null>
    }
  }
}
