import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockSettings,
  useBuzzBalance,
  useBuzzPurchase,
  useBuzzWorkflow,
  useCheckpointPicker,
  WorkflowEstimateError,
  WorkflowSubmitError,
} from '@civitai/blocks-react';
import type {
  BlockCheckpointInfo,
  BlockContext,
  ModelSlotContext,
  ShowcaseImage,
  WorkflowStatus,
} from '@civitai/app-sdk/blocks';

/**
 * Generate from this model.
 *
 * The model on the sidebar context is pre-loaded; the user types an optional
 * short prompt and taps Generate. The block reads the publisher-configured
 * `buzz_budget_per_gen` from settings, calls the orchestrator via
 * `useBuzzWorkflow`, and renders the result inline.
 *
 * Anti-patterns avoided:
 * - No model picker (the whole point — the model IS the page)
 * - No sampler / seed / CFG sliders by default (publisher toggles `show_advanced`)
 * - No prompt-required gate — empty prompt uses the model's trigger phrase
 *   via server-side defaulting
 */
/**
 * User-supplied overrides to the showcase image's gen params. Only the
 * fields the user actively edited are stored here — undefined fields fall
 * through to the showcase value in buildSubmitParams(). Cleared on
 * showcase swap (selecting a new image is an explicit "reset to its
 * params" signal — see Gap 3 in the day-2 handoff).
 */
type ParamOverrides = {
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  sampler?: string;
  width?: number;
  height?: number;
  clipSkip?: number;
};

/**
 * One entry in the block's client-side generation queue.
 *
 * The on-site Civitai generator lets you fire off many generations that
 * run + poll independently and stack in a feed (see civitai-web
 * `src/components/ImageGeneration/Queue.tsx` + `QueueItem.tsx`). The block
 * replicates that UX WITHOUT touching the SDK: `useBuzzWorkflow` is
 * single-workflow-stateful (one shared `status` / `result`), but its
 * `submit()` / `poll()` primitives are stateless async calls that RETURN
 * the snapshot directly. So we can drive N concurrent workflows by holding
 * a job array here and running one poll loop per job off the returned
 * snapshots, ignoring the hook's shared state for queued jobs.
 *
 * `localId` is a stable client key minted at enqueue time (before the
 * workflowId lands from submit()), so React keys + per-job poll-loop
 * cancellation survive the submit round-trip. `workflowId` hydrates once
 * submit() resolves.
 */
type QueueJobStatus =
  | 'submitting'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'canceled';

type QueueJob = {
  localId: string;
  workflowId: string | null;
  status: QueueJobStatus;
  cost: number | null;
  imageUrls: string[];
  aspectRatio: string;
  error?: string;
};

const JOB_TERMINAL: ReadonlySet<QueueJobStatus> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

const isJobInFlight = (s: QueueJobStatus): boolean =>
  s === 'submitting' || s === 'pending' || s === 'processing';

// Short human label per status for the queue-slot badge. Mirrors the
// on-site generator's vocabulary (Queued / Processing / Done / Failed),
// adapted: 'submitting' + 'pending' both read "Queued" (the user can't
// distinguish "we're posting it" from "the orchestrator queued it" and
// shouldn't have to), 'processing' reads "Generating…".
function statusLabel(s: QueueJobStatus): string {
  switch (s) {
    case 'submitting':
    case 'pending':
      return 'Queued';
    case 'processing':
      return 'Generating…';
    case 'succeeded':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
    case 'canceled':
      return 'Canceled';
  }
}

// Color tone per status, matching the on-site generationStatusColors map
// (yellow=in-flight, green=done, red=failed, gray=expired/canceled).
type StatusTone = 'busy' | 'success' | 'error' | 'neutral';
function statusTone(s: QueueJobStatus): StatusTone {
  if (isJobInFlight(s)) return 'busy';
  if (s === 'succeeded') return 'success';
  if (s === 'failed') return 'error';
  return 'neutral'; // expired | canceled
}

let queueJobSeq = 0;
function nextLocalId(): string {
  queueJobSeq += 1;
  return `job-${queueJobSeq}-${Date.now()}`;
}

/**
 * Anonymous conversion. Resolve the parent (embedding page) origin to use as
 * the postMessage targetOrigin for REQUEST_SIGN_IN. We prefer the embedding
 * page's origin (from `document.referrer`) so the message is targeted, never
 * broadcast. Falls back to `'*'` only when the referrer is unavailable — the
 * REQUEST_SIGN_IN message carries no secret (it asks the host to open its own
 * login UI), and the host independently validates origin + event.source before
 * acting, so a broadcast can't be weaponised.
 */
export function resolveParentOrigin(referrer: string | undefined): string {
  if (referrer) {
    try {
      return new URL(referrer).origin;
    } catch {
      /* fall through */
    }
  }
  return '*';
}

/**
 * Raw postMessage of the SDK REQUEST_SIGN_IN envelope. Deliberately NOT routed
 * through an SDK hook so this works without waiting on a `@civitai/blocks-react`
 * npm publish (the new `useRequestSignIn` helper produces the identical wire
 * message). The host's IframeHost honors this only after BLOCK_READY and from
 * the pinned origin. `returnUrl` is optional; the host defaults it to the
 * current page and sanitises it to a same-origin path.
 */
export function postRequestSignIn(payload?: { returnUrl?: string }): void {
  if (typeof window === 'undefined' || !window.parent) return;
  const targetOrigin = resolveParentOrigin(
    typeof document !== 'undefined' ? document.referrer : undefined
  );
  window.parent.postMessage(
    { type: 'REQUEST_SIGN_IN', ...(payload ? { payload } : {}) },
    targetOrigin
  );
}

