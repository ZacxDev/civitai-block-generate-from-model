# Civitai App Block — Generate from this model

> One-tap generation widget that embeds on the **`model.sidebar_top`** slot of any Civitai model page.
> This repo dogfoods the [civitai-app-starters](https://github.com/civitai/civitai-app-starters) external-developer experience — it is built **outside** the platform monorepo, against the published SDK, just as a third-party developer would.

[![Status](https://img.shields.io/badge/status-hackathon-orange)]() [![Slot](https://img.shields.io/badge/slot-model.sidebar__top-blue)]() [![License](https://img.shields.io/badge/license-MIT-green)]()

---

## What this is

A [Civitai App Block](https://github.com/civitai/civitai-app-starters): a Vite + React SPA iframed into a sidebar slot on civitai.com's model pages. The block reads the page's model context (`modelId`, `modelVersionId`) from the host, lets the user type an optional short prompt, and submits a generation workflow via a block-scoped JWT.

What makes it different from `/generate`:
- **No model picker** — the model is the page
- **No sampler / seed / CFG sliders** by default (publisher can toggle `show_advanced`)
- **No prompt-required gate** — empty prompt uses the model's trigger phrase via server-side defaulting
- **Buzz budget enforced by the platform** — the manifest declares a `buzz_budget_per_gen`; the JWT carries it; the orchestrator rejects over-budget submissions before they run

## Why this repo exists

Civitai is dogfooding its own [App Blocks platform](https://github.com/civitai/civitai-app-starters). To validate that an *external* developer can build a block end-to-end using only the public SDK + documentation, we built this block **outside** the platform monorepo:

- This repo is on `ZacxDev` (personal namespace), not `civitai/*`
- The block depends on `@civitai/app-sdk` + `@civitai/sdk` **as installed packages**, not workspace siblings
- The deploy story (`pnpm build` → Vite bundle → nginx static + CSP `frame-ancestors`) is what any block author will do

If you're an external developer reading this — congrats, you found a working reference implementation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ civitai.com — model page                                            │
│ ┌──────────────────────────┐  ┌──────────────────────────────────┐  │
│ │ ModelVersionDetails      │  │ BlockHost (this iframe)          │  │
│ │  - hero                  │  │  src=https://blocks-pr2319.       │  │
│ │  - sidebar               │──│      civitaic.com/generate-      │  │
│ │    └─ BlockSlot          │  │      from-model/                 │  │
│ │       └─ "this iframe"   │  │                                  │  │
│ └──────────────────────────┘  │  BLOCK_INIT { token, context,    │  │
│                                │              viewer, settings }  │  │
│                                │  RESIZE_IFRAME, pickers only     │  │
│                                └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ block-scoped JWT
                                       ▼
                          ┌──────────────────────────────┐
                          │ civitai.com /api/v1/blocks/  │
                          │  - workflows/estimate        │
                          │  - workflows/submit          │
                          │  - workflows/poll            │
                          │  - workflows/cancel          │
                          │  - buzz                      │
                          │                              │
                          │ each route a thin adapter    │
                          │ over the SAME procedure the  │
                          │ bridge op used to call       │
                          └──────────────────────────────┘
```

### The platform seam

Everything platform-shaped lives behind [`src/platform/`](./src/platform/), and that
directory is the **only** place `@civitai/sdk` is named — pinned by
[`src/platform-seam.test.ts`](./src/platform-seam.test.ts), which also asserts no
importer of `@civitai/blocks-react` is left. The hooks there keep the signatures the
bridge package's hooks had (`useBuzzWorkflow`, `useBuzzBalance`, `useCheckpointPicker`,
…), which is why a 3,400-line `App.tsx` changed at its import block rather than
throughout.

The bridge is still used, but only for genuine **host UI**: the iframe resize and the
Buzz-purchase / Checkpoint pickers. Everything that is data goes over REST.

### Known gaps on the SDK transport

Three losses, all deliberate, all stated because a silent one is worse than a missing
feature:

1. 🔴 **The generation path is NOT verified against production.** The four routes it
   calls — `/api/v1/blocks/workflows/{estimate,submit,poll,cancel}` — are merged in
   `civitai/civitai` (`2a2eb0fe2f`, #5068) but **not deployed**: as of 2026-09-24 all
   four answer `404 text/html` on civitai.com, where a deployed block route answers
   `401 {"error":"Block token required"}` in JSON. The client here is written against
   those route files' committed contract and covered against a fake server
   ([`src/platform/testing.ts`](./src/platform/testing.ts)); nothing about it has been
   exercised end to end against a real civitai.com. `GET /api/v1/blocks/buzz` *is*
   deployed.

2. 🔴 **The viewer's Checkpoint override no longer persists.** The bridge wrote it into
   `block_user_settings` via `SET_USER_CHECKPOINT`; `@civitai/sdk` does not carry that
   request and there is **no REST route for block user settings**. A swap still applies
   immediately and lasts the session, then falls back to the publisher default on
   remount. `useCheckpointPicker().persist` is a documented no-op rather than a
   rejection: nothing failed, so an error on every swap would be a lie.

   **The viewer is told, in the UI.** After a swap, the Advanced section renders a
   quiet note under the checkpoint row — *"Applies to this session only — reloading
   the block restores the default checkpoint."* — in the subtle-text style, not the
   error style. A README is not a UI; this gap is surfaced at the seam it degrades.
   Because `persist` cannot reject, the call site carries **no** rollback/`catch`
   around it — dead code there would have read as "persistence failure is handled"
   while no persistence happens at all.

3. **Two smaller ones.** The Checkpoint picker can no longer pre-highlight the current
   selection (`OPEN_RESOURCE_PICKER` takes no `currentVersionId`), and
   `openPurchaseModal` no longer reports `newBalance` (the SDK projects the reply down
   to `{ purchased }`) — the block refetches the balance instead, so nothing reads a
   wrong number.

## Quick start

```bash
git clone https://github.com/ZacxDev/civitai-block-generate-from-model.git
cd civitai-block-generate-from-model
cp .env.example .env

# The toolchain (node + pnpm) is pinned by the flake — `direnv allow`, or:
nix develop

pnpm install --frozen-lockfile
pnpm run dev:harness     # http://localhost:5173 — local dev with simulated host
```

Without nix: node major per [`.nvmrc`](./.nvmrc) and pnpm 11 (see [`flake.nix`](./flake.nix)).

The dev harness simulates BLOCK_INIT, intercepts outbound `postMessage`s, and echoes token refreshes — so you can iterate on the UI without civitai.com actually embedding you.
It also serves the block REST routes locally (`src/dev/harnessServer.ts`), so a generation runs end to end on your machine and **no request leaves it**. That server exists because the transport moved: since the `@civitai/sdk` port the data path is `fetch`, and without it `dev:harness` would fire real, money-shaped POSTs at civitai.com signed with the harness's deliberately-invalid mock JWT.

## Build & deploy

```bash
pnpm test                   # vitest — UI suites + the platform layer against a fake server
pnpm run typecheck          # tsc --noEmit
pnpm build                  # → ./dist/
pnpm run docker:build       # → ghcr.io/zacxdev/civitai-block-generate-from-model:latest
```

The Docker image runs nginx serving `/generate-from-model/` (the path declared in `block.manifest.json`'s `iframe.src`). For the hackathon, the image is pulled by the `civitai-blocks-hackathon` namespace in `datapacket-talos`.

## Manifest

[`block.manifest.json`](./block.manifest.json) is the contract:

| Field | Value | Why |
|-------|-------|-----|
| `blockId` | `generate-from-model` | Stable identifier across versions |
| `slotId` | `model.sidebar_top` | Targets the model-page sidebar |
| `scopes` | `models:read:self`, `ai:write:budgeted`, `buzz:read` | Just what the block needs — `:self` and `:budgeted` are context-bound |
| `iframe.src` | `https://blocks-pr2319.civitaic.com/generate-from-model/` | Will move to `blocks.civitai.com` for production |
| `contentRating` | `pg` | Compatible with any-rating model pages |

Publisher-configurable settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `buzz_budget_per_gen` | 10 | Hard cap on per-generation Buzz spend (platform-enforced) |
| `default_prompt_suffix` | `""` | Appended to user prompt (style hints) |
| `show_advanced` | `false` | Reveal seed/sampler/steps controls |

## SDK install

```json
"dependencies": {
  "@civitai/app-sdk": "^0.36.0",
  "@civitai/sdk": "^0.2.0"
}
```

Published from [civitai/civitai-app-starters](https://github.com/civitai/civitai-app-starters).
`@civitai/app-sdk` is kept for its **types only** (`BlockWorkflowSnapshot`, `ModelSlotContext`, `ShowcaseImage`, …); `@civitai/sdk` is the runtime.

## License

MIT
