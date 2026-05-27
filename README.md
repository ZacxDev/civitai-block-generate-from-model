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
- The block depends on `@civitai/app-sdk` + `@civitai/blocks-react` **as installed packages**, not workspace siblings
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
│                                │  SUBMIT_WORKFLOW {…}             │  │
│                                └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ block-scoped JWT
                                       ▼
                          ┌──────────────────────────────┐
                          │ civitai.com /api/v1/         │
                          │  - models/:id                │
                          │  - buzz/balance              │
                          │  - block-tokens (refresh)    │
                          │                              │
                          │ orchestrator (poc)           │
                          │  - workflow submission       │
                          │     attributed with          │
                          │     metadata.block.*         │
                          └──────────────────────────────┘
```

## Quick start

```bash
git clone https://github.com/ZacxDev/civitai-block-generate-from-model.git
cd civitai-block-generate-from-model
cp .env.example .env

npm install
npm run dev:harness     # http://localhost:5173 — local dev with simulated host
```

The dev harness simulates BLOCK_INIT, intercepts outbound `postMessage`s, and echoes token refreshes — so you can iterate on the UI without civitai.com actually embedding you.

## Build & deploy

```bash
npm run build              # → ./dist/
npm run docker:build       # → ghcr.io/zacxdev/civitai-block-generate-from-model:latest
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
  "@civitai/app-sdk": "^0.6.0",
  "@civitai/blocks-react": "^0.4.0"
}
```

Published from [civitai/civitai-app-starters](https://github.com/civitai/civitai-app-starters).

## License

MIT