export function App() {
  const { ready, context, viewer, theme, blockInstanceId, token } = useBlockContext();
  const settings = useBlockSettings();
  const { submit, estimate, poll, cancel, status, result, error } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  // 🔴 Unconditional, component-level, ONE call. Once a refusal is known to be
  // a job that never started (`isSpendLimitRefusal`'s lifecycle clause), what
  // the viewer can spend is what separates the shortfall a top-up fixes from
  // the priced refusals it cannot.
  //
  // `loading` and `error` are deliberately NOT read: see `knownBuzzBalance`.
  const { balance: buzzBalance, refetch: refetchBuzzBalance } = useBuzzBalance();
  const checkpointPicker = useCheckpointPicker();
  // Latest poll fn in a ref so the per-job poll loops (started inside
  // handleGenerate, which closes over the submit-time `poll`) always call
  // the current hook instance without re-subscribing.
  const pollRef = useRef(poll);
  pollRef.current = poll;

  // The balance we reason about is the SDK's `balance` field as-is: the last
  // value a fetch successfully returned, or `null` before the first one ever
  // did. `useBuzzBalance` never clears it — `refetch()` flips `loading` and a
  // failure sets `error`, both leaving the last good figure in place — so
  // `null` means exactly "we have never known", which is the only case that
  // must fail toward NOT-a-shortfall.
  //
  // 🔴 THIS USED TO NULL THE BALANCE WHENEVER `loading` OR `error` WAS SET, and
  // that was round 6's F2. `refetch()` sets `loading` SYNCHRONOUSLY, so every
  // genuine shortfall blanked its own top-up CTA for one bridge round-trip and
  // put the Generate button back — beside a card still reading "spend limit" —
  // and a refetch that FAILED stranded that state until the next terminal
  // workflow, permanently offering a Generate that would fail identically.
  //
  // Reading a possibly-stale figure is safe BECAUSE of the lifecycle clause in
  // `isSpendLimitRefusal`: the only failures we classify are ones the host
  // never accepted, so THIS job's own price has not been debited.
  //
  // 🔴 THAT IS A CLAIM ABOUT THIS JOB, NOT ABOUT THE WALLET. The stale figure
  // can be wrong in BOTH directions, because a SIBLING job — or another tab, or
  // another block — can debit between the last settled read and this decision:
  //   - stale LOW (a top-up landed elsewhere) → we may offer a top-up the
  //     viewer no longer needs. Harmless.
  //   - stale HIGH (a sibling accepted job debited) → we may MISS a real
  //     shortfall. Viewer at 100, job A accepted at 60 and still polling, job
  //     B's submit replies `failed` priced 60: the stored balance is still 100,
  //     `100 >= 60`, so no shortfall is seen and no top-up is offered even
  //     though the wallet holds 40.
  // The second is the direction that costs the viewer something, and it is
  // unfixable from here — a figure read before a debit cannot know about it.
  // It is accepted deliberately: it lands on the FAIL-TOWARD-NOT-A-SHORTFALL
  // side of `isSpendLimitRefusal`'s 🔴 rule, whose whole point is that a missed
  // top-up costs an unhelpful error message while a wrong one sells Buzz for a
  // problem money cannot solve.
  //
  // 🔴 WHAT ACTUALLY CLOSES THE WINDOW, ENUMERATED — this said "every terminal
  // transition refetches", which was the same over-claim round 5 was corrected
  // on twelve lines below, made again about a wider set. There are exactly FOUR
  // `refetchBalanceRef.current()` sites: `cancelJob`, the poll loop's terminal
  // branch, the terminal-on-reply arm of the submit `try`, and the submit
  // `catch` (added in round 8, because its `patchJob` writes `'failed'`, which
  // IS in `JOB_TERMINAL`, and no poll loop exists to fire the other one).
  // Together those cover every transition that ENDS a job this block started.
  //
  // The one hole left is `dismissJob` on a job still in flight: it kills the
  // poll token, drops the card, and does not refetch. That is deliberate rather
  // than missing — dismiss ABANDONS a workflow instead of ending it (unlike
  // `cancelJob` it sends no server-side cancel), so the workflow keeps running
  // and may charge AFTER the dismiss. No read taken here could be the final
  // figure. The residual it leaves is exactly the stale-HIGH case above, and it
  // closes at the next of the four.
  const knownBuzzBalance = buzzBalance;
  const spend: SpendContext = {
    balance: knownBuzzBalance,
    // The per-call ceiling the HOST enforces (`cost_estimate <= token.buzzBudget`).
    // Absent when the token carries no budget claim, in which case there is no
    // ceiling clause to apply.
    budgetCap: token?.buzzBudget ?? null,
  };
  // Refs so the per-job closures (poll loops, the submit handler) read the
  // CURRENT balance/refetch rather than whatever was live when they were made —
  // a job outlives several balance reads.
  const spendRef = useRef(spend);
  spendRef.current = spend;
  // Same device for the money verdict's SUBJECT key (see `spendLimitedForKey`).
  // The poll loop is a `useCallback([])` created above the key's own
  // definition, so it reads the key through this ref at settle time; the two
  // render-body classification sites close over the value directly, which is
  // stricter — see the notes at each.
  const spendKeyRef = useRef('');
  const refetchBalanceRef = useRef(refetchBuzzBalance);
  refetchBalanceRef.current = refetchBuzzBalance;
  // 🔴 THE LIFECYCLE FACT THE MONEY PREDICATE TURNS ON: the set of jobs the
  // host ACCEPTED. A `localId` lands here the moment `submit()` replies with
  // any non-`failed` status, which per the SDK means the reservation was kept
  // and the Buzz is committed ("A resolved submit is money-COMMITTED… we do NOT
  // refund on a non-throwing failed snapshot" — `useBuzzWorkflow`). Membership
  // is written at exactly ONE site (the submit reply) and read by both
  // classification sites, so the two cannot disagree about whether a job ran.
  //
  // 🔴 WHAT THE THREE READS ACTUALLY CARRY, MEASURED — this comment used to
  // imply they carry a decision each, and they do not. Hardcoding the poll
  // site's `accepted` to `true` and the submit site's to `false` each leaves the
  // whole suite green, because both are INVARIANT (round 7 enumerated only these
  // two while the same commit was adding the third, below):
  //   - poll site: `runJobPollLoop` is started from exactly one place, under
  //     `!JOB_TERMINAL.has(snap.status)`, and `'failed'` is in `JOB_TERMINAL` —
  //     so a job that reaches a poll loop is one the `!== 'failed'` add already
  //     put in the set. Membership there is always `true`.
  //   - submit-reply site: membership is `true` exactly when
  //     `snap.status !== 'failed'`, and `isSpendLimitRefusal`'s own second clause
  //     returns `false` on that same condition. The read is REDUNDANT with the
  //     predicate, not wrong.
  //   - submit-THROW site (the third, added in round 7): membership is always
  //     `false`, and since round 9 it is no longer the whole answer there — a
  //     thrown submit is `accepted` regardless, because a throw cannot establish
  //     that the job never started (see the 🔴 in `handleGenerate`'s catch). The
  //     `add` above sits on the line after `await submit()`, so a throw never
  //     reaches it, and `localId` is minted fresh per click.
  // What IS pinned is the add condition at the submit reply: inverting it marks
  // genuine refusals as accepted, and the lifecycle clause then swallows every
  // real shortfall.
  //
  // 🔴 THE NUMBER, AND THE TREE IT WAS MEASURED ON — round 8 shipped a figure
  // taken against its own BASE, inside the commit that changed the answer
  // ("10 failed / 178 passed of 188", and 10+178=188 is the PRE-round-8 total).
  // Re-measured for round 9, `cp -a` copy, `.git` removed, per-copy vite
  // `cacheDir`, full suite:
  //   - at 5c9c738 (round 8's own tree): 11 failed / 181 passed of 192 — so the
  //     figure round 8 shipped was already one kill and four tests stale on the
  //     day it landed.
  //   - at THIS tree (round 9, the one this comment ships on): 13 failed / 182
  //     passed of 195. The two extra kills are this round's own R9 F1 pair.
  // Re-measure before you quote it; the count moves with every test added.
  //
  // So the set's value is the single DERIVATION, not the
  // reads: it is what keeps the poll site correct if a second caller of
  // `runJobPollLoop` ever appears for a job the host did not accept, and what
  // keeps the invariant checkable instead of restated as a literal at each read.
  //
  // Entries are never removed — neither `dismissJob` nor the `MAX_RESULTS` FIFO
  // eviction clears one. That is deliberate: a poll loop can outlive its card
  // (eviction does not cancel it), and dropping an entry a live loop still reads
  // would flip its verdict from "accepted, so not a money problem" to arithmetic
  // over a post-debit balance — round 6's F1, reintroduced. The cost of keeping
  // them is one ~25-byte string per generation for the life of the mount.
  const jobAcceptedRef = useRef<Set<string>>(new Set());
  // Tier-4 Delta A: rootRef is the outer (unpadded) measurement element
  // for useBlockResize. The SDK hook reads `ResizeObserverEntry.contentRect.height`
  // which is the CONTENT-box of the observed element — so any padding on
  // rootRef gets silently shaved off the reported height (~32px short →
  // iframe clips the bottom). Fix: keep rootRef padding-free; put the
  // visible padding on `innerRef`'s container. The outer's content-box
  // now equals the inner's full layout box.
  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const [prompt, setPrompt] = useState('');
  // User-edited overrides to the selected showcase's params. See type
  // doc above. Cleared on showcase swap.
  const [overrides, setOverrides] = useState<ParamOverrides>({});
  // Advanced section open/closed. Persists for the session via useState
  // (not localStorage — open/closed state is too noisy to round-trip).
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // One-shot randomize-seed flag. Consumed by the next submit() call,
  // then auto-reset. Picking a new showcase also resets it (selecting an
  // image is a "use this seed" signal — see Gap 2 design notes).
  const [randomizeSeedOnce, setRandomizeSeedOnce] = useState(false);
  // Tier-3 #11: track which showcase the user last submitted Generate for.
  // The 2nd+ Generate click on the same showcase auto-randomizes the seed
  // (so "Re-generate" means "give me a different roll, same showcase").
  // Cleared when the user switches showcases (a new image is a "use its
  // seed" signal — same as the existing reset effect on selection change).
  const [lastSubmittedShowcaseIdx, setLastSubmittedShowcaseIdx] = useState<number | null>(null);
  // Mirror the host-supplied checkpoint locally so the UI updates the
  // instant the user picks a new one. The host re-resolves at submit
  // time anyway — this is just for the label-in-the-header.
  const [localCheckpoint, setLocalCheckpoint] = useState<BlockCheckpointInfo | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  // The client-side generation queue. Submitting appends a job; each job
  // drives its own poll loop to a terminal status (see handleGenerate).
  // Newest jobs go to the FRONT so the carousel reads newest-first, same
  // as pastResults did. Capped at MAX_RESULTS with FIFO eviction.
  const [queue, setQueue] = useState<QueueJob[]>([]);
  // Map of localId → cancel flag for each running poll loop, so unmount
  // (or eviction) tears the loops down cleanly.
  const pollCancelRef = useRef<Map<string, { cancelled: boolean }>>(new Map());

  // Selected showcase image index. Drives the prompt + gen params for
  // submit/estimate. Defaults to 0 in the carousel-mount effect below
  // (deferred because BlockInit might land before showcaseImages does).
  const [selectedShowcaseIdx, setSelectedShowcaseIdx] = useState<number | null>(null);
  // Refs to the carousel scroll container + each thumb button so we can
  // auto-scroll the selected thumb into view on mount/restore. JSDOM
  // doesn't implement scrollIntoView — see effect below for the guard.
  const carouselRef = useRef<HTMLDivElement>(null);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Results-carousel scroll container ref so a fresh Generate click can
  // pull the newest (leftmost) card into view, even if the user had
  // scrolled right to compare older results.
  const resultsCarouselRef = useRef<HTMLDivElement>(null);
  // Debug / test affordance: when checked, the next Generate click
  // short-circuits before submit() and triggers the in-block "Not
  // enough Buzz" top-up CTA so the full top-up flow can be exercised
  // without actually exhausting a balance. Cleared by toggling off.
  const [forceZeroBuzz, setForceZeroBuzz] = useState(false);
  const [simulatedInsufficient, setSimulatedInsufficient] = useState(false);
  // 🔴 THE STORED MONEY VERDICT — see `isSpendLimitRefusal`. Written ONCE per
  // decision, at the instant an estimate or a workflow settles, from the
  // snapshot and the balance as they were AT THAT INSTANT. It is deliberately
  // NOT re-derived on every render.
  //
  // Round 6's F2: the CTA used to recompute the classification live over the
  // hook's shared `result` while each job card had already frozen its own copy
  // at write time. Two consumers, one rule, evaluated at different times — so a
  // balance that moved between them (a refetch settling, a refetch flipping
  // `loading`, a refetch failing) made them disagree on screen about the SAME
  // snapshot. Storing the verdict removes the disagreement by construction.
  //
  // Semantics: this describes the MOST RECENT decision, exactly as the hook's
  // shared `result` did. With several jobs in flight it therefore describes
  // whichever DECIDED last, which is the same residual the shared `result` had
  // and is why every job card carries its own copy too.
  //
  // 🔴 A "DECISION" IS EXACTLY FOUR WRITE SITES, and this comment used to say
  // "another job settling replaces it", which is wider than the code: the
  // estimate settle (resolved → clears, rejected → classifies the thrown
  // snapshot), the submit reply, a submit throw THAT CARRIES A SNAPSHOT, and the
  // poll loop's terminal branch. `cancelJob` is NOT one of them, though it is a
  // terminal transition and does fire the balance refetch. So a `canceled`
  // status the SERVER reports arrives through the poll loop and clears the
  // verdict, while a `canceled` the USER presses leaves it standing until the
  // next of the four. That asymmetry is intentional — a user cancel is not new
  // information about affordability — but it is not "any job settling".
  // Symmetrically, a snapshot-less submit throw (a transport timeout) is
  // deliberately NOT a decision; see the catch in `handleGenerate`.
  //
  // 🔴 IT IS KEYED TO ITS SUBJECT, NOT A BARE BOOLEAN — round 9's F1. Round 8
  // made a snapshot-less rejection stop CLEARING the verdict, which is right for
  // the direction it named and created the mirror defect: a bare boolean
  // outlives the quote it was about, so a verdict about 42 stood over a
  // configuration the viewer had since made affordable, with no Generate button.
  // This holds the KEY of the configuration that was refused, or `null` for
  // "nothing is refused"; `spendLimited` (derived beside `spendSubjectKey`) is
  // true only while that key still describes what is on screen. A transport
  // error carries no information and still moves nothing; a params change does,
  // and retires it — no new rule about WHEN a write may fire.
  const [spendLimitedForKey, setSpendLimitedForKey] = useState<string | null>(null);
  // Estimated cost (yellow buzz) for the current params. Pulled from
  // estimate() snapshot, refreshed on mount + when the model identity
  // (checkpoint or selected showcase) changes.
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const estimateInFlightRef = useRef(0);
  // Skip the override-driven debounced re-estimate on first mount — the
  // immediate identity effect already covers the initial cost quote.
  const overrideEstimateMountedRef = useRef(false);

  // Lightbox: clicking a result image opens it full-size in an in-block
  // overlay. Can't defer to a host "open image viewer" message (none
  // exists in the SDK) or window.open (manifest sandbox is
  // allow-scripts allow-forms — no popups), so the viewer lives inside
  // the iframe. `null` = closed.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Patch one queue job by localId. Used by the per-job poll loops and the
  // submit path to advance a single job without touching its siblings.
  const patchJob = useCallback((localId: string, patch: Partial<QueueJob>) => {
    setQueue((prev) =>
      prev.map((j) => (j.localId === localId ? { ...j, ...patch } : j))
    );
  }, []);

  // Cancel an in-flight job. This is now a REAL server-side cancel: the SDK's
  // `cancel(workflowId)` round-trips through the host to blocks.cancelWorkflow,
  // which cancels the workflow on the orchestrator with the viewer's token
  // (ownership is enforced server-side). So the workflow actually STOPS — it
  // won't keep spending the user's Buzz. We still do the client-side poll-loop
  // stop + status patch immediately so the card clears instantly regardless of
  // the server round-trip (the cancel itself is best-effort: a workflow that
  // already finished will reject, which is fine — the card is cleared anyway).
  const cancelJob = useCallback(
    (localId: string, workflowId: string | null) => {
      // (1) Stop the poll loop. The token may be missing — a remount clears
      // pollCancelRef while the loop's closure keeps running, or the job is
      // still 'submitting' and never started a loop. Guard the lookup and set
      // cancelled only when present; the status patch below clears the card
      // regardless.
      const token = pollCancelRef.current.get(localId);
      if (token) token.cancelled = true;
      // (2) Real server-side cancel — only possible once the workflowId has
      // hydrated from submit(). If it hasn't yet (job still 'submitting'), the
      // poll-loop stop + status patch are enough; there's no orchestrator
      // workflow to cancel yet. Fire-and-forget: best-effort, never blocks the
      // UI clear, swallows rejections (e.g. already-terminal workflow).
      if (workflowId) {
        cancel(workflowId).catch(() => undefined);
      }
      // (3) Mark terminal so the card renders as a "Canceled" slot (falls
      // into JOB_TERMINAL). Always patch — even when the token was missing.
      patchJob(localId, { status: 'canceled' });
      // (4) 🔴 REFRESH THE BALANCE HERE TOO. Step (1) kills the poll token, so
      // the poll loop's terminal branch — the only other place this fires —
      // never runs for a cancelled job. Round 5 claimed a refetch happens on
      // "every terminal workflow"; it did not happen on the one terminal
      // transition the USER causes. A cancel can still have spent Buzz (the
      // submit already committed the reservation; the orchestrator cancel is
      // best-effort and races a workflow that may already have charged), so the
      // figure the next decision is priced against must be re-read.
      refetchBalanceRef.current();
    },
    [patchJob, cancel]
  );

  // Remove a terminal card from the queue entirely (the small X on
  // succeeded / failed / canceled slots). Lets the user clear finished
  // cards without waiting for FIFO eviction. Defensive: also cancels any
  // lingering poll token so a mid-flight dismiss can't leave a loop running.
  const dismissJob = useCallback((localId: string) => {
    const token = pollCancelRef.current.get(localId);
    if (token) token.cancelled = true;
    setQueue((prev) => prev.filter((j) => j.localId !== localId));
  }, []);

  // Drive one workflow to a terminal status with its own adaptive-backoff
  // poll loop. `submit()` does NOT auto-poll (SDK gotcha #10) — the caller
  // owns the loop. Each job runs this independently so multiple in-flight
  // generations poll concurrently, exactly like the on-site generator's
  // queue. Reads the snapshot RETURNED by poll() (isolated per call), not
  // the hook's shared `result`/`status`, so concurrent jobs never clobber
  // each other.
  const runJobPollLoop = useCallback(
    (localId: string, workflowId: string) => {
      const token = { cancelled: false };
      pollCancelRef.current.set(localId, token);

      // Cached Flux returns in <10s; cold paths take 30-60s. Fast initial
      // polls catch the cached case, then back off.
      const SCHEDULE_MS = [2000, 2000, 3000, 5000, 8000];
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const tick = async () => {
        if (token.cancelled) return;
        // Don't burn poll budget while the tab is hidden — the
        // visibilitychange listener re-arms when the user comes back.
        if (typeof document !== 'undefined' && document.hidden) {
          timer = null;
          return;
        }
        try {
          const snap = await pollRef.current(workflowId);
          if (token.cancelled) return;
          // 🔴 CLASSIFY ONCE, HERE, and hand the ANSWER to both consumers —
          // the card's copy below and the stored verdict the money CTA reads.
          // Neither re-derives it later, so a balance that moves afterwards
          // (this loop's own `refetchBalanceRef` call, for one) cannot
          // re-classify a decision that has already been made.
          const refused = isSpendLimitRefusal(snap, spendRef.current, {
            accepted: jobAcceptedRef.current.has(localId),
          });
          patchJob(localId, {
            status: snap.status as QueueJobStatus,
            cost: snap.cost?.total ?? null,
            imageUrls: snap.imageUrls ?? [],
            // 🔴 LOG IT. The SDK's rule is "log it, show it in a developer
            // surface, never render it verbatim" — and after the render fix
            // this text was reaching NEITHER. The throwing paths log; the
            // resolved path (the common one) did not, so for most failures
            // nobody — user or developer — could find out what happened.
            //
            // 🔴 `status === 'failed'` is part of the condition, not just
            // `snap.error`. Gating on the server's text alone meant a priced
            // `failed` reply that carried no `error` string produced the money
            // CTA above and a SILENT job card — the two consumers of the one
            // predicate visibly disagreeing, which is exactly what the
            // predicate exists to prevent.
            ...(snap.error || snap.status === 'failed'
              ? { error: logAndMapFailure(snap, 'poll', refused, { workflowId }) }
              : {}),
          });
          if (JOB_TERMINAL.has(snap.status as QueueJobStatus)) {
            // Publish the verdict computed ABOVE — before the refetch below can
            // move the balance. For an accepted job `refused` is always false
            // (the lifecycle clause), so in practice this CLEARS a stale
            // verdict left by an earlier decision rather than setting one.
            //
            // 🔴 THE KEY IT WOULD STAMP IS THE CURRENT ONE, NOT THE ONE THIS
            // JOB WAS SUBMITTED UNDER, and that is only harmless because
            // `refused` is structurally `false` here — the clearing branch
            // ignores the key entirely. If a poll loop is ever started for a
            // job the host did NOT accept, this site has to carry the
            // submitted-under key down from `handleGenerate` instead.
            setSpendLimitedForKey(refused ? spendKeyRef.current : null);
            // The workflow settled, so any debit has landed. Re-read the
            // balance now so the NEXT decision is priced against the wallet
            // that exists after this job, not before it.
            //
            // 🔴 It can no longer re-classify THIS job: the verdict above is
            // stored, not re-derived. That re-derivation was round 6's F1 — the
            // post-debit figure this very call fetches was being compared
            // against the price of the job that had just been charged, turning
            // "your generation failed" into "you hit a Buzz spend limit" for
            // money that was already gone.
            refetchBalanceRef.current();
            cleanup();
            return;
          }
        } catch {
          // Transient host/orchestrator hiccup during polling — keep going.
          // A real terminal failure surfaces as a 'failed'/'expired'
          // snapshot above, not a thrown poll error.
        }
        if (token.cancelled) return;
        const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(tick, delay);
      };

      const onVisibility = () => {
        if (token.cancelled || document.hidden) return;
        if (timer == null) timer = setTimeout(tick, 0);
      };

      const cleanup = () => {
        token.cancelled = true;
        if (timer != null) {
          clearTimeout(timer);
          timer = null;
        }
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility);
        }
        pollCancelRef.current.delete(localId);
      };

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
      // Leading edge — fire immediately so an already-cached workflow gets
      // its result on the next microtask.
      timer = setTimeout(tick, 0);
    },
    [patchJob]
  );

  // Tear every running poll loop down on unmount.
  useEffect(() => {
    const loops = pollCancelRef.current;
    return () => {
      loops.forEach((token) => {
        token.cancelled = true;
      });
      loops.clear();
    };
  }, []);

  // Derive showcase/checkpoint via a partial cast so we can run the
  // mount-defaults + auto-estimate effects unconditionally above the
  // early returns. Effects can't sit below them or React will complain
  // about hook order on the !ready re-render.
  const modelCtxRead = context as Partial<ModelSlotContext>;
  const showcaseImages: ShowcaseImage[] = modelCtxRead.showcaseImages ?? [];
  const selectedShowcase =
    selectedShowcaseIdx != null ? showcaseImages[selectedShowcaseIdx] ?? null : null;
  // CSS aspect-ratio string for the in-flight LoadingCard, derived from the
  // selected showcase so the placeholder roughly matches the shape of the
  // image the user is about to get. Falls back to square.
  const selectedAspectRatio =
    selectedShowcase && selectedShowcase.width && selectedShowcase.height
      ? `${selectedShowcase.width} / ${selectedShowcase.height}`
      : '1 / 1';
  const effectiveCheckpointVersionIdForEstimate =
    (localCheckpoint ?? modelCtxRead.checkpoint ?? null)?.versionId ?? null;

  // 🔴 THE MONEY VERDICT'S SUBJECT — the cost-bearing configuration a quote is
  // priced against. See `spendLimitedForKey`.
  //
  // 🔴 IT IS A SUBSET OF THE TWO ESTIMATE EFFECTS' DEPS BY CONSTRUCTION, and
  // that is the whole safety argument: every field here also fires a re-quote
  // (identity effect → model/checkpoint/showcase; debounced effect →
  // width/height/steps). So a key change can never leave the block with a
  // retired verdict and nothing scheduled to replace it — the quote that
  // retires it is already in flight. If you add a field, add it to an estimate
  // effect's deps in the same edit, or you have built the wipe back.
  //
  // 🔴 WHAT IS DELIBERATELY OUT, AND THE TRADE, IN BOTH DIRECTIONS. The seed
  // decision (`randomizeSeedOnce` / `isRegenerate`) prices too — a randomized
  // seed is a fresh job at full cost, the showcase's cached seed whatifs to 0 —
  // and it is still not a subject change, for two independent reasons. It only
  // ever moves the price UP, so it cannot turn a refused configuration into an
  // affordable one; and `isRegenerate` flips on EVERY submit, so keying on it
  // would retire the verdict at the exact instant the submit reply set it —
  // round 8's F1 (a live, correct verdict wiped by an event that decided
  // nothing) rebuilt out of the fix for its mirror. The prompt is out for the
  // simpler reason that it does not price and does not re-quote.
  //
  // The cost of retiring, named: a viewer whose NEW configuration is also
  // unaffordable loses the top-up CTA until the re-quote lands, and keeps
  // losing it for as long as the bridge stays down. That is the cheap side of
  // `isSpendLimitRefusal`'s own 🔴 rule — a wrong `false` is an unhelpful
  // message, a wrong `true` charges someone for a problem money cannot solve —
  // and the lockout this replaces was on the expensive side of it.
  const spendSubjectKey = JSON.stringify([
    modelCtxRead.modelId ?? null,
    modelCtxRead.modelVersionId ?? null,
    effectiveCheckpointVersionIdForEstimate,
    selectedShowcaseIdx,
    overrides.width ?? null,
    overrides.height ?? null,
    overrides.steps ?? null,
  ]);
  spendKeyRef.current = spendSubjectKey;
  // 🔴 NOT A RE-DERIVATION OF THE VERDICT — an APPLICABILITY test on the one
  // that was stored. Nothing here reads the balance or a snapshot, so round 6's
  // F1 (the CTA re-classifying a decided failure against a balance that moved
  // underneath it) cannot come back through this line. Do not add either.
  const spendLimited = spendLimitedForKey !== null && spendLimitedForKey === spendSubjectKey;

  // Storage key for showcase-selection persistence. Scoped to the block
  // instance + model version so two different models on a multi-model
  // page don't collide. See Gap 4 in the day-2 handoff.
  const storageKey =
    blockInstanceId && modelCtxRead.modelVersionId
      ? `civitai-block-generate:${blockInstanceId}:${modelCtxRead.modelVersionId}`
      : null;

  // Default-select either (a) the persisted showcase image from
  // localStorage, falling back to (b) the first available image, once
  // the host's query lands. showcaseImages may be empty on first render
  // and populate later when BLOCK_INIT delivers them.
  useEffect(() => {
    if (selectedShowcaseIdx != null) return;
    if (showcaseImages.length === 0) return;
    const persistedId = readPersistedShowcaseId(storageKey);
    const persistedIdx =
      persistedId != null ? showcaseImages.findIndex((img) => img.id === persistedId) : -1;
    setSelectedShowcaseIdx(persistedIdx >= 0 ? persistedIdx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showcaseImages.length, storageKey]);

  // Persist the selected showcase ID to localStorage on every change.
  // Survives hard refresh; keyed on (blockInstanceId, modelVersionId) so
  // it's isolated per-block-per-model. Errors are swallowed (private
  // mode, quota exceeded, etc.).
  useEffect(() => {
    if (storageKey == null) return;
    if (selectedShowcaseIdx == null) return;
    const img = showcaseImages[selectedShowcaseIdx];
    if (!img) return;
    writePersistedShowcaseId(storageKey, img.id);
  }, [storageKey, selectedShowcaseIdx, showcaseImages]);

  // Auto-scroll the selected thumb into view when selection changes (covers
  // both initial-default and localStorage-restored selections). JSDOM
  // doesn't implement scrollIntoView — wrap in try/catch so tests don't
  // explode. Behavior:'smooth' respects prefers-reduced-motion in browsers.
  useEffect(() => {
    if (selectedShowcaseIdx == null) return;
    const el = thumbRefs.current[selectedShowcaseIdx];
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    } catch {
      // JSDOM / older browsers — affordance is non-load-bearing.
    }
  }, [selectedShowcaseIdx]);

  // Populate the prompt input from the selected showcase image's meta
  // and clear any user-edited overrides — selecting a new image is an
  // explicit "reset to this image's params" signal. The user can still
  // edit afterward; this only fires on showcase selection change.
  // Empty meta leaves the input alone so a partial-meta showcase
  // doesn't clobber a typed prompt.
  useEffect(() => {
    if (selectedShowcase?.prompt) {
      setPrompt(selectedShowcase.prompt);
    }
    setOverrides({});
    setRandomizeSeedOnce(false);
    // Tier-3 #11b: switching showcases resets the re-generate counter so
    // the FIRST submit for the new showcase uses its own seed (not a
    // random one). The 2nd submit then flips to random.
    setLastSubmittedShowcaseIdx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShowcaseIdx]);

  // Tier-4 Delta B (revised 2026-05-26): pastResults persist across
  // showcase swaps. The gallery is the user's session-long exploration
  // record — picking a different starter image just changes WHAT the
  // next generation looks like; it shouldn't erase what they've already
  // made. Only path that clears pastResults today is component unmount.

  // "Re-generate" detection. If the user already submitted THIS showcase
  // (without switching since), the next Generate randomizes the seed (a fresh
  // roll) — see handleGenerate. A randomized seed is a FRESH orchestrator job
  // (full cost); the showcase's cached seed whatifs to 0 (a cache hit). So the
  // cost ESTIMATE and the SUBMIT MUST share this exact decision, or the quoted
  // CTA cost won't match what submit charges (the recurring "estimate shows 0
  // but the 2nd gen charges Buzz" bug — the estimate was hardcoded to the
  // cached seed). Defined here (above runEstimateNow) so both the estimate and
  // its effect deps can read it.
  const isRegenerate =
    selectedShowcaseIdx != null && lastSubmittedShowcaseIdx === selectedShowcaseIdx;

  // Fire a single cost estimate against the current resolved params.
  // Recreated every render so it always closes over the latest prompt /
  // showcase / overrides; the effects below decide WHEN to call it.
  //
  // Skipped when `forceZeroBuzz` is checked — we're pretending to have
  // no buzz, so there's no point asking the orchestrator for a cost
  // estimate (and the user expects the topup CTA to show directly,
  // not a separate "Couldn't estimate cost: …" estimate error).
  // `forceRandomizeSeed` overrides the seed-randomization decision for this
  // one quote. handleGenerate passes `true` for its post-submit re-quote: the
  // just-submitted showcase is now a re-gen, so the NEXT gen will randomize —
  // but isRegenerate only flips on the following render, so the closure here is
  // still stale. Effect/timer callers pass nothing → fall back to the live
  // `randomizeSeedOnce || isRegenerate`.
  const runEstimateNow = (forceRandomizeSeed?: boolean) => {
    if (forceZeroBuzz) return;
    // 🔴 STAMP THE SUBJECT AT KICKOFF, NOT AT SETTLE. This quote is about the
    // configuration being sent NOW; by the time it settles the viewer may have
    // edited another field, and the 400ms debounce means the next quote has not
    // started yet, so `spendKeyRef.current` would name a configuration this
    // answer was never about.
    const quoteSubjectKey = spendSubjectKey;
    // Anon viewers carry no budget scope — an estimate would error. Skip it;
    // the CTA shows "Sign in to generate" rather than a cost for anon.
    if (!viewer) return;
    const modelId = modelCtxRead.modelId;
    const modelVersionId = modelCtxRead.modelVersionId;
    if (!modelId || !modelVersionId) return;
    if (!effectiveCheckpointVersionIdForEstimate) return;
    const randomizeSeed = forceRandomizeSeed ?? (randomizeSeedOnce || isRegenerate);
    // Race guard — if a faster query lands while a slower one is in
    // flight (or a debounced one fires late), only the latest result wins.
    const myId = ++estimateInFlightRef.current;
    // Diagnostic: log estimate kick-off so a future ESTIMATE_WORKFLOW
    // timeout can be correlated with the iframe → host bridge state
    // (parentOrigin, BLOCK_INIT timing, etc.) in the browser console.
    // eslint-disable-next-line no-console
    console.debug('[gfm] estimate kickoff', { modelId, modelVersionId, attempt: myId });
    estimate({
      kind: 'textToImage',
      modelId,
      modelVersionId,
      // Mirror submit's seed-randomization decision EXACTLY (randomizeSeedOnce
      // || isRegenerate — same expression handleGenerate uses) so the quoted
      // cost matches what submit will charge. A randomized seed omits the seed
      // → fresh orchestrator job → full cost; the cached showcase seed → cache
      // hit → 0. Hardcoding `false` here quoted the cache-hit price (0) even
      // when the next submit would randomize (re-gen / 🎲) and charge full
      // price — the "CTA shows 0 but the gen charges Buzz" bug.
      params: buildSubmitParams(prompt, '' /* suffix */, selectedShowcase, overrides, randomizeSeed),
    })
      .then((snap) => {
        if (myId !== estimateInFlightRef.current) return;
        // 🔴 A FAILED estimate no longer arrives here. Up to
        // @civitai/blocks-react 0.5.x `estimate()` RESOLVED a failure snapshot
        // and left the hook's `error` null, so this branch handled it. From
        // 0.44.x it THROWS `WorkflowEstimateError` instead, so failures land in
        // `.catch` below and the old `status === 'failed'` arm here was dead
        // code sitting under a comment that said the opposite. Kept as a
        // defensive no-cost guard only.
        const cost = snap.cost?.total;
        // eslint-disable-next-line no-console
        console.debug('[gfm] estimate resolved', { attempt: myId, cost });
        setEstimatedCost(typeof cost === 'number' ? cost : null);
        setEstimateError(null);
        // A price came back, so nothing is currently refused — clear any stored
        // verdict. This is the block's real recovery path out of the top-up CTA
        // (change a param / pick another showcase → re-quote → Generate
        // returns), and it is the same transition that used to happen
        // implicitly when this snapshot overwrote the hook's shared `result`.
        setSpendLimitedForKey(null);
      })
      .catch((err: unknown) => {
        if (myId !== estimateInFlightRef.current) return;
        // 🔴 NEVER render `err.message` or `snapshot.error` to a viewer. The
        // SDK documents both as developer-facing: `message` is a generic
        // summary whose wording is not a contract, and `snapshot.error` is
        // server-authored and UNSANITISED. Branch on `code`, which is the only
        // stable target, and return copy this block owns.
        //
        // This is why it matters: before the 0.44 bump a failed estimate
        // resolved and we rendered the server's reason. After it, rendering
        // `err.message` verbatim would have put
        // "estimate did not return a usable price (failed) — reason on
        // .snapshot.error" in front of a user.
        // 🔴 ONLY A REJECTION THAT CARRIES A SNAPSHOT IS A DECISION — the same
        // rule the submit catch runs on, and this site is why round 8 exists:
        // round 7 closed the shape at the submit catch and left it open here,
        // byte-identical, one site away.
        const estimateSnapshot =
          err instanceof WorkflowEstimateError ? err.snapshot ?? null : null;
        const serverReason = estimateSnapshot?.error;
        // 🔴 THE OTHER NEVER-STARTED ARM. A refused estimate priced nothing and
        // queued nothing, so it is a genuine refusal and a shortfall here IS
        // top-up-fixable — this is the case round 4 was right to stop excluding
        // when it removed a `phase === 'submit'` scope. `estimate()` publishes
        // its snapshot BEFORE it rejects (SDK: "`result` is updated to the
        // returned snapshot BEFORE any rejection"), which is how this used to
        // reach the CTA implicitly; now it is classified explicitly, from the
        // snapshot the rejection carries.
        //
        // 🔴 AND A REJECTION THAT CARRIES NONE LEAVES THE VERDICT STANDING.
        // `estimate()` also rejects at the TRANSPORT — `sendTypedRequest` hitting
        // `WORKFLOW_REQUEST_TIMEOUT_MS`, or a dead bridge — and the SDK's
        // `estimate` catch RETHROWS the raw error, so what lands here is a plain
        // `Error` with no `snapshot`. This used to pass `null` to the predicate,
        // which fails toward NOT-a-shortfall and therefore CLEARED a live,
        // correct verdict that nothing had refuted:
        //
        //   viewer holds 5, quote 42, submit replies a genuine priced refusal →
        //   verdict true, "Top up · 500", the spend-limit copy, no Generate. The
        //   post-submit re-quote at the bottom of `handleGenerate` fires
        //   immediately, the bridge is down, `estimate()` rejects with a plain
        //   `Error` — top-up gone, copy gone, Generate back, while the job card
        //   beside it still reads "This generation hit a Buzz spend limit."
        //
        // A `null` snapshot is not the predicate answering "not a shortfall"; it
        // is the predicate being asked a question with no subject. Don't ask.
        //
        // 🔴 AND ROUND 9's OTHER HALF: leaving it standing is right for a
        // transport error, which carries no information — but it is NOT right
        // once the viewer has changed what they are asking about. That is
        // handled where the verdict is READ (`spendLimited`, keyed to
        // `spendSubjectKey`) rather than by another rule about when this write
        // may fire, so this site keeps exactly the shape round 8 gave it.
        if (estimateSnapshot) {
          setSpendLimitedForKey(
            isSpendLimitRefusal(estimateSnapshot, spendRef.current, {
              accepted: false,
            })
              ? quoteSubjectKey
              : null
          );
        }
        // eslint-disable-next-line no-console
        console.warn('[gfm] estimate rejected', {
          attempt: myId,
          code: err instanceof WorkflowEstimateError ? err.code : undefined,
          // Developer channel only — this is where the server's text belongs.
          serverReason,
          err: String(err),
        });
        // Reason only — the line below renders "Couldn't estimate cost: {this}",
        // so repeating the prefix here produced "Couldn't estimate cost:
        // Couldn't estimate cost." The suite could not see it: the assertion
        // matched the PREFIX, which is satisfied either way.
        setEstimateError(
          err instanceof WorkflowEstimateError && err.code === 'no-cost'
            ? 'no price came back for these settings.'
            : 'the estimate service is unavailable — try again in a moment.'
        );
        setEstimatedCost(null);
      });
  };

  // Immediate estimate on mount + identity changes (checkpoint swap /
  // showcase pick / forceZeroBuzz toggle). Kept synchronous so the cost
  // quote shows on the button without a debounce delay.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(runEstimateNow, [
    modelCtxRead.modelId,
    modelCtxRead.modelVersionId,
    effectiveCheckpointVersionIdForEstimate,
    selectedShowcaseIdx,
    forceZeroBuzz,
    // Re-quote when the seed-randomization decision flips, so the CTA cost
    // tracks what the NEXT submit will charge: isRegenerate flips true after
    // the first submit of a showcase (→ next gen randomizes → full cost, not
    // the cache-hit 0), and randomizeSeedOnce toggles with the 🎲 button.
    isRegenerate,
    randomizeSeedOnce,
  ]);

  // Debounced re-estimate on cost-bearing advanced overrides (width,
  // height, steps — these scale the orchestrator price). 400ms so
  // dragging a dimension or holding a key in the steps field coalesces
  // into one round-trip instead of one per keystroke. Reading the
  // individual fields (not the `overrides` object) keeps no-cost edits
  // (negativePrompt, sampler, cfg, seed, clipSkip) from re-quoting.
  // Skips the first mount — the identity effect above already quoted.
  useEffect(() => {
    if (!overrideEstimateMountedRef.current) {
      overrideEstimateMountedRef.current = true;
      return;
    }
    if (forceZeroBuzz) return;
    const timer = setTimeout(runEstimateNow, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides.width, overrides.height, overrides.steps]);

  // Whether any queued job is still running. Drives the leftmost-scroll
  // affordance and (in render) the carousel mount.
  const anyJobInFlight = queue.some((j) => isJobInFlight(j.status));

  // Pull the results carousel back to its leftmost (newest) position every
  // time the queue gains an in-flight job, so a fresh Generate reveals
  // where the new card lands even if the user scrolled right to inspect
  // older results.
  useEffect(() => {
    if (!anyJobInFlight) return;
    const el = resultsCarouselRef.current;
    if (!el) return;
    try {
      el.scrollTo({ left: 0, behavior: 'smooth' });
    } catch {
      try {
        el.scrollLeft = 0;
      } catch {
        // JSDOM / older browsers — affordance is non-load-bearing.
      }
    }
  }, [anyJobInFlight, queue.length]);

  // NOTE: the queue is driven SOLELY by handleGenerate (which mints an own
  // job and starts its per-job poll loop) — see handleGenerate + runJobPollLoop
  // below. There used to be a "compatibility bridge" useEffect here that
  // mirrored the SDK hook's SHARED `result`/`status` into the queue so a
  // host/test could surface a workflow without going through submit(). It was
  // removed deliberately (2026-06-01): in production the block ALWAYS creates
  // its own jobs via handleGenerate — the host never injects a workflow through
  // the shared hook state — so the bridge's create path was test-only, and its
  // keying off the shared `result`/`status` (which estimate() and poll()
  // interleave writes to) caused three phantom-card bugs. The shared state is
  // now read ONLY for the CTA cost estimate (runEstimateNow / estimatedCost)
  // and the insufficient-Buzz error CTA — never for queue cards.

  if (!ready) {
    // NOT `theme` — pre-BLOCK_INIT that field is the SDK's sentinel, not a
    // signal. See bootThemeGuess().
    const bootTheme = bootThemeGuess();
    return (
      <div ref={rootRef} data-theme={bootTheme} style={outerContainerStyle(bootTheme)}>
        <div style={innerContainerStyle()}>
          <StyleSheet />
          <LoadingSkeleton theme={bootTheme} />
        </div>
      </div>
    );
  }

  const model = asModelContext(context);
  if (!model) {
    return (
      <div ref={rootRef} data-theme={theme === 'dark' ? 'dark' : 'light'} style={outerContainerStyle(theme)}>
        <div style={innerContainerStyle()}>
          <p style={errorTextStyle}>
            This block expects a model-page slot. Current slot: <code>{context.slotId}</code>
          </p>
        </div>
      </div>
    );
  }

  // Anonymous conversion: a logged-out viewer (viewer === null) sees the FULL
  // block — showcase carousel + prompt form are driven by the scope-free
  // BLOCK_INIT context, so nothing here needs auth. The cost estimate is skipped
  // (no budget scope → it would error), and Generate becomes a "Sign in to
  // generate" affordance that posts REQUEST_SIGN_IN to the host instead of
  // submitting a workflow. So we do NOT early-return here — fall through to the
  // main render. The banned/muted gate below only applies to authenticated
  // viewers.
  const isAnon = !viewer;

  if (viewer && (viewer.status === 'banned' || viewer.status === 'muted')) {
    return (
      <div ref={rootRef} data-theme={theme === 'dark' ? 'dark' : 'light'} style={outerContainerStyle(theme)}>
        <div style={innerContainerStyle()}>
          <Header
            theme={theme}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
            isBusy={true}
          />
          <p style={subtleStyle}>
            Account status is <strong>{viewer.status}</strong>. Generation is unavailable.
          </p>
        </div>
      </div>
    );
  }

  const budget = readNumber(settings.publisherSettings.buzz_budget_per_gen, 10);
  const suffix = readString(settings.publisherSettings.default_prompt_suffix, '');
  const showAdvanced = readBoolean(settings.publisherSettings.show_advanced, false);

  // The host computes the effective checkpoint (publisher default ∪ viewer
  // override) before BLOCK_INIT. localCheckpoint shadows it for instant UI
  // updates after a picker swap; falls back to the BLOCK_INIT value at mount.
  const effectiveCheckpoint: BlockCheckpointInfo | null =
    localCheckpoint ?? model.checkpoint ?? null;
  // For Checkpoint-bound installs the picker is suppressed — the model IS
  // the anchor and there's nothing to change. For LoRA installs we always
  // show the [Change] button next to the current checkpoint label.
  const showCheckpointPicker = model.modelType !== 'Checkpoint';

  const handleChangeCheckpoint = async () => {
    setCheckpointError(null);
    // baseModelGroup: the host expands this into the exact baseModel filter.
    // We pass the LoRA's own baseModel; the host collapses to the ecosystem
    // family so Flux.1 D / Flux.1 S etc. all resolve to 'Flux1'.
    const baseModelGroup =
      effectiveCheckpoint?.baseModel ?? model.modelType /* fallback only */;
    try {
      const { selected } = await checkpointPicker.open({
        baseModelGroup,
        ...(effectiveCheckpoint ? { currentVersionId: effectiveCheckpoint.versionId } : {}),
      });
      if (!selected) return; // user dismissed
      // Optimistic: update the label immediately. Then persist server-side.
      setLocalCheckpoint(selected);
      try {
        await checkpointPicker.persist(selected.versionId);
      } catch (err) {
        // Persist failed (e.g. wrong-ecosystem) — surface to user and roll
        // back the optimistic update.
        setLocalCheckpoint(null);
        setCheckpointError(err instanceof Error ? err.message : 'could not save checkpoint');
      }
    } catch (err) {
      setCheckpointError(err instanceof Error ? err.message : 'picker failed');
    }
  };

  // Task 2: the form, thumbs, Generate button, and three-dots NO LONGER
  // disable during generation. The queue (task 3) makes generation
  // non-blocking — the user fires off as many as they like and they run
  // independently — so a blanket "busy → disabled" would defeat the whole
  // point. The only thing the busy state still drives is the estimating
  // copy on the CTA (so the user knows a cost quote is in flight). Per-job
  // progress lives in the results carousel, not on the form.
  const isEstimating = status === 'estimating';

  // `isRegenerate` (Tier-3 #11 re-generate semantics: auto-randomize the seed
  // when the user re-Generates the same showcase) is defined above runEstimateNow
  // so the cost estimate can mirror this submit's seed decision.

  const handleGenerate = async () => {
    // Anonymous conversion: a logged-out viewer who clicks Generate is prompted
    // to sign in (the host opens civitai's login flow) instead of submitting a
    // workflow. No estimate/submit happens — Generate stays server-gated anyway
    // (the anon token carries no budget scope), so converting the click into a
    // sign-in prompt is both the UX and the only path that can actually generate.
    if (!viewer) {
      postRequestSignIn();
      return;
    }
    // Debug short-circuit: when "Simulate 0 Buzz" is checked, skip the
    // real submit and synthesize the insufficient-Buzz state. The
    // existing error block renders the top-up CTA, which still opens
    // the real purchase modal — full top-up flow exercised, no spend.
    if (forceZeroBuzz) {
      setSimulatedInsufficient(true);
      return;
    }
    // The subject any verdict this click produces is ABOUT — captured before
    // the awaits, so it names the configuration actually submitted rather than
    // whatever is on screen when the reply lands. Same rule as the estimate's
    // kickoff stamp.
    const submitSubjectKey = spendSubjectKey;
    // Either the user pressed 🎲 (manual), or this is a re-gen on the
    // same showcase (auto). Both paths drop the seed for this submit.
    const randomizeForThisSubmit = randomizeSeedOnce || isRegenerate;
    const params = buildSubmitParams(
      prompt,
      suffix,
      selectedShowcase,
      overrides,
      randomizeForThisSubmit
    );
    // Reset the one-shot randomize flag after consuming it so the *next*
    // submit reverts to the showcase's seed (unless the user clicks 🎲
    // again). Mark THIS showcase as submitted so the next click flips to
    // re-generate (random seed).
    if (randomizeSeedOnce) setRandomizeSeedOnce(false);
    if (selectedShowcaseIdx != null) {
      setLastSubmittedShowcaseIdx(selectedShowcaseIdx);
    }

    // Enqueue the job immediately (newest at front) so the carousel shows
    // a "submitting" loading card the instant the user clicks — no waiting
    // on the submit round-trip. Snapshot the cost from the live estimate.
    const localId = nextLocalId();
    setQueue((prev) =>
      [
        {
          localId,
          workflowId: null,
          status: 'submitting' as QueueJobStatus,
          cost: estimatedCost,
          imageUrls: [],
          aspectRatio: selectedAspectRatio,
        },
        ...prev,
      ].slice(0, MAX_RESULTS)
    );

    try {
      const snap = await submit({
        kind: 'textToImage',
        modelId: model.modelId,
        modelVersionId: model.modelVersionId,
        // Use the same param-builder as the estimate effect so cost shown
        // pre-click matches cost charged at submit. The host still
        // re-validates everything server-side; this is just for parity.
        params,
      });
      // 🔴 RECORD THE LIFECYCLE FACT FIRST — this is the ONLY site that writes
      // it. Any non-`failed` reply means the host took the workflow, and the
      // SDK is explicit that a resolved submit is money-COMMITTED. From here on
      // no failure this job reports can be an affordability refusal: it was
      // funded. A `failed` reply is the opposite — never queued, no money moved
      // — and is the arm where a refusal is possible at all.
      if (snap.status !== 'failed') jobAcceptedRef.current.add(localId);
      // Classify ONCE, from the snapshot and the balance as of this instant.
      const refused = isSpendLimitRefusal(snap, spendRef.current, {
        accepted: jobAcceptedRef.current.has(localId),
      });
      setSpendLimitedForKey(refused ? submitSubjectKey : null);
      // Hydrate the job with the returned workflowId + initial snapshot.
      patchJob(localId, {
        workflowId: snap.workflowId,
        status: snap.status as QueueJobStatus,
        cost: snap.cost?.total ?? estimatedCost,
        imageUrls: snap.imageUrls ?? [],
        // Same widened condition as the poll site — see the note there.
        ...(snap.error || snap.status === 'failed'
          ? {
              error: logAndMapFailure(snap, 'submit', refused, {
                workflowId: snap.workflowId,
              }),
            }
          : {}),
      });
      // submit() does NOT auto-poll (SDK gotcha #10) — start this job's
      // own poll loop unless it already came back terminal (cached hit).
      if (!JOB_TERMINAL.has(snap.status as QueueJobStatus) && snap.workflowId) {
        runJobPollLoop(localId, snap.workflowId);
      } else {
        // Terminal on the submit reply (cached hit, or a refusal): the balance
        // may have moved and no poll loop will fire the refetch below.
        refetchBalanceRef.current();
      }
      // Re-quote after the submit. The orchestrator prices dynamically — the
      // SAME params can cost differently between generations — so without
      // this the CTA stays frozen on the mount/param-change estimate and
      // never reflects what the NEXT Generate click will actually cost.
      // Force randomizeSeed=true: the just-submitted showcase is now a re-gen,
      // so the next gen WILL randomize the seed (fresh job → full cost, not the
      // cache-hit 0). isRegenerate only flips on the next render, so this
      // closure is still stale — pass the decision explicitly. The race guard
      // keeps the newest result if the user also edits a cost-bearing field.
      runEstimateNow(true);
    } catch (err) {
      // Mark this job failed; the rest of the queue is unaffected. The
      // insufficient-Buzz CTA path keys off the shared `error` separately.
      //
      // 🔴 Same rule as the estimate catch: `err.message` and `snapshot.error`
      // are developer-facing, and from blocks-react 0.44 `submit()` THROWS
      // rather than resolving a failed snapshot — so the card was about to
      // start showing "submit did not return a usable workflow
      // (workflow-failed) — reason on .snapshot.error" to a user. Branch on
      // `code`; the server's text goes to the console only.
      // 🔴 ONLY A THROW THAT CARRIES A SNAPSHOT MAY MOVE THE VERDICT, and it
      // moves it by CLASSIFYING that snapshot — never by asserting an answer.
      //
      // This used to be an unconditional `setSpendLimited(false)`, justified
      // from `WorkflowSubmitError`: "A BUDGET REJECTION NEVER ARRIVES HERE. It
      // resolves, and is read off the returned snapshot as `status === 'failed'`
      // with a numeric `cost.total`" — and both thrown codes carry an UNPRICED
      // snapshot, which the predicate rejects anyway. All true, and all about
      // the two codes. THE CATCH IS NOT SCOPED TO THEM. `submit()` also rejects
      // at the TRANSPORT — `sendTypedRequest` hitting `WORKFLOW_REQUEST_TIMEOUT_MS`,
      // or a dead bridge — and that path never reaches the hook's
      // `setResult(snapshot)`. No snapshot is published and none is thrown, so
      // the stored verdict is the ONLY information the app holds about the
      // money, and clearing it destroyed a live, correct answer:
      //
      //   viewer holds 5, a priced `failed` estimate at 42 stores the verdict →
      //   "Top up · 500", the spend-limit copy, no Generate button. The CTA is
      //   not a gate: `PromptTextarea` is mounted `disabled={false}`, so
      //   Ctrl/Cmd+Enter reaches this handler anyway. `submit()` rejects at the
      //   transport, this line fires — top-up gone, copy gone, Generate back,
      //   card reading "Couldn't submit this generation." The viewer is still
      //   37 Buzz short with no top-up affordance, and Generate fails again.
      //
      // A snapshot-less throw settled nothing and priced nothing, so it carries
      // no decision: leave the last one standing. A throw that DOES carry a
      // snapshot is a decision, and the one predicate makes it — for the same
      // reason the resolved path does, so a change in what the SDK throws
      // cannot silently turn into a wrong hardcoded answer here.
      //
      // ⚠️ ROUND 8 PINNED THIS SITE WITH A GUARD THAT ASSERTED THE WRONG
      // ANSWER, AND ROUND 9 INVERTED BOTH. Round 8's `R8 F2` fabricated a
      // PRICED `workflow-failed` throw and asserted the viewer must get "Top up"
      // + the spend-limit copy. The SDK forbids exactly that: "🔴 DO NOT TELL
      // THE VIEWER NOTHING WAS CHARGED… treats *any resolved* submit as
      // money-COMMITTED… So Buzz may already be spent for this call." Selling
      // Buzz for money that is already gone is round 6's F1 — re-created inside
      // the guard written to prevent its cousin.
      //
      // 🔴 THE FIX IS THE LIFECYCLE INPUT, NOT THE COPY: A THROWN SUBMIT'S
      // LIFECYCLE IS UNOBSERVABLE, AND UNOBSERVABLE IS NOT NEVER-STARTED. One
      // rule for both codes, because the SDK refuses to let money be reasoned
      // about per-code: `'workflow-failed'` is money-COMMITTED as quoted above,
      // and `'exception'` "means the host had no workflow to report — NOT that
      // nothing happened", reachable via a lost response, an in-progress
      // idempotency conflict, or a transient 5xx, on each of which "a workflow
      // MAY have been created and charged". `isSpendLimitRefusal`'s first clause
      // is about a job that NEVER STARTED; a throw cannot establish that, and
      // its own 🔴 FAIL TOWARD NOT-A-SHORTFALL rule says an unknown resolves
      // away from the CTA. So `accepted` is `true` for any `WorkflowSubmitError`.
      //
      // 🔴 SAY WHAT THAT COSTS. A snapshot only ever reaches the predicate from
      // a `WorkflowSubmitError`, so this makes `refused` structurally `false` at
      // this site and a literal `false` would now behave identically — the
      // mutation round 8 killed here is alive again, by design rather than by
      // omission. What replaces the pin is the INVERTED `R8 F2`, which asserts
      // the SDK-correct screen for the same priced fixture (no Top-up, the
      // `workflow-failed` sentence); and the predicate call stays so that a
      // future SDK shape whose lifecycle IS observable flows through the one
      // rule instead of past a hardcoded answer.
      const thrownSnapshot =
        err instanceof WorkflowSubmitError ? err.snapshot ?? null : null;
      // 🔴 ONE CALL, BOTH CONSUMERS — the property the other three sites have
      // structurally, and this one had only by convention until round 8. The
      // verdict below and the card copy at the bottom of this block are now
      // written from THIS boolean, so they cannot classify one snapshot
      // differently. A snapshot-less throw decided nothing, so `refused` is
      // `false` and neither consumer moves.
      const refused =
        thrownSnapshot != null &&
        isSpendLimitRefusal(thrownSnapshot, spendRef.current, {
          // See the 🔴 above: a throw cannot establish that the job never
          // started, and `jobAcceptedRef` can only under-report it (its one
          // write site sits after the `await`, so a throw never reaches it).
          accepted: jobAcceptedRef.current.has(localId) || err instanceof WorkflowSubmitError,
        });
      if (thrownSnapshot) setSpendLimitedForKey(refused ? submitSubjectKey : null);
      const submitReason = thrownSnapshot?.error;
      // eslint-disable-next-line no-console
      console.warn('[gfm] submit rejected', {
        localId,
        code: err instanceof WorkflowSubmitError ? err.code : undefined,
        serverReason: submitReason,
        err: String(err),
      });
      patchJob(localId, {
        status: 'failed',
        // 🔴 THE MONEY ANSWER WINS, AND IT IS THE ONE COMPUTED ABOVE. Until
        // round 8 this was a fixed string branched on `err.code` alone, so the
        // fourth classification site wrote the CTA from the predicate and the
        // card from a literal — the exact two-consumers-disagreeing shape the
        // one predicate exists to prevent, reintroduced by the site that was
        // added to close it. Unobservable today only because every snapshot the
        // SDK can throw is UNPRICED (see the ⚠️ above), which is a fact about
        // the SDK's throw conditions, not about this block.
        //
        // Below the money answer the two codes still get their own sentence,
        // because the SDK is emphatic that they differ — but NOT on the axis
        // this comment used to claim. It read "`exception` = nothing was queued
        // and no money moved", which the SDK contradicts in as many words: it
        // "means the host had no workflow to report — NOT that nothing
        // happened", and lists a lost response, an in-progress idempotency
        // conflict and a transient 5xx as shapes on which a workflow may have
        // been created and charged; "do not render 'nothing was charged' to a
        // viewer as a certainty". What actually separates them is what there is
        // to DO: `'exception'` has no workflow id at all, so re-submitting (with
        // the same idempotency key) is the recovery — "Couldn't submit this
        // generation." `'workflow-failed'` came back from a real server-built
        // reply that is already failed and may already be paid for, so it is
        // reported as a start that did not take, not as a send that did not
        // land. Both sentences are silent about money, which is the point; the
        // rendered copy was already correct, the comment licensing it was not.
        error: refused
          ? viewerFailureText(true)
          : err instanceof WorkflowSubmitError && err.code === 'workflow-failed'
            ? 'This generation failed to start.'
            : "Couldn't submit this generation.",
      });
      // 🔴 THIS IS A TERMINAL TRANSITION, SO IT REFETCHES — round 8's F3. The
      // patch above puts the job in `'failed'`, which IS in `JOB_TERMINAL`, and
      // no poll loop was ever started for it, so neither of the other refetch
      // sites can fire. Without this the block was left holding a balance from
      // before the submit AND (after round 7) a standing verdict, with nothing
      // scheduled to refresh either — which is what made the sentence on
      // `knownBuzzBalance` ("every terminal transition refetches", the licence
      // for the accepted stale-HIGH residual) false on the one path round 7
      // changed.
      //
      // 🔴 SAFE BECAUSE THE VERDICT IS STORED, NOT DERIVED (round 6's leg 2):
      // the figure this fetches can no longer re-classify a decision already
      // made, so a refetch here cannot resurrect round 6's F1. Measured, not
      // assumed — `R8 F3` in `spend-verdict.test.tsx` moves the balance to one
      // that would flip the verdict if anything still re-derived it, and asserts
      // the CTA and both copies are unchanged.
      refetchBalanceRef.current();
    }
  };

  // 🔴 `spendLimited` IS THE STORED VERDICT, STILL APPLICABLE — the stored half
  // is `spendLimitedForKey` (declared with the other CTA state above) and the
  // applicability half is the key comparison beside `spendSubjectKey`. The
  // classification is not re-run; only the question "is this answer still about
  // what is on screen?" is, and that question reads no balance and no snapshot.
  // Every classification in this component runs
  // at exactly FOUR sites — the estimate rejection, the submit reply, the submit
  // throw, the poll terminal — and each one writes BOTH this value and the job
  // card's copy from the SAME call, so the two consumers cannot classify one
  // snapshot differently however the balance moves afterwards.
  //
  // 🔴 THAT COUNT WAS THREE UNTIL ROUND 8, AND THE FOURTH SITE ONLY OBEYED THE
  // INVARIANT BY CONVENTION. Round 7 added the submit-throw site, which wrote
  // the verdict from the predicate while the card beside it took a literal
  // branched on `err.code` — so the sentence above went on asserting a property
  // the code had just stopped having. It was unobservable, because every
  // snapshot `submit()` can throw is unpriced and the predicate answers `false`
  // for all of them; had that ever changed, the CTA would have said "spend limit
  // / Top up" beside a card saying "This generation failed to start." The card
  // write now takes the same boolean, so the property is structural at all four.
  //
  // 🔴 IT USED TO READ `const spendLimited = isSpendLimitRefusal(result, spend)`
  // on every render, over the hook's shared `result`. That is what made round
  // 6's F1 possible: the terminal branch refetches the balance, the refetch
  // returns the POST-DEBIT figure, and the render that followed re-classified
  // the already-decided failure against it — putting "hit a Buzz spend limit"
  // and a top-up button next to a card reading "This generation failed.", for
  // money the SDK says is already committed and will not be refunded.
  //
  // Do not reintroduce a render-time call to `isSpendLimitRefusal` here.

  return (
    <div ref={rootRef} data-theme={theme === 'dark' ? 'dark' : 'light'} style={outerContainerStyle(theme)}>
      <div style={innerContainerStyle()}>
        <StyleSheet />
        <Header
          theme={theme}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
          isBusy={false}
        />

        {checkpointError && (
          <p style={errorTextStyle}>Checkpoint: {checkpointError}</p>
        )}

        {showcaseImages.length > 0 && (
          <div>
            <p id="gfm-starter-label" style={sectionLabelStyle}>
              Select Starter
            </p>
            <div className="gfm-carousel-wrap" style={carouselWrapStyle(theme)}>
              <div
                ref={carouselRef}
                className="gfm-carousel"
                style={carouselStyle}
                data-testid="gfm-carousel"
                aria-labelledby="gfm-starter-label"
              >
                {showcaseImages.map((img, idx) => (
                  <button
                    key={img.id}
                    ref={(el) => {
                      thumbRefs.current[idx] = el;
                    }}
                    type="button"
                    aria-label={`Pick preview ${idx + 1}`}
                    aria-pressed={idx === selectedShowcaseIdx}
                    onClick={() => setSelectedShowcaseIdx(idx)}
                    className="gfm-thumb"
                    style={thumbButtonStyle(idx === selectedShowcaseIdx, theme, img)}
                  >
                    <img src={img.url} alt="" style={thumbImageStyle} loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label htmlFor="gfm-prompt-input" style={sectionLabelStyle}>
              Describe Image
            </label>
            <PromptTextarea
              value={prompt}
              onChange={setPrompt}
              onSubmit={handleGenerate}
              disabled={false}
              theme={theme}
            />
          </div>

          <AdvancedSection
            open={advancedOpen}
            editable={showAdvanced}
            showcase={selectedShowcase}
            overrides={overrides}
            onOverrideChange={(patch) => setOverrides((prev) => ({ ...prev, ...patch }))}
            randomizeSeedOnce={randomizeSeedOnce}
            onRandomizeSeed={() => setRandomizeSeedOnce(true)}
            onUndoRandomize={() => setRandomizeSeedOnce(false)}
            isBusy={false}
            theme={theme}
            showCheckpointPicker={showCheckpointPicker}
            effectiveCheckpoint={effectiveCheckpoint}
            onChangeCheckpoint={handleChangeCheckpoint}
          />

          <label style={debugRowStyle(theme)}>
            <input
              type="checkbox"
              checked={forceZeroBuzz}
              onChange={(e) => {
                setForceZeroBuzz(e.target.checked);
                // Toggling off clears the simulated state so the next
                // real Generate click works normally. Also clears any
                // stale estimate error from a pre-toggle attempt — the
                // auto-estimate effect will refresh on the next mount.
                if (!e.target.checked) {
                  setSimulatedInsufficient(false);
                  setEstimateError(null);
                }
              }}
              aria-label="Simulate zero Buzz balance"
            />
            <span>Simulate 0 Buzz (test top-up)</span>
          </label>

          {/* Anonymous conversion: a logged-out viewer sees a "Sign in to
              generate" CTA. Clicking it asks the host to open civitai's login
              flow (handleGenerate posts REQUEST_SIGN_IN for anon). Highest
              priority — anon never sees the Top-Up or cost CTAs. */}
          {isAnon ? (
            <button
              type="button"
              onClick={handleGenerate}
              className="gfm-primary"
              style={primaryButtonStyle(false)}
              data-testid="gfm-signin-cta"
            >
              <span>Sign in to generate</span>
              <BoltIcon />
            </button>
          ) : /* Proactive top-up surface: when forceZeroBuzz is checked OR a
              previous estimate/submit hit an insufficient-buzz error, swap
              the Generate button for the Top-Up CTA so the user never has
              to click a doomed Generate to discover they're short. The
              error block below renders the EXPLANATORY copy under it. */
          (forceZeroBuzz || spendLimited || simulatedInsufficient) ? (
            <button
              type="button"
              onClick={() => openPurchaseModal(budget * 10)}
              className="gfm-primary"
              style={primaryButtonStyle(false)}
            >
              <span>Top up · {budget * 10}</span>
              <BoltIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleGenerate}
              // Task 2: the Generate button is NEVER disabled by an
              // in-flight generation OR a mid-flight cost re-quote — the
              // queue makes submission non-blocking, so the user can keep
              // firing off more at any time. While a re-estimate is in
              // flight we keep the last-known cost on the label (a small
              // pulse signals the quote is refreshing) so the number never
              // flickers blank; "Estimating cost…" shows only on the very
              // first quote, before any cost has landed.
              className="gfm-primary"
              style={primaryButtonStyle(false)}
            >
              {isEstimating && <Pulse />}
              <ButtonLabel
                label={labelForStatus(
                  isEstimating && estimatedCost == null ? 'estimating' : 'idle',
                  budget,
                  estimatedCost,
                  isRegenerate
                )}
              />
            </button>
          )}

          {/* Hide the stale "Couldn't estimate cost: …" line when
              forceZeroBuzz is on — auto-estimate is skipped in that mode
              so any old error message would just confuse the user. */}
          {estimateError && !forceZeroBuzz && (
            <p style={{ ...subtleStyle, fontSize: 12 }}>
              Couldn't estimate cost: {estimateError}
            </p>
          )}
        </div>

        {(forceZeroBuzz || simulatedInsufficient || spendLimited) ? (
          // Explanatory copy under the proactive Top-Up button above.
          // Distinguishes between the real "you ran out" case and the
          // debug-toggle "we're pretending you ran out" case so a tester
          // doesn't get confused about whether their balance is actually
          // affected.
          <p style={{ ...subtleStyle, fontSize: 12, marginTop: -4 }}>
            {forceZeroBuzz
              ? 'Simulate 0 Buzz is on — Generate is hidden. Uncheck the box above to run for real.'
              : 'This generation hit a Buzz spend limit.'}
          </p>
        ) : null}

        {(error || result?.status === 'failed' || result?.status === 'expired' || result?.status === 'canceled') && !spendLimited && !simulatedInsufficient && (
          // Non-insufficient errors only — the insufficient path is now
          // handled proactively above the primary CTA so we don't render
          // a duplicate "Not enough Buzz" surface here.
          <div style={errorBoxStyle(theme)} role="alert">
            <p style={{ margin: 0 }}>
              {/* 🔴 NEITHER `error.message` NOR `result.error` may be rendered.
                  The first is the SDK's developer-facing summary; the second is
                  server-authored and unsanitised, documented as carrying raw
                  Prisma/pg column and constraint names. This line is why the
                  earlier "we no longer render the SDK string" claim was not
                  true of the app — the catches were fixed and this was not.
                  Nothing reads either string for CLASSIFICATION any more
                  either: the one predicate is arithmetic over `cost.total`,
                  the viewer's balance and the token's budget cap. The only
                  consumer of `result.error` left is the developer console. */}
              {/* No spend-limit ternary here: this block's own render
                  guard above already excludes that case (it routes to the
                  top-up CTA instead), so the true arm was unreachable —
                  measured, replacing it with a sentinel string left the suite
                  fully green. A branch that cannot execute reads as handling a
                  case it structurally cannot reach. */}
              Generation failed.
            </p>
          </div>
        )}

        {/* Results carousel — the queue, newest-first. In-flight jobs
            (submitting / pending / processing) render as shimmer
            LoadingCards anchored where their result will land; succeeded
            jobs show the image + spend + Download. Multiple jobs can be
            in flight at once (task 3) — each polls independently and lands
            in its own card. The whole row persists for the session and
            across showcase swaps. */}
        {queue.length > 0 && (
          <ResultsCarousel
            scrollRef={resultsCarouselRef}
            jobs={queue}
            theme={theme}
            modelName={model.modelName}
            liveEstimatedCost={estimatedCost}
            onOpenImage={setLightboxUrl}
            onCancelJob={cancelJob}
            onDismissJob={dismissJob}
          />
        )}
      </div>
      {lightboxUrl && (
        <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
      )}
    </div>
  );
}

// --------- helpers ---------

/**
 * Tier-3 #9: prompt input is a textarea (was a single-line input). Most
 * useful prompts are multi-line; cramming them into one line and clipping
 * everything past the visible width was hostile UX. Auto-grow caps at
 * ~5 lines (max-height) so a runaway paste can't blow the iframe out.
 *
 * Keyboard shortcut: Ctrl/Cmd+Enter submits (rather than rebinding plain
 * Enter, which would block multi-line entry). The aria-label stays
 * 'Prompt (optional)' for parity with the existing test selectors.
 */
function PromptTextarea({
  value,
  onChange,
  onSubmit,
  disabled,
  theme,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void | Promise<void>;
  disabled: boolean;
  theme: string | null;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: resize the textarea to fit content up to the max-height
  // cap. Browsers that support `field-sizing: content` get this for free
  // via CSS; the effect is a fallback for everyone else. Runs on every
  // value change so paste/delete both reflow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Skip when CSS field-sizing is honored — the browser will manage
    // the height itself, and JS-poking the style fights it.
    try {
      const fs = window.getComputedStyle(el).getPropertyValue('field-sizing');
      if (fs && fs.trim().toLowerCase() === 'content') return;
    } catch {
      // getComputedStyle should always exist in JSDOM, but be defensive.
    }
    // Reset to auto so scrollHeight reflects content, not the prior set
    // height. Then clamp to the max-height ceiling.
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_PROMPT_HEIGHT);
    el.style.height = `${next}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      id="gfm-prompt-input"
      aria-label="Prompt (optional)"
      placeholder="Describe what you want (or hit Generate to use the preview)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Ctrl/Cmd+Enter submits — same convention as Slack, Discord,
        // ChatGPT, etc. Plain Enter falls through to the textarea so the
        // user can write multi-line prompts.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (!disabled) void onSubmit();
        }
      }}
      rows={2}
      className="gfm-input gfm-textarea"
      style={textareaStyle(theme)}
      disabled={disabled}
    />
  );
}

/**
 * Tier-3 #1, #2, #3: header is just the title + a three-dots advanced
 * toggle. The Tier-1 subtitle (model name + ecosystem chip) was a power-
 * user signal that 90% of users ignore; deleting it reclaims vertical
 * space inside the iframe. The model identity is already obvious from
 * the surrounding page context (the block sits on the model page).
 *
 * The three-dots button is the SOLE trigger for the AdvancedSection
 * (the inline `⚙ Advanced` toggle that lived below the prompt is gone).
 * Sectionbody still renders below the prompt; we just moved the trigger.
 */
function Header({
  theme,
  advancedOpen,
  onToggleAdvanced,
  isBusy,
}: {
  theme: string | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  isBusy: boolean;
}) {
  return (
    <header style={headerStyle}>
      <h3 style={headerTitleStyle}>Quick Sample</h3>
      <button
        type="button"
        onClick={onToggleAdvanced}
        aria-label="Advanced settings"
        aria-expanded={advancedOpen}
        aria-controls="block-advanced"
        disabled={isBusy}
        className="gfm-dots-btn"
        style={dotsButtonStyle(advancedOpen, theme)}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1, letterSpacing: 1 }}>
          ⋯
        </span>
      </button>
    </header>
  );
}

/**
 * Collapsible advanced-controls section. Unifies Gap 1 (visibility) and
 * Gap 3 (editability):
 *   - `editable=false` (publisher's show_advanced unset): shows read-only
 *     chips so the user can SEE what params will be sent — fixes the
 *     "silent stamping" problem from the day-2 handoff.
 *   - `editable=true`: shows real inputs so the user can override the
 *     showcase's params. Values fall through to the showcase when the
 *     input is blank (undefined override).
 *
 * All controls respect `isBusy` — mid-flight mutation is disabled.
 */
function AdvancedSection(props: {
  open: boolean;
  editable: boolean;
  showcase: ShowcaseImage | null;
  overrides: ParamOverrides;
  onOverrideChange: (patch: ParamOverrides) => void;
  randomizeSeedOnce: boolean;
  onRandomizeSeed: () => void;
  onUndoRandomize: () => void;
  isBusy: boolean;
  theme: string | null;
  // Checkpoint picker — relocated here from the header so 90% users
  // don't see it by default. Only rendered when the install isn't
  // Checkpoint-bound (LoRA installs can swap the underlying Checkpoint).
  showCheckpointPicker: boolean;
  effectiveCheckpoint: BlockCheckpointInfo | null;
  onChangeCheckpoint: () => void;
}) {
  const {
    open,
    editable,
    showcase,
    overrides,
    onOverrideChange,
    randomizeSeedOnce,
    onRandomizeSeed,
    onUndoRandomize,
    isBusy,
    theme,
    showCheckpointPicker,
    effectiveCheckpoint,
    onChangeCheckpoint,
  } = props;

  // Effective values for display: override wins, then showcase.
  const eff = {
    negativePrompt: overrides.negativePrompt ?? showcase?.negativePrompt ?? '',
    cfgScale: overrides.cfgScale ?? showcase?.cfgScale ?? null,
    steps: overrides.steps ?? showcase?.steps ?? null,
    // Seed displayed: if randomize-once is armed, surface that visibly
    // ('random' label) rather than the underlying showcase seed.
    seed: randomizeSeedOnce ? null : overrides.seed ?? showcase?.seed ?? null,
    sampler: overrides.sampler ?? showcase?.sampler ?? '',
    width: overrides.width ?? showcase?.width ?? null,
    height: overrides.height ?? showcase?.height ?? null,
    clipSkip: overrides.clipSkip ?? showcase?.clipSkip ?? null,
  };

  return (
    <div
      id="block-advanced"
      aria-hidden={!open}
      style={advancedCollapseStyle(open)}
    >
      <div style={advancedWrapperStyle(theme)}>
        <div style={advancedBodyStyle(theme)}>
          {!editable && (
            // The "(read-only)" affordance used to live in the inline
            // toggle copy. Now the three-dots is iconic only, so surface
            // the read-only state as a small label inside the body.
            <p style={{ ...subtleStyle, fontSize: 12, margin: '0 0 8px 0' }}>
              Advanced (read-only)
            </p>
          )}
          {showCheckpointPicker && (
            <div style={{ ...checkpointRowStyle(theme), marginBottom: 10 }}>
              <span style={subtleStyle}>
                Generating with:{' '}
                {effectiveCheckpoint ? (
                  <strong style={{ color: 'inherit', opacity: 1 }}>
                    {effectiveCheckpoint.modelName}
                    {effectiveCheckpoint.versionName
                      ? ` (${effectiveCheckpoint.versionName})`
                      : ''}
                  </strong>
                ) : (
                  <em>no checkpoint configured</em>
                )}
              </span>
              <button
                type="button"
                onClick={onChangeCheckpoint}
                className="gfm-link"
                style={linkButtonStyle()}
                disabled={isBusy}
              >
                Change
              </button>
            </div>
          )}
          {editable ? (
            <EditableControls
              eff={eff}
              overrides={overrides}
              onOverrideChange={onOverrideChange}
              randomizeSeedOnce={randomizeSeedOnce}
              onRandomizeSeed={onRandomizeSeed}
              onUndoRandomize={onUndoRandomize}
              isBusy={isBusy}
              theme={theme}
            />
          ) : (
            <ReadOnlyChips eff={eff} randomizeSeedOnce={randomizeSeedOnce} theme={theme} />
          )}
        </div>
      </div>
    </div>
  );
}

function ReadOnlyChips(props: {
  eff: {
    negativePrompt: string;
    cfgScale: number | null;
    steps: number | null;
    seed: number | null;
    sampler: string;
    width: number | null;
    height: number | null;
    clipSkip: number | null;
  };
  randomizeSeedOnce: boolean;
  theme: string | null;
}) {
  const { eff, randomizeSeedOnce, theme } = props;
  const chips: Array<[string, string]> = [];
  if (eff.cfgScale != null) chips.push(['cfg', String(eff.cfgScale)]);
  if (eff.steps != null) chips.push(['steps', String(eff.steps)]);
  chips.push(['seed', randomizeSeedOnce ? 'random' : eff.seed != null ? String(eff.seed) : 'auto']);
  if (eff.sampler) chips.push(['sampler', eff.sampler]);
  if (eff.width != null && eff.height != null) {
    chips.push(['size', `${eff.width}×${eff.height}`]);
  }
  if (eff.clipSkip != null) chips.push(['clip skip', String(eff.clipSkip)]);
  if (eff.negativePrompt) chips.push(['neg', truncate(eff.negativePrompt, 40)]);

  if (chips.length === 0) {
    return <p style={subtleStyle}>No params from showcase — host defaults will apply.</p>;
  }
  return (
    <div style={chipRowStyle}>
      {chips.map(([k, v]) => (
        <span key={k} style={chipStyle(theme)}>
          <strong style={{ opacity: 0.65, marginRight: 4 }}>{k}:</strong>
          {v}
        </span>
      ))}
    </div>
  );
}

function EditableControls(props: {
  eff: {
    negativePrompt: string;
    cfgScale: number | null;
    steps: number | null;
    seed: number | null;
    sampler: string;
    width: number | null;
    height: number | null;
    clipSkip: number | null;
  };
  overrides: ParamOverrides;
  onOverrideChange: (patch: ParamOverrides) => void;
  randomizeSeedOnce: boolean;
  onRandomizeSeed: () => void;
  onUndoRandomize: () => void;
  isBusy: boolean;
  theme: string | null;
}) {
  const {
    eff,
    overrides,
    onOverrideChange,
    randomizeSeedOnce,
    onRandomizeSeed,
    onUndoRandomize,
    isBusy,
    theme,
  } = props;

  // Display values for the inputs. Treat `overrides.X` as the user's
  // current edit (including '' meaning they cleared it). If the user
  // hasn't touched a field, show the showcase value.
  const negDisplay =
    overrides.negativePrompt !== undefined ? overrides.negativePrompt : eff.negativePrompt;

  return (
    <div style={editableGridStyle}>
      <label style={labelStyle}>
        Negative prompt
        <textarea
          value={negDisplay}
          onChange={(e) => onOverrideChange({ negativePrompt: e.target.value })}
          disabled={isBusy}
          rows={2}
          className="gfm-input"
          style={{ ...inputStyle(theme), resize: 'vertical', fontFamily: 'inherit' }}
        />
      </label>

      <div style={twoColStyle}>
        <label style={labelStyle}>
          CFG scale
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            value={eff.cfgScale ?? ''}
            placeholder="auto"
            onChange={(e) =>
              onOverrideChange({ cfgScale: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            disabled={isBusy}
            className="gfm-input"
            style={inputStyle(theme)}
          />
        </label>
        <label style={labelStyle}>
          Steps
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            value={eff.steps ?? ''}
            placeholder="auto"
            onChange={(e) =>
              onOverrideChange({
                steps: e.target.value === '' ? undefined : Math.round(Number(e.target.value)),
              })
            }
            disabled={isBusy}
            className="gfm-input"
            style={inputStyle(theme)}
          />
        </label>
      </div>

      <label style={labelStyle}>
        Seed
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            value={randomizeSeedOnce ? '' : eff.seed ?? ''}
            placeholder={randomizeSeedOnce ? 'random (next gen)' : 'auto'}
            onChange={(e) => {
              // Editing the seed cancels a pending randomize.
              if (randomizeSeedOnce) onUndoRandomize();
              onOverrideChange({
                seed: e.target.value === '' ? undefined : Number(e.target.value),
              });
            }}
            disabled={isBusy || randomizeSeedOnce}
            className="gfm-input"
            style={{ ...inputStyle(theme), flex: 1 }}
          />
          <button
            type="button"
            onClick={randomizeSeedOnce ? onUndoRandomize : onRandomizeSeed}
            disabled={isBusy}
            title={
              randomizeSeedOnce
                ? 'Cancel randomize, use showcase seed'
                : 'Randomize seed for next generation (one-shot)'
            }
            style={diceButtonStyle(randomizeSeedOnce, theme)}
          >
            🎲 {randomizeSeedOnce ? 'cancel' : 'random'}
          </button>
        </div>
      </label>

      <label style={labelStyle}>
        Sampler
        <input
          type="text"
          value={overrides.sampler !== undefined ? overrides.sampler : eff.sampler}
          placeholder="e.g. Euler, DPM++ 2M Karras"
          onChange={(e) =>
            onOverrideChange({ sampler: e.target.value === '' ? undefined : e.target.value })
          }
          disabled={isBusy}
          style={inputStyle(theme)}
        />
      </label>

      <div style={twoColStyle}>
        <label style={labelStyle}>
          Width
          <input
            type="number"
            min={64}
            max={2048}
            step={8}
            value={eff.width ?? ''}
            placeholder="auto"
            onChange={(e) =>
              onOverrideChange({
                width: e.target.value === '' ? undefined : Math.round(Number(e.target.value)),
              })
            }
            disabled={isBusy}
            className="gfm-input"
            style={inputStyle(theme)}
          />
        </label>
        <label style={labelStyle}>
          Height
          <input
            type="number"
            min={64}
            max={2048}
            step={8}
            value={eff.height ?? ''}
            placeholder="auto"
            onChange={(e) =>
              onOverrideChange({
                height: e.target.value === '' ? undefined : Math.round(Number(e.target.value)),
              })
            }
            disabled={isBusy}
            className="gfm-input"
            style={inputStyle(theme)}
          />
        </label>
      </div>

      <label style={labelStyle}>
        Clip skip
        <input
          type="number"
          min={0}
          max={12}
          step={1}
          value={eff.clipSkip ?? ''}
          placeholder="auto (Flux ignores this)"
          onChange={(e) =>
            onOverrideChange({
              clipSkip:
                e.target.value === '' ? undefined : Math.round(Number(e.target.value)),
            })
          }
          disabled={isBusy}
          style={inputStyle(theme)}
        />
      </label>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Horizontally-scrollable queue of queued + completed generations (newest
 * first). Mirrors the on-site Civitai generator's queue feed (civitai-web
 * `Queue.tsx` / `QueueItem.tsx`): every slot is STATUS-LABELLED via a badge
 * (Queued / Generating… / Done / Failed / Expired / Canceled) so an
 * in-flight job is no longer an anonymous shimmer — the user can read what
 * each slot is doing. In-flight jobs show the shimmer + a Cancel (X)
 * control; succeeded jobs show the image + "Spent N Buzz" + Download;
 * failed / expired / canceled jobs render a compact reason card. Every
 * terminal slot carries a small dismiss (X) so the user can clear it.
 *
 * Each card is a 240px-wide tile (max image height 320px). Multiple jobs
 * can be in flight simultaneously — the queue polls each independently —
 * so several in-flight cards may sit at the front at once.
 *
 * The Download button is NEVER disabled by another in-flight job (task 2):
 * a completed result is downloadable even while newer generations run.
 */
function ResultsCarousel({
  scrollRef,
  jobs,
  theme,
  modelName,
  liveEstimatedCost,
  onOpenImage,
  onCancelJob,
  onDismissJob,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  jobs: QueueJob[];
  theme: string | null;
  modelName: string;
  // Live estimate fallback for an in-flight job that hasn't snapshotted a
  // cost yet (e.g. a 'submitting' job created before submit() resolved).
  liveEstimatedCost: number | null;
  onOpenImage: (url: string) => void;
  // Cancel an in-flight job (client-side only — see cancelJob in App).
  onCancelJob: (localId: string, workflowId: string | null) => void;
  // Remove a terminal job's card from the queue.
  onDismissJob: (localId: string) => void;
}) {
  // Number succeeded cards newest→oldest for alt/aria text. Count total
  // succeeded so the first (newest) succeeded card reads "Generation N".
  const succeededCount = jobs.filter((j) => j.status === 'succeeded').length;
  let succeededSeen = 0;

  return (
    <div className="gfm-fade-in" style={{ marginTop: 8 }}>
      <div className="gfm-carousel-wrap" style={carouselWrapStyle(theme)}>
        <div
          ref={scrollRef}
          className="gfm-carousel gfm-results-carousel"
          style={resultsCarouselStyle}
          data-testid="gfm-results-carousel"
        >
          {jobs.map((job) => {
            if (isJobInFlight(job.status)) {
              return (
                <LoadingCard
                  key={job.localId}
                  theme={theme}
                  status={job.status}
                  cost={job.cost ?? liveEstimatedCost}
                  aspectRatio={job.aspectRatio}
                  onCancel={() => onCancelJob(job.localId, job.workflowId)}
                />
              );
            }
            if (job.status !== 'succeeded') {
              return (
                <ErrorCard
                  key={job.localId}
                  theme={theme}
                  status={job.status}
                  message={job.error}
                  aspectRatio={job.aspectRatio}
                  onDismiss={() => onDismissJob(job.localId)}
                />
              );
            }
            const firstUrl = job.imageUrls[0] ?? null;
            // Newest succeeded card gets the highest number.
            const genNumber = succeededCount - succeededSeen;
            succeededSeen += 1;
            return (
              <div key={job.localId} style={resultCardStyle(theme)}>
                <div style={cardHeaderStyle}>
                  <StatusBadge theme={theme} status={job.status} />
                  <DismissButton
                    theme={theme}
                    onClick={() => onDismissJob(job.localId)}
                  />
                </div>
                {firstUrl && (
                  <button
                    type="button"
                    onClick={() => onOpenImage(firstUrl)}
                    aria-label={`View generation ${genNumber} full size`}
                    title="View full size"
                    className="gfm-image-open"
                    style={resultImageButtonStyle}
                  >
                    <img
                      src={firstUrl}
                      alt={`Generation ${genNumber}`}
                      style={resultCardImageStyle(theme)}
                      loading="lazy"
                    />
                  </button>
                )}
                <div style={resultCardFooterStyle}>
                  {job.cost != null ? (
                    <p style={{ ...subtleStyle, marginRight: 'auto', fontSize: 12 }}>
                      Spent{' '}
                      <strong style={{ opacity: 1, color: 'inherit' }}>
                        {job.cost} Buzz
                      </strong>
                    </p>
                  ) : (
                    <span style={{ marginRight: 'auto' }} />
                  )}
                  {firstUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        void downloadImage(firstUrl, modelName);
                      }}
                      aria-label="Download"
                      title="Download"
                      className="gfm-icon-btn"
                      style={iconButtonStyle(theme)}
                    >
                      <DownloadIcon />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * In-flight slot in the results queue. Header carries a STATUS badge
 * (Queued while submitting/pending, Generating… while processing) plus a
 * Cancel (X) control — so the user can read what the slot is doing and
 * clear one that's stuck. Body is a shimmer-animated rectangle sized to
 * the selected showcase's aspect ratio (rough preview of the shape the
 * user is about to get). Footer shows the live cost.
 *
 * `aria-busy` + `aria-label` give screen readers a hook;
 * `prefers-reduced-motion` already disables the shimmer via the global
 * media-query block.
 */
function LoadingCard({
  theme,
  status,
  cost,
  aspectRatio,
  onCancel,
}: {
  theme: string | null;
  status: QueueJobStatus;
  cost: number | null;
  aspectRatio: string;
  onCancel: () => void;
}) {
  return (
    // aria-label stays the constant "Generating" busy hook (screen-reader
    // + existing test selector); the visible per-status wording lives in
    // the StatusBadge ("Queued" / "Generating…").
    <div style={resultCardStyle(theme)} aria-busy aria-label="Generating">
      <div style={cardHeaderStyle}>
        <StatusBadge theme={theme} status={status} />
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel generation"
          title="Cancel"
          className="gfm-icon-btn"
          style={iconButtonStyle(theme)}
        >
          <CloseIcon />
        </button>
      </div>
      <div
        style={{
          aspectRatio,
          maxHeight: 320,
          width: '100%',
          borderRadius: 8,
          background:
            theme === 'dark'
              ? 'linear-gradient(90deg, #1A1B1E 0%, #25262B 50%, #1A1B1E 100%)'
              : 'linear-gradient(90deg, #e9ecef 0%, #f1f3f5 50%, #e9ecef 100%)',
          backgroundSize: '200% 100%',
          animation: 'gfm-shimmer 1.4s ease-in-out infinite',
        }}
      />
      <div style={resultCardFooterStyle}>
        <p
          style={{
            ...subtleStyle,
            marginRight: 'auto',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Pulse />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            Generating
            {cost != null && (
              <>
                {' · '}
                <strong style={{ opacity: 1, color: 'inherit' }}>{cost}</strong>
                <BoltIcon />
              </>
            )}
          </span>
        </p>
      </div>
    </div>
  );
}

/**
 * Terminal non-success slot for a job that ended failed / expired /
 * canceled. Header carries the STATUS badge (so the slot reads as done,
 * not spinning) + a dismiss (X) to clear it. Body holds a short reason.
 * No Download button — there's no image. Sized to the job's aspect ratio
 * so it doesn't collapse the row. A canceled card reads neutrally (the
 * user asked for it); failed / expired read as an error.
 */
function ErrorCard({
  theme,
  status,
  message,
  aspectRatio,
  onDismiss,
}: {
  theme: string | null;
  status: QueueJobStatus;
  message?: string;
  aspectRatio: string;
  onDismiss: () => void;
}) {
  const isCanceled = status === 'canceled';
  const reason =
    message ??
    (isCanceled
      ? 'Canceled. The workflow may still be running on the server.'
      : `Generation ${status}`);
  return (
    <div
      style={resultCardStyle(theme)}
      role={isCanceled ? undefined : 'alert'}
      aria-label={statusLabel(status)}
    >
      <div style={cardHeaderStyle}>
        <StatusBadge theme={theme} status={status} />
        <DismissButton theme={theme} onClick={onDismiss} />
      </div>
      <div
        style={{
          aspectRatio,
          maxHeight: 320,
          width: '100%',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 8,
          boxSizing: 'border-box',
          background: isCanceled
            ? theme === 'dark'
              ? '#212226'
              : '#f1f3f5'
            : theme === 'dark'
              ? '#2B1A1A'
              : '#fff5f5',
          color: isCanceled
            ? theme === 'dark'
              ? '#909296'
              : '#868e96'
            : theme === 'dark'
              ? '#FFA8A8'
              : '#C92A2A',
          border: `1px solid ${
            isCanceled
              ? theme === 'dark'
                ? '#373A40'
                : '#dee2e6'
              : theme === 'dark'
                ? '#5C2A2A'
                : '#ffc9c9'
          }`,
          fontSize: 12,
        }}
      >
        <span>{reason}</span>
      </div>
    </div>
  );
}

/**
 * Status badge — a colored dot + label that reads each queue slot's state
 * at a glance (Queued / Generating… / Done / Failed / Expired / Canceled).
 * Color follows the on-site generator's mapping (yellow=in-flight,
 * green=done, red=failed, gray=expired/canceled), adapted to the block's
 * inline-style + dark/light theming.
 */
function StatusBadge({
  theme,
  status,
}: {
  theme: string | null;
  status: QueueJobStatus;
}) {
  const tone = statusTone(status);
  const c = statusBadgeColors(tone, theme);
  const inFlight = isJobInFlight(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: 0.2,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {inFlight ? (
        <Pulse />
      ) : (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: 999,
            background: 'currentColor',
          }}
        />
      )}
      {statusLabel(status)}
    </span>
  );
}

/**
 * Small ghost X used to clear a terminal slot (succeeded / failed /
 * canceled) from the queue. Same ghost-icon styling as the per-card
 * Download / Cancel controls.
 */
function DismissButton({
  theme,
  onClick,
}: {
  theme: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      title="Dismiss"
      className="gfm-icon-btn"
      style={iconButtonStyle(theme)}
    >
      <CloseIcon />
    </button>
  );
}

/**
 * Returns the button label split into a leading verb-phrase and a numeric
 * cost. The button renders `{verb} · {cost} <BoltIcon />` when cost is
 * known, or `{verb} (≤ {budget} <BoltIcon />)` as a fallback — the Buzz
 * word is gone from the label; the bolt icon is the Buzz indicator.
 *
 * Status semantics: estimating | submitting | polling are busy; the rest
 * are actionable. After the first submit on a showcase, the verb flips
 * to "Re-generate Image" — the visible signal that the next click will
 * randomize the seed.
 */
type ButtonLabelInfo = { verb: string; cost: number | null; isFallback: boolean };
function labelForStatus(
  status: WorkflowStatus,
  budget: number,
  estimatedCost: number | null,
  isRegenerate = false
): ButtonLabelInfo {
  if (status === 'estimating') {
    return { verb: 'Estimating cost…', cost: null, isFallback: false };
  }
  if (status === 'submitting') {
    return estimatedCost != null
      ? { verb: 'Submitting', cost: estimatedCost, isFallback: false }
      : { verb: 'Submitting', cost: budget, isFallback: true };
  }
  if (status === 'polling') {
    return estimatedCost != null
      ? { verb: 'Generating', cost: estimatedCost, isFallback: false }
      : { verb: 'Generating', cost: budget, isFallback: true };
  }
  const verb = isRegenerate ? 'Re-generate Image' : 'Generate Image';
  return estimatedCost != null
    ? { verb, cost: estimatedCost, isFallback: false }
    : { verb, cost: budget, isFallback: true };
}

/**
 * Build the params block for submit/estimate. The single source of
 * truth for what's sent — both estimate() and submit() flow through
 * here so the displayed cost matches the charged cost.
 *
 * Layering (lowest → highest priority):
 *   1. Showcase image's gen meta (when a showcase is selected)
 *   2. User overrides (from the advanced controls)
 *   3. Special cases: user prompt always wins; randomizeSeed drops seed
 *
 * `null` fields on the showcase mean "no value in source meta" — they
 * stay out of the submit body so the host fills sensible defaults.
 * Same goes for `undefined` overrides — they fall through to the
 * showcase, then through to the host.
 */
function buildSubmitParams(
  userPrompt: string,
  suffix: string,
  selected: ShowcaseImage | null,
  overrides: ParamOverrides = {},
  randomizeSeed = false
): {
  prompt: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  sampler?: string;
  width?: number;
  height?: number;
  quantity: number;
} {
  const userPart = userPrompt.trim();
  const composed =
    userPart.length > 0
      ? [userPart, suffix].filter(Boolean).join(', ').trim()
      : selected?.prompt ?? '';

  const negativePrompt =
    overrides.negativePrompt !== undefined ? overrides.negativePrompt : selected?.negativePrompt;
  const cfgScale = overrides.cfgScale ?? selected?.cfgScale ?? undefined;
  const steps = overrides.steps ?? selected?.steps ?? undefined;
  // Seed: override > showcase. Then randomize wins by omitting it
  // entirely (so the orchestrator picks fresh).
  const seedRaw = overrides.seed ?? selected?.seed ?? undefined;
  const seed = randomizeSeed ? undefined : seedRaw;
  const sampler = overrides.sampler ?? selected?.sampler ?? undefined;
  const rawWidth = overrides.width ?? selected?.width ?? undefined;
  const rawHeight = overrides.height ?? selected?.height ?? undefined;
  const clipSkipRaw = overrides.clipSkip ?? selected?.clipSkip ?? undefined;
  const clipSkip =
    clipSkipRaw != null ? Math.min(12, Math.max(0, Math.round(clipSkipRaw))) : undefined;

  // Block-side schema caps mirror src/server/schema/blocks/workflow.schema.ts.
  // Showcase images can carry values beyond these caps (eg. an upscaled
  // 3000x2000 preview), so clamp before sending or the server returns
  // BAD_REQUEST. Dimensions scale-down preserves aspect ratio.
  const [width, height] = clampDimensions(rawWidth, rawHeight);
  const clampedSteps = steps != null ? Math.min(50, Math.max(1, Math.round(steps))) : undefined;
  const clampedCfg = cfgScale != null ? Math.min(30, Math.max(1, cfgScale)) : undefined;

  return {
    prompt: composed,
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(clampedCfg != null ? { cfgScale: clampedCfg } : {}),
    ...(clampedSteps != null ? { steps: clampedSteps } : {}),
    ...(seed != null ? { seed } : {}),
    ...(sampler ? { sampler } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(clipSkip != null ? { clipSkip } : {}),
    quantity: 1,
  };
}

const DIM_MIN = 64;
const DIM_MAX = 2048;
// Orchestrator U-Net constraint: width/height must both be multiples of 64.
// Rounding to /64 here is the responsibility of the block, not the host —
// the host schema only checks the [DIM_MIN, DIM_MAX] range.
function clampDimensions(w?: number, h?: number): [number | undefined, number | undefined] {
  if (w == null || h == null) return [w, h];
  if (w <= DIM_MAX && h <= DIM_MAX && w >= DIM_MIN && h >= DIM_MIN) return [round64(w), round64(h)];
  const scale = Math.min(DIM_MAX / w, DIM_MAX / h);
  const sw = Math.max(DIM_MIN, Math.round(w * scale));
  const sh = Math.max(DIM_MIN, Math.round(h * scale));
  return [round64(sw), round64(sh)];
}
const round64 = (n: number) => Math.max(DIM_MIN, Math.min(DIM_MAX, Math.round(n / 64) * 64));

function asModelContext(ctx: BlockContext): ModelSlotContext | null {
  if (
    ctx.slotId === 'model.sidebar_top' ||
    ctx.slotId === 'model.below_images' ||
    ctx.slotId === 'model.actions_extra'
  ) {
    return ctx as ModelSlotContext;
  }
  return null;
}

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function readBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Read the persisted selected-showcase ID from localStorage. Returns
 * null on any error (private mode, malformed JSON, missing key, etc.) —
 * the caller falls back to "first available image" in that case.
 */
function readPersistedShowcaseId(key: string | null): number | null {
  if (key == null) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed != null &&
      typeof (parsed as { selectedShowcaseId?: unknown }).selectedShowcaseId === 'number'
    ) {
      return (parsed as { selectedShowcaseId: number }).selectedShowcaseId;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedShowcaseId(key: string, id: number): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ selectedShowcaseId: id }));
  } catch {
    // Private mode / quota — silently no-op. Persistence is a nice-to-
    // have, not load-bearing.
  }
}

/**
 * Derive a tidy download filename from the model name + today's ISO date.
 * `Luna_arianaV3` → `luna_arianav3-2026-05-26.jpeg`.
 *
 * Lowercase + collapsing of any non-alphanumeric runs to a single dash
 * keeps the filename safe across OS file pickers (no spaces, no slashes).
 * Underscores survive — they're filesystem-safe AND they preserve the
 * model author's visual word boundaries (e.g. `Luna_arianaV3`).
 *
 * Orchestrator outputs are JPEGs today; we hard-code `.jpeg` rather than
 * trying to sniff content-type from the URL (CDN URLs don't carry it).
 */
export function deriveDownloadFilename(modelName: string, now: Date = new Date()): string {
  const slug = (modelName || 'generation')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safeSlug = slug.length > 0 ? slug : 'generation';
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return `${safeSlug}-${iso}.jpeg`;
}

/**
 * Trigger a file download for the given image URL.
 *
 * Tier-3 #10: the previous implementation set `<a download>` on a
 * cross-origin URL, but most CDNs don't return Content-Disposition:
 * attachment, so the browser ignored the download attribute and just
 * navigated to the image (kicking the user out of the block).
 *
 * Fix: fetch the image as a Blob first, point the anchor at a blob: URL
 * for the SAME origin, then the download attribute IS honored. Revoke
 * the blob URL on the next tick so the download has time to start.
 *
 * Fallback (CORS-blocked, network down, etc.): open the URL in a new
 * tab. Same as before — the user at least gets the image.
 */
export async function downloadImage(url: string, modelName: string): Promise<void> {
  const filename = deriveDownloadFilename(modelName);
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    // Anchors not in the document don't always trigger downloads on
    // Firefox — append, click, then remove.
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so the browser has time to start the download.
    // Safari is the strictest here — 0ms is enough in Chrome/FF but
    // a generous 1s keeps the cross-browser surface clean.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Already revoked or never registered — fine.
      }
    }, 1000);
  } catch {
    // Fallback: open in a new tab so the user at least gets the image.
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // Both paths failed — nothing more we can do without a toast lib.
    }
  }
}

// --------- subcomponents (skeleton, pulse, stylesheet) ---------

/**
 * One-time injection of CSS rules that can't be expressed as inline styles
 * — keyframes, :hover, :focus-visible. Lives at the top of the tree so a
 * remount overwrites cleanly. The `data-gfm-styles` attribute prevents
 * double-injection if the block ever re-renders before unmount completes.
 */
function StyleSheet() {
  useEffect(() => {
    const id = 'gfm-block-styles';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = STYLESHEET_CSS;
    document.head.appendChild(el);
    return () => {
      // Leave it: if multiple block instances ever mount in the same iframe
      // we don't want one unmount to nuke the others' styles. The id-guard
      // up top prevents duplication.
    };
  }, []);
  return null;
}

/**
 * Which theme to paint with BEFORE BLOCK_INIT lands.
 *
 * `useBlockContext().theme` is NOT usable here: the SDK's pre-init snapshot
 * hardcodes `theme: 'light'` (@civitai/blocks-react internal/transport.ts),
 * so it is a sentinel, not a signal — honouring it paints every viewer white
 * for the ~100ms until the host's real theme arrives.
 *
 * That matters because index.html now ships a static shimmer skeleton that
 * paints at first paint (before this bundle exists) and guesses the theme
 * from `prefers-color-scheme`. If React's first render disagreed, a
 * dark-mode viewer would get dark -> white -> dark: a NEW flash, at exactly
 * the moment the skeleton exists to remove one. The two guesses have to be
 * the same guess.
 *
 * Only the boot state uses this. Once `ready` is true the host's real theme
 * wins, whatever the OS says.
 */
function bootThemeGuess(): 'dark' | 'light' {
  try {
    // 1. WHAT THE BOOT SCRIPT ALREADY PAINTED WITH. index.html resolves the
    //    theme in <head> — host fragment first, OS second — and records it on
    //    <html data-civitai-boot-theme>. Reading that value back is what guarantees
    //    React's first render agrees with the pixels already on screen: it is
    //    the same value, not an independent re-derivation that could differ.
    //
    //    (Since blocks-react 0.44 the SDK's own transport also seeds its
    //    snapshot from the fragment before React renders, so `theme` from
    //    useBlockContext() is ALSO the host's answer when a fragment exists —
    //    but it stays the `'light'` sentinel when one does not, and this
    //    function must be right in both cases. Reading what was painted is.)
    //
    //    🔴 DO NOT "simplify" this to `parseBlockInitFragment(location.hash)`.
    //    It was written that way first and it is WRONG, silently: the SDK's own
    //    iframeTransport reads the fragment during its init and then STRIPS it
    //    from the URL (`stripBlockInitFragment` + `history.replaceState`,
    //    blocks-react internal/iframeTransport.js). That init runs before this
    //    component renders, so by here the hash is already empty and the read
    //    falls through to the OS guess — producing exactly the dark→light
    //    repaint this function exists to prevent. Measured in a real browser;
    //    a jsdom test cannot see it, because mocking @civitai/blocks-react
    //    means the transport never runs and never strips.
    const painted = document.documentElement.getAttribute('data-civitai-boot-theme');
    if (painted === 'dark' || painted === 'light') return painted;

    // 2. Boot script absent or blocked (JS-disabled is moot here, but a CSP or
    //    an edit could drop it). Guess from the OS, the pre-fragment behaviour.
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    // Older/embedded webviews without matchMedia. index.html's skeleton
    // falls back to its unmedia'd light rule in the same situation.
    return 'light';
  }
}

/**
 * Everything the ONE PREDICATE needs besides the snapshot: what the viewer can
 * actually spend, and what the block's own token is allowed to spend per call.
 *
 * `balance` is `null` for every kind of "we do not know" — never fetched yet,
 * anon viewer, host error, or a refetch in flight over a now-stale figure. The
 * predicate treats all of those the same way, and that is deliberate; see
 * {@link isSpendLimitRefusal}.
 */
type SpendContext = {
  /** Spendable pools from `useBuzzBalance()`, or `null` when unknown. */
  balance: { blue: number; green: number; yellow: number } | null;
  /** `token.buzzBudget` — the per-call ceiling the HOST enforces, if claimed. */
  budgetCap?: number | null;
};

/**
 * What the app knows about a job's LIFECYCLE at the moment it classifies one of
 * that job's failures. See the `accepted` clause in {@link isSpendLimitRefusal}.
 */
type JobLifecycle = {
  /**
   * `true` once `submit()` has replied with any non-`failed` status for this
   * job — the host took the workflow and the reservation is committed.
   * `false` for an estimate refusal and for a submit reply that came back
   * `failed`: neither was ever queued.
   */
  accepted: boolean;
};

/**
 * Is this resolved failure a TRUE BALANCE SHORTFALL — the one refusal family a
 * top-up can actually fix?
 *
 * 🔴 THE ONE PREDICATE. It decides the money CTA, the copy under it, and — via
 * `viewerFailureText` — the job card. Each of the FOUR classification sites (the
 * estimate rejection, the submit reply, the submit throw, the poll terminal)
 * calls it ONCE and hands the same boolean to both consumers, so a snapshot is
 * classified exactly once and both surfaces render that one answer. The count
 * read "three" until round 8; the submit-throw site round 7 added took the
 * predicate for the CTA and a literal for the card, and is now paired like the
 * rest — see the 🔴 above `spendLimited`'s render-time note.
 *
 * 🔴 THE RESIDUAL, NAMED RATHER THAN HIDDEN. Two earlier ones are now closed:
 * both card write sites used to be gated on `snap.error` being truthy (a priced
 * `failed` with no server text produced the CTA copy and a silent card — they
 * now fire on `status === 'failed'` too), and the CTA used to RE-DERIVE this on
 * every render from the hook's shared `result` while the card had frozen its
 * copy at write time, so a balance that moved in between made them disagree
 * about the same snapshot. What remains is the multi-job case: the CTA holds
 * ONE verdict — whichever job or estimate settled last — while each card holds
 * its own, so with several jobs in flight the CTA can be describing a different
 * failure from the card beside it. Same rule, same instant, different jobs.
 *
 * 🔴 NO PROSE. Three earlier attempts classified by substring —
 * `insufficient|not enough|budget|balance`, then `rate|too many|velocity|limit`
 * — and each was wrong on ordinary words: `rate` sits inside `geneRATEd` and
 * `modeRATEd`, and `balance` inside the Prisma constraint name
 * `accountBalance`. A substring can always be spelled by accident. Nothing
 * below reads `snap.error`.
 *
 * 🔴 AND "PRICED + FAILED" IS NOT ENOUGH ON ITS OWN — that was round 4's bug.
 * The SDK is explicit that the priced-refusal family is WIDER than
 * affordability: "the per-app velocity limit, the per-app aggregate daily cap,
 * a fail-closed 'temporarily unavailable' deny and a missing price quote are
 * all priced, resolving outcomes too" (`useBuzzWorkflow` docstring). So is the
 * per-call `token.buzzBudget` gate, whose refusal "comes back as a `failed`
 * snapshot naming both numbers" (`WorkflowBodyCustomComfyRecipe.maxBuzz`). And
 * so, in practice, is an ordinary job that was queued, CHARGED, and then failed
 * mid-render — `poll()` publishes that snapshot with a numeric `cost.total`
 * onto the hook's shared `result`, which is what the CTA reads. Offering to
 * sell Buzz for any of those is selling a fix that cannot work.
 *
 * 🔴 AND THE ARITHMETIC ALONE IS NOT ENOUGH EITHER — that was round 6's F1, and
 * it is why the FIRST clause below is about the job's LIFECYCLE, not its money.
 * A refusal is a job that NEVER STARTED. A submit that replies with any
 * non-`failed` status was accepted and FUNDED: the SDK's server-side comment is
 * "A resolved submit is money-COMMITTED (the reservation is kept regardless of
 * snapshot status)… we do NOT refund on a non-throwing failed snapshot". So
 * every later `failed` such a job reports — every one that reaches this
 * function through the poll loop — is an EXECUTION failure, and it can never be
 * an affordability refusal no matter what the price is or what the balance
 * says. The host's affordability and cap gates all run BEFORE the workflow is
 * forwarded, so there is no path by which an accepted job is later refused for
 * money.
 *
 * That clause is what makes the balance's TIMING stop mattering. Reading a
 * balance against a charged-and-then-failed job was comparing the price of a
 * generation to the wallet it had just emptied — arithmetic that says "short"
 * for every viewer whose balance was under twice the price, and offers to sell
 * them Buzz for a moderation rejection they have already paid for.
 *
 * Note what it does NOT scope out, and why it is not round 3's
 * `phase === 'submit'` returning: a refused ESTIMATE never started either, so
 * it stays eligible. The discriminator is acceptance, not phase.
 *
 * The remaining clauses are arithmetic: a refusal is a shortfall only when the
 * viewer's spendable balance does NOT cover the price the server quoted. If the
 * balance already covers it, affordability is not what went wrong, whatever
 * else did.
 *
 * Second structural clause, same logic one level up: the host gates
 * `cost_estimate <= token.buzzBudget` before forwarding to the orchestrator, so
 * a price ABOVE that ceiling was refused by the token's own budget claim. Buzz
 * bought today does not raise a claim minted at block load, so that is not
 * top-up-fixable either.
 *
 * 🔴 FAIL TOWARD NOT-A-SHORTFALL. With no known balance the answer is `false`,
 * not `true`: the failure mode of a wrong `false` is an unhelpful error message,
 * the failure mode of a wrong `true` is charging someone for a problem money
 * cannot solve. Never treat "unknown" as "short".
 */
function isSpendLimitRefusal(
  snap: { status?: string; cost?: { total?: number | null } | null } | null | undefined,
  spend: SpendContext,
  lifecycle: JobLifecycle
): boolean {
  // 🔴 FIRST, AND STRUCTURAL: an accepted workflow was funded. Whatever killed
  // it later, money was not the obstacle — the money was already taken. See the
  // 🔴 above; this is the clause that closes round 6's F1.
  if (lifecycle.accepted) return false;
  if (snap?.status !== 'failed') return false;
  const price = snap.cost?.total;
  // Unpriced failures are not refusals at all — blocks-react rejects those
  // rather than resolving them, and an unpriced snapshot names no sum to compare.
  if (typeof price !== 'number') return false;
  // Above the token's own per-call ceiling => the host's budget gate refused it,
  // not the viewer's wallet. Topping up cannot raise a JWT claim.
  if (typeof spend.budgetCap === 'number' && price > spend.budgetCap) return false;
  // Unknown balance => not a shortfall. See the 🔴 above.
  if (!spend.balance) return false;
  const spendable = spend.balance.blue + spend.balance.green + spend.balance.yellow;
  return spendable < price;
}

/**
 * Map a resolved failure to viewer copy AND put the server's own words on the
 * developer channel. One call so the two cannot drift apart — the bug being
 * closed here is exactly that the mapping shipped without the log.
 */
function logAndMapFailure(
  snap: { status?: string; error?: string | null; cost?: { total?: number | null } | null },
  phase: 'submit' | 'poll',
  refused: boolean,
  ctx: Record<string, unknown>
): string {
  // eslint-disable-next-line no-console
  console.warn('[gfm] workflow failed', {
    ...ctx,
    phase,
    status: snap.status,
    // Developer channel only. Never rendered — see viewerFailureText.
    serverReason: snap.error,
  });
  return viewerFailureText(refused);
}

/**
 * Viewer-facing text for a RESOLVED failure snapshot.
 *
 * 🔴 `snapshot.error` is SERVER-AUTHORED AND UNSANITISED — the SDK documents it
 * as carrying raw Prisma/pg column and constraint names — so it is logged by
 * the caller and never rendered.
 *
 * 🔴 IT NO LONGER CLASSIFIES ANYTHING — it takes the ANSWER. It used to call
 * `isSpendLimitRefusal` itself, which meant the card and the CTA each ran the
 * rule over inputs read at different moments; identical rule, different
 * instants, visibly different screens (round 6's F2). The caller classifies
 * once and both consumers render that one boolean.
 *
 * It takes NO `phase` either. A phase-scoped card next to a phase-blind CTA is
 * how round 3 put "failed" and "buy Buzz" on the same screen. One rule.
 *
 * Everything that is not a balance shortfall gets one neutral sentence. The
 * resolved snapshot carries no structured refusal code, and `snap.error` is the
 * server's own unsanitised text, so there is nothing else honest to say —
 * guessing at that free text is what three rounds were spent undoing.
 */
function viewerFailureText(refused: boolean): string {
  if (refused) {
    return 'This generation hit a Buzz spend limit.';
  }
  return 'This generation failed.';
}
/**
 * Loading skeleton matching the block's eventual layout — header line +
 * checkpoint row + primary CTA. Subtle shimmer animation so the user
 * gets a "something's coming" signal during the BLOCK_INIT round-trip.
 *
 * Mirrored statically in index.html so it is on screen before this bundle
 * loads; `src/__tests__/boot-skeleton.test.tsx` pins the two together.
 */
function LoadingSkeleton({ theme }: { theme: string | null }) {
  const bar = (w: string, h = 14): CSSProperties => ({
    width: w,
    height: h,
    borderRadius: 4,
    background:
      theme === 'dark'
        ? 'linear-gradient(90deg, #1A1B1E 0%, #25262B 50%, #1A1B1E 100%)'
        : 'linear-gradient(90deg, #e9ecef 0%, #f1f3f5 50%, #e9ecef 100%)',
    backgroundSize: '200% 100%',
    animation: 'gfm-shimmer 1.4s ease-in-out infinite',
  });
  return (
    <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={bar('60%', 18)} />
      <div style={bar('40%', 12)} />
      <div style={{ ...bar('100%', 30), marginTop: 6 }} />
      <div style={{ ...bar('100%', 40), marginTop: 10 }} />
    </div>
  );
}

/**
 * Tier-4 Delta C: 16×16 lightning-bolt glyph rendered inline as SVG.
 * Visually anchors the Generate / Top-Up buttons to the Buzz currency
 * (Buzz uses a bolt as its mark on Civitai). currentColor + 16×16
 * intrinsic so the parent button's text color drives the fill and the
 * glyph aligns with the 14px label text.
 *
 * Inline SVG (vs pulling @tabler/icons-react) keeps the dependency tree
 * flat — this block is a single-file UI, no icon lib for one glyph.
 * Path is the canonical Tabler Bolt: M13 3L4 14h7l-1 7l9-11h-7l1-7z.
 */
function BoltIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', display: 'inline-block', verticalAlign: 'middle' }}
    >
      <path d="M13 3L4 14h7l-1 7l9-11h-7l1-7z" />
    </svg>
  );
}

/**
 * Full-size image viewer. A dark overlay that covers the block (the
 * iframe sandbox — `allow-scripts allow-forms` — has no popups and the
 * SDK has no host "open image" message, so the viewer lives in-frame).
 * Click the backdrop or press Escape to close; the image itself is a
 * click-trap so clicking it doesn't dismiss. `position: fixed` pins to
 * the iframe viewport, so the overlay covers the block's rendered area.
 */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Full size image"
      onClick={onClose}
      className="gfm-fade-in"
      style={lightboxBackdropStyle}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image viewer"
        title="Close"
        style={lightboxCloseStyle}
      >
        ×
      </button>
      <img
        src={url}
        alt="Generated image, full size"
        onClick={(e) => e.stopPropagation()}
        style={lightboxImageStyle}
      />
    </div>
  );
}

/**
 * The Generate / Re-generate / Submitting / Generating button label.
 * Renders `{verb} · {cost} ⚡` when a cost is known, or
 * `{verb} (≤ {budget} ⚡)` as a fallback. The "Buzz" word is gone —
 * the bolt icon IS the Buzz indicator.
 */
function ButtonLabel({ label }: { label: ButtonLabelInfo }) {
  if (label.cost == null) {
    return <span>{label.verb}</span>;
  }
  if (label.isFallback) {
    return (
      <span>
        {label.verb} (≤ {label.cost} <BoltIcon />)
      </span>
    );
  }
  return (
    <>
      <span>{label.verb}{' · '}{label.cost}</span>
      <BoltIcon />
    </>
  );
}

/**
 * Tier-4 Delta B: 16×16 download arrow for the per-result icon button on
 * each carousel card. currentColor again — the icon button styles the
 * color (subtle by default, brand on hover).
 */
function DownloadIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <polyline points="7 11 12 16 17 11" />
      <line x1="12" y1="4" x2="12" y2="16" />
    </svg>
  );
}

/** Plain X — cancel an in-flight slot / dismiss a terminal one. */
function CloseIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

/**
 * 6px brand-color dot with a quiet opacity pulse — used to signal active
 * busy states (estimating / submitting / polling) without an explicit
 * spinner. Subtle enough to live next to or inside the primary CTA.
 */
function Pulse() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: 999,
        background: 'currentColor',
        animation: 'gfm-pulse 1.4s ease-in-out infinite',
      }}
    />
  );
}

// --------- design tokens ---------

// Civitai brand blue. Brand blue is reserved for the host page's primary
// "Create" CTA and for our own non-CTA affordances (focus rings, inline
// link buttons). The Generate / Top-Up buttons used to share this brand
// blue, which made them compete visually with the host page's main
// action — Tier-4 Delta C moves them to a Buzz-spend amber instead.
const BRAND = '#1971C2';
const BRAND_HOVER = '#1864AB';
const BRAND_LIGHT_DARK = '#4DABF7'; // blue[4] — readable on dark surfaces
const FOCUS_RING = 'rgba(25, 113, 194, 0.35)';

// Tier-4 Delta C: Buzz-spend amber palette. The Generate button label
// already reads "Generate · 34 Buzz" — pairing it with the Buzz currency
// color ties the affordance to the spend in a way blue couldn't. Mantine
// yellow[6/7/8] for base/hover/active. Text color #5C3B00 (dark brown)
// passes WCAG AA on amber (≈5.6:1 contrast).
const CTA = '#FAB005'; // yellow[6] — base amber
const CTA_HOVER = '#F59F00'; // yellow[7]
const CTA_ACTIVE = '#F08C00'; // yellow[8]
const CTA_TEXT = '#5C3B00'; // dark brown — ≥4.5:1 contrast on the amber
const CTA_GLOW_LIGHT = '0 4px 14px rgba(250, 176, 5, 0.35)';
const CTA_GLOW_LIGHT_HOVER = '0 6px 20px rgba(250, 176, 5, 0.45)';
const CTA_GLOW_DARK = '0 4px 14px rgba(250, 176, 5, 0.45)';
const CTA_GLOW_DARK_HOVER = '0 6px 20px rgba(250, 176, 5, 0.55)';
const CTA_FOCUS_RING = 'rgba(250, 176, 5, 0.45)';

// Tier-3 #9: ceiling for the auto-growing prompt textarea. ~5 lines of
// the 14px base font with the default line-height keeps it bounded so
// runaway pastes don't blow out the iframe.
const MAX_PROMPT_HEIGHT = 120;

// Tier-4 Delta B: cap on accumulated past-results before FIFO eviction.
// Each card is ~240×360px; 8 keeps the carousel scroll length tractable
// AND keeps the in-memory snapshot array bounded so a long-running
// session can't grow unbounded.
const MAX_RESULTS = 8;

// --------- styles (inline; the block root sets data-theme={theme} so the
// `[data-theme="dark"]` rules below — carousel fade, button/link/icon hovers —
// actually match. The iframe is a separate document, so the HOST cannot inject
// data-theme into it; the rootRef divs set it themselves.) ---------

// The container is the block's content SURFACE only — background + text
// colour. It deliberately draws NO border / radius / shadow: the host
// (civitai-web's `AppBlockChrome`) now renders the trust frame AROUND the
// iframe (bordered box + "App block" badge), so a border drawn here just
// doubles it. The frame belongs at the host layer, not inside the block.
//
// Tier-4 Delta A: split into an outer (rootRef-bound) and an inner
// (padded layout) wrapper. The SDK's `useBlockResize` reads
// `ResizeObserverEntry.contentRect.height`, which is the CONTENT-box of
// the observed element — so any padding on rootRef gets silently shaved
// off the reported height (the iframe stays ~32px short of what the
// content actually wants). Moving the padding onto a non-observed inner
// element makes the outer's content-box equal the full visual layout.
//
// `box-sizing: border-box` is set defensively so any future width/height
// constraints behave predictably.
const outerContainerStyle = (theme: string | null): CSSProperties => ({
  boxSizing: 'border-box',
  display: 'block',
  // Match host font stack — same list Civitai uses in tailwind.config.js.
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: theme === 'dark' ? '#C1C2C5' : '#222222',
  background: theme === 'dark' ? '#1a1b1e' : '#ffffff',
  // No border / borderRadius / boxShadow — the host frame owns the chrome.
  // Important: do NOT set padding here. See Delta A note above.
});

const innerContainerStyle = (): CSSProperties => ({
  boxSizing: 'border-box',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
});

// Tier-3 #1, #2, #3: header is title + three-dots action button on the
// same row. Subtitle (model name + chip) is gone.
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 0,
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  lineHeight: 1.25,
};

// Tier-3 #3: three-dots advanced toggle. 32×32 hit area, icon centered,
// subtle hover tint. Pressed state uses the brand color to read as
// "active" since it's controlling the collapse of the Advanced section.
const dotsButtonStyle = (active: boolean, theme: string | null): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: 6,
  border: '1px solid transparent',
  background: active
    ? theme === 'dark'
      ? 'rgba(34, 139, 230, 0.18)'
      : 'rgba(34, 139, 230, 0.12)'
    : 'transparent',
  color: active
    ? theme === 'dark'
      ? BRAND_LIGHT_DARK
      : BRAND
    : 'inherit',
  cursor: 'pointer',
  transition: 'background-color 140ms ease-out, color 140ms ease-out, opacity 140ms ease-out',
  // Brand outline on the active state so it reads as toggled-on without
  // shouting.
  borderColor: active
    ? theme === 'dark'
      ? 'rgba(77, 171, 247, 0.32)'
      : 'rgba(34, 139, 230, 0.28)'
    : 'transparent',
});

const checkpointRowStyle = (theme: string | null): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 6,
  background: theme === 'dark' ? '#25262B' : '#f1f3f5',
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#e9ecef'}`,
  fontSize: 13,
});

// Tier-2 #9: horizontally-scrollable single-row carousel. The wrapper
// holds a soft right-edge fade affordance (rendered via the CSS pseudo
// in STYLESHEET_CSS) so the user gets a visual hint that more thumbs
// are off-screen when the container is narrow.
const carouselWrapStyle = (_theme: string | null): CSSProperties => ({
  position: 'relative',
  // The fade pseudo-element overflows above the scroll layer; keep this
  // wrapper from clipping it.
  overflow: 'visible',
});

const carouselStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'nowrap',
  overflowX: 'auto',
  overflowY: 'hidden',
  // Extra room around thumbs so the :hover scale(1.04) doesn't clip
  // against the scroll container edges.
  padding: '4px 2px',
  // Scroll snap is a quiet polish on touch — desktop wheel scroll
  // ignores it, but on iOS/Android the thumb settles on a card.
  scrollSnapType: 'x proximity',
};

// Tier-3 #6, #7: bigger thumb (was 56×56) + slightly larger radius. The
// showcase carousel is the most-clicked surface, so paying vertical
// space for it is worth it. Thumbs share a fixed height (THUMB_H) so
// the row aligns; width varies with the source aspect ratio so each
// thumb shows the image in its true proportions — no cropping. The
// button gets `aspect-ratio` from the showcase data so the row reserves
// the correct width BEFORE the image loads (prevents layout shift).
const THUMB_H = 96;
const thumbButtonStyle = (
  selected: boolean,
  theme: string | null,
  img: ShowcaseImage
): CSSProperties => {
  const w = img.width && img.width > 0 ? img.width : 1;
  const h = img.height && img.height > 0 ? img.height : 1;
  return {
    padding: 0,
    border: `2px solid ${selected ? BRAND : theme === 'dark' ? '#373A40' : '#dee2e6'}`,
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    overflow: 'hidden',
    transition: 'border-color 160ms ease-out, transform 160ms ease-out, box-shadow 160ms ease-out',
    boxShadow: selected ? `0 0 0 3px ${FOCUS_RING}` : 'none',
    flex: '0 0 auto',
    scrollSnapAlign: 'center',
    height: THUMB_H,
    // Reserve width based on the source aspect ratio so the row
    // doesn't reflow when images finish loading.
    aspectRatio: `${w} / ${h}`,
  };
};

const thumbImageStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  width: '100%',
  objectFit: 'cover',
};

const subtleStyle: CSSProperties = {
  opacity: 0.7,
  fontSize: 13,
  margin: 0,
};

// Section label above the showcase carousel + prompt textarea. Small,
// subtle, slightly tracked — feels like a form-field label, not a
// heading. Used as both a `<p>` (for aria-labelledby on the carousel
// radiogroup) and a `<label>` (for the textarea's htmlFor binding).
const sectionLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  opacity: 0.65,
  margin: '0 0 6px 0',
};

