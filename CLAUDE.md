# Generate from this model — agent guide

A Civitai **App Block**: a sidebar widget (`model.sidebar_top`) iframed into a
model page. The model *is* the page — no picker, no prompt required — and one
tap submits a real generation that **spends the viewer's Buzz**.

Everything load-bearing lives in `src/App.tsx` (~4k lines, deliberately one
file) and the invariants that must never regress are the money ones:

- **`isSpendLimitRefusal` decides whether a failure was an affordability
  refusal or an execution failure.** A wrong `false` shows an unhelpful
  message; a wrong `true` offers to charge someone for a problem money cannot
  solve. Its two clauses are a *lifecycle* fact (a refusal is a job that never
  started — a resolved `submit()` is money-COMMITTED and is never refunded on a
  later `failed` snapshot) plus the arithmetic. Rounds 3–5 each patched the
  predicate and each patch produced the next round's user-facing defect.
- **The verdict is classified ONCE, at the instant the decision arrives, and
  stored keyed to its subject** (the cost-bearing configuration the quote was
  about). Re-deriving it per render made the CTA and the card disagree on
  screen about one snapshot when the balance moved in between.
- **The per-call ceiling is the host's**: `cost_estimate <= token.buzzBudget`,
  from the manifest's `buzz_budget_per_gen` setting. The block displays it; the
  platform enforces it.

The 🔴 comments in `src/App.tsx` are the incident log for that path. Read them
before touching it — several of them record a theory that was *retracted*.

This repo is a **public OSS mirror** and a dogfood of the external-developer
experience: it builds outside the platform monorepo against the *published*
`@civitai/*` packages, exactly as a third-party author would. Keep it that way.

## Get a shell

`node` and `pnpm` are **not on PATH** outside the dev shell. The flake pins the
toolchain:

```bash
direnv allow          # or: nix develop
pnpm install --frozen-lockfile
```

| Task | Command |
|---|---|
| The gates CI runs | `pnpm test && pnpm run typecheck && pnpm build` |
| Types only | `pnpm run typecheck` |
| Mock host (`src/dev/Harness.tsx`) | `pnpm run dev:harness` → http://localhost:5173 |
| Container image | `pnpm run docker:build` |
| Platform approve-time validator | `civitai app validate` (the Go CLI, installed separately — the flake does not ship it) |

**Toolchain pins.** `.nvmrc` is the single authority for the node major — the
flake reads it with `builtins.readFile`, and CI reads it via
`node-version-file`. pnpm's major is stated twice (`flake.nix`'s `pnpmMajor` and
the `pnpm/action-setup` step) because the action reads only its own input or a
`packageManager` field this repo deliberately does not declare — adding one
would change what the *platform's* builder does, since it runs against the same
`package.json`. `src/toolchain-lockstep.test.ts` fails if those two drift, or if
someone hardcodes a node version back into the workflow (this repo shipped
`node-version: '22'` as a literal until that guard landed).

⚠️ The `Dockerfile`'s `FROM node:24-alpine` is a **third** statement of the node
major that no guard covers — a `FROM` tag cannot read `.nvmrc`. Bump it by hand.

`pnpm-workspace.yaml` ships **in the submitted bundle** and is required at
install time: it declares the single-package root and the `allowBuilds`
approval for `esbuild`, without which pnpm 11 exits `ERR_PNPM_IGNORED_BUILDS`.
`.github/` is *not* in the bundle, so CI can never catch a mistake in it.

Only `x86_64-linux` is exercised. The flake evaluates for `aarch64-linux` and
`aarch64-darwin` too; `x86_64-darwin` is absent because nixpkgs-unstable
dropped it.

## Where a change belongs

Most work that *looks* like a bug here is a gap one layer down. Canonical
checkouts live at `~/workspace/civit/<repo-name>`; sibling directories with a
suffix are topic worktrees of the same remotes, usually on a feature branch.

| The change is about | Repo | Local |
|---|---|---|
| This block's own UI/logic — the CTA, the money verdict, the carousel, the harness | **`ZacxDev/civitai-block-generate-from-model`** (here) | — |
| A hook, a type, the mock host, the design system — anything imported from `@civitai/*` | **`civitai/civitai-app-starters`** | `civitai-app-starters` |
| Host/server behavior: the `/apps/run` page surface, block token + scope enforcement, the page money path, app storage, the workflow read-model, submit/approval | **`civitai/civitai`** | `civitai` |
| `civitai app init/validate/submit`, login, dev tunnel | **`civitai/cli`** (Go) | `cli` |
| Public developer docs (developer.civitai.com) | **`civitai/civitai-developer-docs`** | `civitai-developer-docs` |

