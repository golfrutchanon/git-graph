# Git Graph

A Claude Code mod: a read-only pane that draws a repository's commit graph beside the chat.

- Tick any number of branches to show
- See which branch leads or trails which, and by how many commits
- See what waits to be pushed or pulled
- 100 commits a page; point at a row to slide a long message

It never changes a repository. Run git commands by asking Claude in the chat.

## Install

From a shell:

```
claude plugin marketplace add golfrutchanon/prompt-power-up
claude plugin install git-graph@copvang
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `golfrutchanon/prompt-power-up`, then Add plugin.

## Use

The pane opens by itself in a git repository. Closed, it comes back with `/git-graph`, or `/git-graph ~/path/to/repo` for another repository.

## Branches

- `dev`: where work happens
- `main`: what installed copies update from. Raise `version` in `.claude-plugin/plugin.json` before merging, or installed copies will not see the change.

## Develop

```
claude plugin validate .
claude plugin test .
```