const errorTextStyle: CSSProperties = {
  margin: 0,
  color: '#f03e3e', // Mantine red[7]
  fontSize: 14,
};

const inputStyle = (theme: string | null): CSSProperties => ({
  padding: '8px 12px',
  borderRadius: 6,
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#ced4da'}`,
  background: theme === 'dark' ? '#25262B' : '#ffffff',
  color: 'inherit',
  fontSize: 14,
  outline: 'none',
  transition: 'border-color 140ms ease-out, box-shadow 140ms ease-out',
});

// Tier-3 #9: the prompt textarea. Same focus ring as the legacy input
// (shared `gfm-input` className), plus row-2 default + max-height cap +
// no manual resize handle. `field-sizing: content` is the CSS-native
// auto-grow path; the JS effect inside PromptTextarea is the fallback.
const textareaStyle = (theme: string | null): CSSProperties => ({
  ...inputStyle(theme),
  // `field-sizing` is honored by modern Chromium + Safari TP — browsers
  // that don't recognize it ignore it and the JS effect kicks in. Cast
  // because React's CSSProperties doesn't model it yet.
  ...({ fieldSizing: 'content' } as CSSProperties),
  resize: 'none',
  minHeight: 56,
  maxHeight: MAX_PROMPT_HEIGHT,
  overflowY: 'auto',
  fontFamily: 'inherit',
  lineHeight: 1.4,
});

