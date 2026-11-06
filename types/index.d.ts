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

export type GraphData = {
  root: string
  head: string
  branches: Branch[]
  commits: Commit[]
  compares: Compare[]
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
      page: Shaped<number>
      recents: Shaped<string[]>
      data: Shaped<GraphData | null>
      detail: Shaped<CommitDetail | null>
    }
  }
}
