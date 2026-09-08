# Agent guide

The canonical agent guide for this repo is **[`CLAUDE.md`](./CLAUDE.md)**. Read
that file; this one exists so agent runtimes that look for `AGENTS.md` find the
pointer.

@CLAUDE.md

---

**What used to be here, and why it went.** This file previously carried the
generic `civitai-block-starter` guide that `civitai app init` clones — it was
never rewritten for this app and had gone stale in ways that actively misled:
it described the *starter's* file layout (no `src/__tests__/`, no
`src/test/test-utils.ts`), pinned versions this repo has long since moved past,
and stated "the starter intentionally ships without an e2e suite" while
`src/__tests__/` here is the largest thing in the repo after `App.tsx` itself.
(No test count is quoted on purpose — a number in prose rots on the next test
anyone adds, and a stale one is how this file got here.) The include is also
flipped: `CLAUDE.md` used to be a one-line `@AGENTS.md`, which meant the only
file a Claude Code session loads by default was an indirection to prose about a
different codebase. The upstream starter text is still available in its own
repo (`civitai/civitai-app-starters`), where it is maintained.