// Tier-3 #5 + Tier-4 Delta C: bold primary CTA, now Buzz-spend amber so
// it visually pairs with the cost in the label and stops competing with
// the host page's brand-blue "Create" button. Text is dark brown
// (CTA_TEXT) which clears WCAG AA on amber. Hover/active behavior
// (translate, shadow grow, deeper amber) lives in the CSS stylesheet
// since :hover can't be inlined.
const primaryButtonStyle = (busy: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '12px 16px',
  borderRadius: 8,
  background: CTA,
  color: CTA_TEXT,
  fontSize: 14,
  fontWeight: 700,
  border: 'none',
  cursor: busy ? 'progress' : 'pointer',
  // box-shadow + transform on hover handled in CSS. Keep transition on
  // inline style so the easing applies even when CSS isn't loaded yet.
  transition:
    'background-color 140ms ease-out, transform 140ms ease-out, box-shadow 140ms ease-out, opacity 140ms ease-out',
  opacity: busy ? 0.85 : 1,
  // Base glow — the hover state grows it via CSS. Use the light-theme
  // value as the default; `data-theme="dark"` CSS rule overrides.
  boxShadow: CTA_GLOW_LIGHT,
});

const linkButtonStyle = (): CSSProperties => ({
  background: 'transparent',
  border: 'none',
  color: BRAND,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  padding: 0,
  transition: 'color 140ms ease-out, opacity 140ms ease-out',
});

