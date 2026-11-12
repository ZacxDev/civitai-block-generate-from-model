# Gotchas: bugs this block has had, and what each one taught

These are bugs in **this app's own code**, recorded with the cause and the rule
that came out of each. Platform behaviour (the SDK hooks, the host, the manifest
contract) is documented upstream. The rules each entry here depended on are
summarised inline, so nothing below needs a platform doc to make sense.

Every entry predates the port onto `@civitai/sdk` over REST (#11). The code each
one shaped is still in `src/App.tsx`, and its regression tests are still in
`src/__tests__/`. Version numbers are the `block.manifest.json` version that
shipped the fix; the commit is on this repo's `main`.

Contents:

1. [The queue's three phantom-card bugs, and why the bridge was removed](#1-the-queues-three-phantom-card-bugs-and-why-the-bridge-was-removed)
2. [A failed estimate must be handled in `.then`, not `.catch`](#2-a-failed-estimate-must-be-handled-in-then-not-catch)
3. [The estimate must use the same seed decision as submit](#3-the-estimate-must-use-the-same-seed-decision-as-submit)
4. [The block must set `data-theme` on its own root](#4-the-block-must-set-data-theme-on-its-own-root)
5. [`iframe.minHeight` must match the rendered height](#5-iframeminheight-must-match-the-rendered-height)

---

## 1. The queue's three phantom-card bugs, and why the bridge was removed

**Background.** `useBuzzWorkflow()` exposes ONE shared `status` / `result` pair
for the whole block, but the block runs a queue of many jobs. v0.2.10 added a
"compatibility bridge": a `useEffect` on `[status, result]` that mirrored the
shared `result` into the queue, keyed on `result.workflowId`. When no job owned
that id, the bridge created a `bridged: true` card. That create-path produced
three separate bugs, because `estimate()`, `submit()` and `poll()` all write to
the same shared `result`.

### 1a. Submit race: two cards per Generate (fixed in v0.2.14, `78ae760`)

- **Symptom:** each Generate added two loading cards. One resolved to an image;
  the other showed "0 Buzz" and never resolved.
- **Cause:** `handleGenerate` enqueues its job before `submit()` resolves, so
  the job's `workflowId` is still null. The real `submit` writes the shared
  `result`, which carries the id, in a different microtask from the
  `patchJob` that stamps the id onto the job. During that gap the bridge saw a
  `workflowId` that no job owned, and minted a duplicate card. The duplicate's
  cost fell back to the unresolved estimate, which showed as 0, and it never
  polled.
- **Fix:** the create-path skipped when a non-bridged in-flight job with
  `workflowId == null` was pending.
- **Why the tests missed it:** the mock `submit` was a plain `vi.fn`, which
  never touched the hook's shared `result`. The regression test in
  `queue.test.tsx` drives the race with `setMockWorkflow` and a re-render while
  a deferred submit hangs.

### 1b. Estimates minted cards (wrong fix in v0.2.15, right fix in v0.2.16, `dbd2431`)

- **Symptom:** clicking a showcase image triggers `estimate()`. Every click
  appended a new "Generating" card, though nothing had been submitted.
- **Cause:** `estimate()` does `setResult(snapshot); setStatus('confirming')`,
  so after every estimate the shared `result` held the estimate's snapshot. An
  estimate runs on mount, on every showcase pick and on every cost-bearing
  override, and the bridge turned each snapshot into a card.
- **The v0.2.15 fix was wrong. Don't repeat it.** It excluded a `'whatif'`
  sentinel `workflowId`, on the assumption that estimate snapshots carry one.
  They don't: every whatif preview gets a real, unique id. The symptom already
  showed this. A constant id would have matched an owned card from the second
  click on and yielded only one card, not a new card every time.
- **The v0.2.16 fix:** gate on the hook `status`, not the id. The bridge
  returned early on `estimating` or `confirming`.
  - **Trap inside the fix:** the inverse gate, "proceed only on a submit
    status", broke 13 tests. The bridge also had to surface a completed
    workflow while `status === 'idle'`. So exclude the estimate statuses;
    don't require the submit ones.
- **Why the tests missed it:** the mock `estimate` resolved a value but never
  wrote `state.workflow.result`. The regression test runs two estimates with
  distinct ids under `status: 'confirming'` and asserts zero cards. Without the
  fix it produces two cards, the same as the symptom.

### 1c. A second card after the first poll (fixed in v0.2.17, `b8d83b1`)

- **Symptom:** a second "Generating" card appeared after the first poll of
  every submit.
- **Cause, in order:**
  1. `handleGenerate` submits and stamps its own job with the real id.
  2. The v0.2.11 post-submit re-quote calls `estimate()`, which puts a new
     whatif snapshot, with its own unique id, into the shared `result`.
  3. `poll()` sets `status: 'polling'` *before* it sets `result`. For one
     render the bridge sees `polling` alongside the stale estimate, whose id no
     job owns.

  The v0.2.16 status gate passed, because `polling` is a submit status. The
  v0.2.14 guard didn't trigger either, because the own job already had its id.
- **Fix:** skip the create-path whenever any non-bridged job is in flight.
  - **Rejected alternative:** creating only from terminal results broke seven
    tests that legitimately injected a non-terminal result with no own job.

### Resolution: the bridge was deleted (v0.2.18, `cc78574`)

Three guards on one effect meant the design was the bug. v0.2.18 removed the
whole `[status, result]` effect and the `QueueJob.bridged` field.

- **What drives the queue now:** only `handleGenerate`, which mints an own job
  with its own poll loop.
- **What the shared `status` / `result` still drive:** only the CTA cost
  estimate and the insufficient-Buzz CTA.
- **Tests:** they now drive the queue through the real path, using the
  `generate()` helper in `src/test/test-utils.ts`. The bridge regressions
  became invariants: an estimate adds no card, and one submit makes one card
  even with concurrent estimates.

**Rule:** never mirror the SDK's single-workflow shared state into this
multi-job queue. If a workflow ever needs to appear without a `submit()`, create
it explicitly as an own job.

**General lessons:**

- When the symptom is "a new X every time", the key is unique per event. Check
  the runtime value before designing around a presumed constant.
- To tell an estimate from a submit, use the hook status, never the
  `workflowId`.
- When a path has legitimate neutral states, such as `idle`, gate by excluding
  the bad states rather than requiring the good ones.

---

## 2. A failed estimate must be handled in `.then`, not `.catch`

**Shipped in v0.2.19, `0ff37f3`.**

- **Symptom:** the Generate CTA never showed the real cost. It stayed on its
  `≤ budget` fallback with `estimatedCost` null, and gave no hint why.
- **Platform cause, fixed upstream in civitai/civitai:** the host's
  error-path snapshot had an empty `workflowId`. The SDK's reply validator
  dropped it, so the request hung until it timed out.
- **This block's half:** even with a delivered reply, a failed estimate was
  invisible. The transport **resolves** on any valid reply, including a
  `status: 'failed'` snapshot, and **rejects** only on timeout. So a failed
  estimate lands in `runEstimateNow`'s `.then`, not its `.catch`, and the block
  silently nulled the cost there.
- **Fix:** `.then` detects a delivered failed snapshot (`status === 'failed'`
  or an `error`) and surfaces it as an estimate error instead of a missing
  cost.
  - What a viewer may be shown has changed since then: raw server text is
    never rendered. Read the 🔴 comments in `runEstimateNow` before you touch
    that branch.

**Rule:** handle the failed snapshot wherever the promise resolves. Otherwise a
"failed" answer looks exactly like no answer.

---

## 3. The estimate must use the same seed decision as submit

**Fixed in v0.2.20, `4e0968a`.**

- **Symptom:** the CTA quoted 0 Buzz, but the second and later generations of
  a showcase charged the full price.
- **Why 0 was a real answer:** the whatif prices a cache hit (an identical
  workflow, including the seed) at 0, and a fresh job at full cost.
- **Cause:** the estimate called `buildSubmitParams(..., /*randomizeSeed*/ false)`,
  so it always used the showcase's cached seed and always got a cache hit.
  Submit randomizes on `randomizeSeedOnce || isRegenerate`, so every
  generation after the first is a fresh job. `buildSubmitParams` randomizes by
  *omitting* the `seed` key.
  - The first generation of a showcase really is a cache hit at 0, which is
    correct.
- **Fix:**
  1. `isRegenerate` moved above `runEstimateNow`, so the estimate and the
     submit read one decision.
  2. The estimate passes `randomizeSeedOnce || isRegenerate`.
  3. Both values joined the estimate effect's deps, so the CTA re-quotes as
     soon as the decision flips.
  4. `runEstimateNow(forceRandomizeSeed?)` was added. `handleGenerate`'s
     post-submit re-quote passes `true`: its closure's `isRegenerate` is stale
     until the next render, and without the override that re-quote clobbered
     the correct quote with the cached-seed 0.
- **Regression test:** `cost-update.test.tsx` asserts the post-submit re-quote
  omits the seed.

**Rules:**

- A cost estimate must build its params with exactly the logic of the action
  it quotes.
- A 0 quote may be a genuine cache hit.
- When a closure-captured value flips on a later render, pass the current
  decision into the imperative call explicitly.

---

## 4. The block must set `data-theme` on its own root

**Fixed in v0.2.21, `a43a64c`.**

- **Symptom:** on a dark host, the results carousel's right-edge fade
  (`.gfm-carousel-wrap::after`) rendered as a light smear. The dark hover
  variants of buttons, links and icons were wrong too.
- **Cause:** most dark styling here is inline (`theme === 'dark' ? … : …`).
  Pseudo-elements and `:hover` / `:focus` states can't be inline-styled, so
  they live in the injected `<style>` behind `[data-theme="dark"]` selectors.
  A stale comment claimed the host sets that attribute. It can't: the block is
  a separate iframe document, and the host only passes `theme` in
  `BLOCK_INIT`. Nothing set `data-theme`, so every dark rule silently never
  matched.
- **Fix:** every root `<div ref={rootRef}>` return path now sets `data-theme`
  itself, from the `BLOCK_INIT` theme. `regression.test.tsx` asserts the
  attribute in both themes.

**Rule:** prefer inline theme values. For anything that can't be inline, the
block must put `data-theme` (or a CSS variable) on its own root.

---

## 5. `iframe.minHeight` must match the rendered height

- **Symptom:** a visible layout shift when the block loaded.
- **Cause:** `block.manifest.json` declared `iframe.minHeight: 240`, but the
  block renders at about 395 px. The slot reserves `minHeight`, then grows the
  iframe when the block reports ready, which was a shift of about 155 px.
- **Fix:** `minHeight` was set to the measured height, `400`.

**How to measure:** run `pnpm run dev:harness` and read the height in the
`RESIZE_IFRAME` message the block emits. Alternatively, read
`getBoundingClientRect().height` on the root.

**Rule:** re-measure and update `minHeight` whenever the layout's resting
height changes.