**Every `@civitai/*` package ships from the one starters repo** —
`packages/civitai-{app-sdk,sdk,blocks-react,components,components-react,theme}`.
This block installs two of them: `@civitai/sdk` (the runtime — REST + host UI)
and `@civitai/app-sdk` (types only). It was ported OFF `@civitai/blocks-react`,
the postMessage bridge package; do not reintroduce it. `src/platform/` is the
only directory allowed to name `@civitai/sdk`, and `src/platform-seam.test.ts`
enforces both halves.
A missing hook, a wrong type, a mock host that doesn't simulate something: that
is a PR *there*, not a workaround here.

Sibling app blocks worth reading for prior art — they hit the same platform
edges: `ZacxDev/civitai-app-gen-matrix`, `…-model-benchmarking`,
`…-playable-collections`, `…-custom-generators`, `…-sensei`, `…-requests`.

## Documentation sources, in authority order

1. **The installed package itself.** `node_modules/@civitai/<pkg>/dist/*.d.ts`
   and its `README.md` are the only source guaranteed to describe *the version
   this repo builds against* — currently `@civitai/app-sdk@^0.36.0` and
   `@civitai/sdk@^0.2.0`; check `package.json` first. Subpaths matter: this
   repo imports types from `@civitai/app-sdk/blocks`, and the `@civitai/sdk`
   root plus `@civitai/sdk/testing` (the fake transport) from `src/platform/`.
2. **https://developer.civitai.com/apps/** — `guide/{quickstart,concepts,embedding,theming,text-to-image,comfy-cloud}`
   and `reference/{hooks,manifest,messages,scopes,components,generation,cli}`.
   Best for *why* and for the message-bridge contract. ⚠️ The generated pages
   carry a `sources:` front-matter naming the package version they were built
   from, and it **lags** the version here — when the page and the `.d.ts`
   disagree, the `.d.ts` wins.
3. **The starters repo** — `docs/build-your-first-app-block.md` and
   `starters/examples/*` (one runnable example per feature). Real code beats
   prose for "how is this hook meant to be used".
4. **The host implementation** in `civitai/civitai` — last-resort ground truth
   for server behavior the docs don't specify (which errors the orchestrator
   returns, what a scope actually gates, how a workflow snapshot is shaped).

For React 19 / Vite / Vitest specifics, use the `context7` MCP tools rather than
recalling from memory.

## Verifying a change

`pnpm test` is **one** vitest project: jsdom + Testing Library, over
`src/**/*.test.{ts,tsx}` plus `src/__tests__/**`. The SDK is mocked through
`src/test/test-utils.ts` (`blocksReactMockFactory`) — a test that needs the
balance to *move* mid-flight uses `setMockBuzzBalanceRefetch`; before that
existed the whole money-verdict family was unreachable and a fully green
176-test suite said nothing about it.

**What cannot be verified here.** The real Buzz spend loop is Turnstile + auth
gated. No local run, harness run, container run, or test proves a tap actually
charged correctly — that needs a human in a real mod-gated host. Say so plainly
rather than reporting a green suite as if it covered the money path.

New guards should pin a *relationship* that cannot rot on a routine bump, and
be watched failing before they are trusted. `src/toolchain-lockstep.test.ts`
and `src/version-lockstep.test.ts` are the pattern to copy: both explain, in
the file, the incident they exist to prevent, and both throw rather than pass
when the thing they inspect is missing.

## Release protocol

- **`block.manifest.json` and `package.json` versions move together**, and
  `src/version-lockstep.test.ts` enforces it. The manifest version is what the
  platform submits and what `civitai app submit` compares against the highest
  approved version; `package.json`'s is what the build and toolchain read. These
  two had drifted all the way to manifest `0.2.22` against package `0.1.0` — the
  guard could only land once they were reconciled, at `0.2.23`.
- **`buildCommand` is `pnpm run build` and `outputDir` is `dist`.** These are
  what the *platform* runs to build the live app, so treat that pair as the
  highest-blast-radius lines in the repo. They are also not optional here: with
  a pnpm lockfile and no `buildCommand`, the platform falls back to the legacy
  default `npm run build` → `npm ci` → a `package-lock.json` this repo does not
  commit, and `civitai app validate` fails the repo outright. The schema
  requires `outputDir` whenever `buildCommand` is set.
- `.env.production` bakes `VITE_BLOCK_ALLOWED_PARENT_ORIGINS` into the bundle at
  **build time**. Wrong value = the `IframeTransport` drops every host message
  and the iframe renders blank.
- Bumping any `@civitai/*` dependency re-resolves the lockfile; if pnpm's
  freshness gate refuses a very fresh version, add a `minimumReleaseAgeExclude`
  block to `pnpm-workspace.yaml` naming it (none is needed today).