const errorBoxStyle = (theme: string | null): CSSProperties => ({
  padding: 12,
  borderRadius: 6,
  background: theme === 'dark' ? 'rgba(224, 49, 49, 0.12)' : '#fff5f5',
  color: theme === 'dark' ? '#ffa8a8' : '#c92a2a',
  border: `1px solid ${theme === 'dark' ? 'rgba(224, 49, 49, 0.4)' : '#ffc9c9'}`,
  fontSize: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

// (insufficientBoxStyle + insufficientCopyStyle removed v0.2.5 —
// proactive top-up CTA replaces the boxed surface; explanatory copy
// now lives inline below the primary button.)

// Tier-4 Delta B: horizontal-scrolling carousel for past results.
// Shares the `gfm-carousel` className with the showcase thumbs row so
// the scrollbar-hiding + soft-fade-on-right CSS applies for free.
// Cards laid out flex-nowrap so the user gets a clear "more →" hint
// without an explicit affordance.
const resultsCarouselStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'nowrap',
  overflowX: 'auto',
  overflowY: 'hidden',
  padding: '4px 2px',
  scrollSnapType: 'x proximity',
};

// Per-card container: fixed 240px width so all cards align regardless of
// aspect ratio. The image flexes inside the card's max-height cap; the
// footer (spent buzz + download) is a single row below.
const resultCardStyle = (theme: string | null): CSSProperties => ({
  flex: '0 0 240px',
  width: 240,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  borderRadius: 10,
  background: theme === 'dark' ? '#1A1B1E' : '#ffffff',
  border: `1px solid ${theme === 'dark' ? '#2C2E33' : '#e9ecef'}`,
  boxShadow:
    theme === 'dark'
      ? '0 1px 3px rgba(0, 0, 0, 0.35)'
      : '0 1px 3px rgba(0, 0, 0, 0.06)',
  scrollSnapAlign: 'start',
});

// Image cap inside a card. 320px lets several cards fit on screen at
// once so the comparison is meaningful — bigger and the user only sees
// one card at a time, defeating the carousel.
const resultCardImageStyle = (_theme: string | null): CSSProperties => ({
  maxWidth: '100%',
  maxHeight: 320,
  width: '100%',
  height: 'auto',
  objectFit: 'contain',
  borderRadius: 8,
  display: 'block',
  background: 'transparent',
});

// Reset wrapper so the result thumbnail reads as a button (keyboard +
// pointer "open full size") without inheriting the UA button chrome.
const resultImageButtonStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'zoom-in',
  borderRadius: 8,
};

const lightboxBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'rgba(0, 0, 0, 0.85)',
  cursor: 'zoom-out',
};

const lightboxImageStyle: CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  width: 'auto',
  height: 'auto',
  objectFit: 'contain',
  borderRadius: 8,
  cursor: 'default',
  boxShadow: '0 8px 40px rgba(0, 0, 0, 0.5)',
};

const lightboxCloseStyle: CSSProperties = {
  position: 'fixed',
  top: 12,
  right: 16,
  zIndex: 1001,
  width: 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 24,
  lineHeight: 1,
  color: '#fff',
  background: 'rgba(0, 0, 0, 0.5)',
  border: '1px solid rgba(255, 255, 255, 0.3)',
  borderRadius: '50%',
  cursor: 'pointer',
};

// Footer row inside a card: spent-buzz line on the left, compact icon
// Download button on the right.
const resultCardFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 2,
};

// Header row inside a queue card: status badge on the left, a compact
// cancel/dismiss (X) button pinned to the right.
const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 28,
};

// Badge color triplet (fg / bg / border) per status tone, theme-aware.
// Tracks the on-site generator's status colors (Mantine yellow/green/red/
// gray) translated to the block's inline-style surfaces.
function statusBadgeColors(
  tone: StatusTone,
  theme: string | null
): { fg: string; bg: string; border: string } {
  const dark = theme === 'dark';
  switch (tone) {
    case 'busy':
      return dark
        ? { fg: '#FFD43B', bg: 'rgba(250, 176, 5, 0.14)', border: 'rgba(250, 176, 5, 0.30)' }
        : { fg: '#9C6A00', bg: '#FFF3BF', border: '#FFE08A' };
    case 'success':
      return dark
        ? { fg: '#69DB7C', bg: 'rgba(64, 192, 87, 0.14)', border: 'rgba(64, 192, 87, 0.30)' }
        : { fg: '#2B8A3E', bg: '#EBFBEE', border: '#B2F2BB' };
    case 'error':
      return dark
        ? { fg: '#FFA8A8', bg: 'rgba(224, 49, 49, 0.14)', border: 'rgba(224, 49, 49, 0.32)' }
        : { fg: '#C92A2A', bg: '#FFF5F5', border: '#FFC9C9' };
    case 'neutral':
    default:
      return dark
        ? { fg: '#909296', bg: 'rgba(134, 142, 150, 0.14)', border: '#373A40' }
        : { fg: '#868E96', bg: '#F1F3F5', border: '#DEE2E6' };
  }
}

// 28×28 ghost icon button. Subtle by default, brand-tinted on hover.
const iconButtonStyle = (theme: string | null): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: theme === 'dark' ? '#C1C2C5' : '#495057',
  cursor: 'pointer',
  transition:
    'background-color 140ms ease-out, color 140ms ease-out, border-color 140ms ease-out',
});

const advancedWrapperStyle = (theme: string | null): CSSProperties => ({
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#e9ecef'}`,
  borderRadius: 8,
  background: theme === 'dark' ? '#141517' : '#f8f9fa',
  overflow: 'hidden',
});

// Smooth max-height collapse. 600px is a generous cap — the body is
// always shorter in practice. height: auto can't be transitioned, so the
// cap is the trade-off cost. Tier-3: the section no longer has an
// inline toggle row; the wrapper itself collapses to 0 when closed.
const advancedCollapseStyle = (open: boolean): CSSProperties => ({
  maxHeight: open ? 600 : 0,
  opacity: open ? 1 : 0,
  overflow: 'hidden',
  transition: 'max-height 200ms ease-out, opacity 160ms ease-out',
  // Tier-3 #8: keep the collapsed section from taking ANY vertical
  // space (including the parent's flex gap). margin-bottom 0 when
  // closed; otherwise let the parent gap apply normally.
  marginBottom: open ? 0 : -8,
});

const advancedBodyStyle = (theme: string | null): CSSProperties => ({
  padding: '10px 12px 12px',
  borderTop: `1px solid ${theme === 'dark' ? '#25262B' : '#e9ecef'}`,
});

const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const chipStyle = (theme: string | null): CSSProperties => ({
  padding: '3px 9px',
  borderRadius: 999,
  background: theme === 'dark' ? '#25262B' : '#e9ecef',
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#dee2e6'}`,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
});

const editableGridStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const twoColStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  fontWeight: 500,
  opacity: 0.85,
};

// Subtle dashed-border debug row for the "Simulate 0 Buzz" toggle.
// Visually distinct from real product affordances so it reads as a
// dev/test thing, not a feature a publisher would ship.
const debugRowStyle = (theme: string | null): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px dashed ${theme === 'dark' ? '#373A40' : '#dee2e6'}`,
  background: 'transparent',
  opacity: 0.75,
  fontSize: 12,
  cursor: 'pointer',
  userSelect: 'none',
});

const diceButtonStyle = (active: boolean, theme: string | null): CSSProperties => ({
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px solid ${active ? BRAND : theme === 'dark' ? '#373A40' : '#ced4da'}`,
  background: active ? BRAND : 'transparent',
  color: active ? '#ffffff' : 'inherit',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out',
});

// --------- stylesheet rules (hover/focus/keyframes) ---------
// Inline styles can't express :hover / :focus-visible / keyframes. The
// rest of the visual language lives here. Selectors are scoped via the
// gfm- prefix so we don't accidentally bleed onto host page styles —
// the iframe sandbox already isolates us, but the prefix is belt-and-
// braces hygiene.
const STYLESHEET_CSS = `
@keyframes gfm-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes gfm-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@keyframes gfm-fade-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}

.gfm-fade-in { animation: gfm-fade-in 240ms ease-out both; }
.gfm-fade-in img { animation: gfm-fade-in 280ms ease-out both; }

/* Tier-3 #5: brighter brand CTA with a glow shadow. Hover grows the
   glow + lifts; active sinks, no translate. Glow intensity differs per
   theme so the button doesn't bleed light into a dark surface. */
.gfm-primary:not(:disabled):hover {
  background-color: ${CTA_HOVER};
  transform: translateY(-1px);
  box-shadow: ${CTA_GLOW_LIGHT_HOVER};
}
[data-theme="dark"] .gfm-primary:not(:disabled) {
  box-shadow: ${CTA_GLOW_DARK};
}
[data-theme="dark"] .gfm-primary:not(:disabled):hover {
  box-shadow: ${CTA_GLOW_DARK_HOVER};
}
.gfm-primary:not(:disabled):active {
  background-color: ${CTA_ACTIVE};
  transform: translateY(0);
  box-shadow: ${CTA_GLOW_LIGHT};
}
[data-theme="dark"] .gfm-primary:not(:disabled):active {
  box-shadow: ${CTA_GLOW_DARK};
}
.gfm-primary:disabled {
  cursor: not-allowed;
  opacity: 0.78;
}
/* Tier-4 Delta C: focus ring is amber-tinted to match the button. The
   blue FOCUS_RING would clash with the gold fill; CTA_FOCUS_RING shares
   the button's hue so the affordance reads as one element. */
.gfm-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${CTA_FOCUS_RING}, ${CTA_GLOW_LIGHT};
}
[data-theme="dark"] .gfm-primary:focus-visible {
  box-shadow: 0 0 0 3px ${CTA_FOCUS_RING}, ${CTA_GLOW_DARK};
}

/* Tier-3 #3: three-dots advanced toggle. Subtle hover tint so the
   affordance reads as interactive; active state (when Advanced is
   open) is handled inline via dotsButtonStyle so the brand color
   doesn't depend on the stylesheet loading. */
.gfm-dots-btn:not(:disabled):hover {
  background-color: rgba(125, 125, 125, 0.08);
}
[data-theme="dark"] .gfm-dots-btn:not(:disabled):hover {
  background-color: rgba(255, 255, 255, 0.06);
}
.gfm-dots-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
}
.gfm-dots-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Carousel thumbs — gentle scale + brightness on hover. */
.gfm-thumb:not(:disabled):hover {
  transform: scale(1.04);
  filter: brightness(1.06);
}
.gfm-thumb:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
}
.gfm-thumb:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* Tier-2 #9: hide the scrollbar on the horizontally-scrollable
   carousel. Keyboard / wheel scroll still work, the row stays one
   line. The wrap element holds a soft fade on the right edge so the
   user sees "more thumbs that way" without a scrollbar gutter. */
.gfm-carousel {
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE/Edge legacy */
}
.gfm-carousel::-webkit-scrollbar {
  display: none; /* Blink/WebKit */
}
.gfm-carousel-wrap::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 24px;
  pointer-events: none;
  background: linear-gradient(to right, rgba(254, 254, 254, 0), rgba(254, 254, 254, 0.9));
  border-radius: 0 6px 6px 0;
  opacity: 0.8;
}
[data-theme="dark"] .gfm-carousel-wrap::after {
  background: linear-gradient(to right, rgba(26, 27, 30, 0), rgba(26, 27, 30, 0.95));
}

/* Inputs — brand focus ring matching the host's Mantine inputs. */
.gfm-input:focus,
.gfm-input:focus-visible {
  border-color: ${BRAND} !important;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
}

/* Inline-link button — hover darkens, underline only on hover so it
   doesn't read as a footer-link by default. */
.gfm-link:not(:disabled):hover {
  color: ${BRAND_HOVER};
  text-decoration: underline;
}
[data-theme="dark"] .gfm-link:not(:disabled):hover {
  color: ${BRAND_LIGHT_DARK};
}
.gfm-link:focus-visible {
  outline: none;
  border-radius: 2px;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
}
.gfm-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Tier-4 Delta B: per-card Download icon button. Ghost by default —
   tints to brand on hover so the user gets a positive affordance signal
   without competing with the gold Generate button for attention. */
.gfm-icon-btn:not(:disabled):hover {
  background-color: rgba(125, 125, 125, 0.08);
  color: ${BRAND};
}
[data-theme="dark"] .gfm-icon-btn:not(:disabled):hover {
  background-color: rgba(255, 255, 255, 0.06);
  color: ${BRAND_LIGHT_DARK};
}
.gfm-icon-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
}
.gfm-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (prefers-reduced-motion: reduce) {
  /* Respect user accessibility preference — host theme also sets this. */
  .gfm-fade-in,
  .gfm-fade-in img,
  .gfm-thumb,
  .gfm-primary,
  .gfm-input,
  .gfm-dots-btn,
  .gfm-icon-btn {
    animation: none !important;
    transition: none !important;
  }
  /* Tier-3 #5 + Tier-4 Delta C: the primary CTA's hover transform is the
     loudest part of the motion budget — kill the lift + the shadow growth,
     keep the color shift since color isn't motion. */
  .gfm-primary:not(:disabled):hover,
  .gfm-primary:not(:disabled):active {
    transform: none !important;
    box-shadow: none !important;
  }
}
`;

