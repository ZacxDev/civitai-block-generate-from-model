import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockSettings,
  useBuzzPurchase,
  useBuzzWorkflow,
  useCheckpointPicker,
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

export function App() {
  const { ready, context, viewer, theme, blockInstanceId } = useBlockContext();
  const settings = useBlockSettings();
  const { submit, estimate, poll, cancel, status, result, error } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  const checkpointPicker = useCheckpointPicker();
  // Latest poll fn in a ref so the per-job poll loops (started inside
  // handleGenerate, which closes over the submit-time `poll`) always call
  // the current hook instance without re-subscribing.
  const pollRef = useRef(poll);
  pollRef.current = poll;
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
          patchJob(localId, {
            status: snap.status as QueueJobStatus,
            cost: snap.cost?.total ?? null,
            imageUrls: snap.imageUrls ?? [],
            ...(snap.error ? { error: snap.error } : {}),
          });
          if (JOB_TERMINAL.has(snap.status as QueueJobStatus)) {
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
        // A host-side estimate FAILURE comes back as a RESOLVED snapshot with
        // status 'failed' + an error message — the host stamps a non-empty
        // workflowId sentinel so the SDK validator DELIVERS it (an empty
        // workflowId is dropped by the validator, which used to hang this
        // request to the 120s transport timeout and leave the CTA stuck on its
        // budget fallback with no explanation). The transport itself only
        // rejects on timeout, so a failed estimate lands HERE, not in .catch.
        if (snap.status === 'failed' || typeof snap.error === 'string') {
          // eslint-disable-next-line no-console
          console.warn('[gfm] estimate failed', { attempt: myId, error: snap.error });
          setEstimateError(snap.error ?? 'estimate failed');
          setEstimatedCost(null);
          return;
        }
        const cost = snap.cost?.total;
        // eslint-disable-next-line no-console
        console.debug('[gfm] estimate resolved', { attempt: myId, cost });
        setEstimatedCost(typeof cost === 'number' ? cost : null);
        setEstimateError(null);
      })
      .catch((err) => {
        if (myId !== estimateInFlightRef.current) return;
        // eslint-disable-next-line no-console
        console.warn('[gfm] estimate rejected', { attempt: myId, err: String(err) });
        setEstimateError(err instanceof Error ? err.message : 'estimate failed');
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
    return (
      <div ref={rootRef} style={outerContainerStyle(theme)}>
        <div style={innerContainerStyle()}>
          <StyleSheet />
          <LoadingSkeleton theme={theme} />
        </div>
      </div>
    );
  }

  const model = asModelContext(context);
  if (!model) {
    return (
      <div ref={rootRef} style={outerContainerStyle(theme)}>
        <div style={innerContainerStyle()}>
          <p style={errorTextStyle}>
            This block expects a model-page slot. Current slot: <code>{context.slotId}</code>
          </p>
        </div>
      </div>
    );
  }

  if (!viewer) {
    return (
      <div ref={rootRef} style={outerContainerStyle(theme)}>
        <div style={innerContainerStyle()}>
          <Header
            theme={theme}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
            isBusy={true}
          />
          <p style={subtleStyle}>Sign in to generate.</p>
        </div>
      </div>
    );
  }

  if (viewer.status === 'banned' || viewer.status === 'muted') {
    return (
      <div ref={rootRef} style={outerContainerStyle(theme)}>
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
    // Debug short-circuit: when "Simulate 0 Buzz" is checked, skip the
    // real submit and synthesize the insufficient-Buzz state. The
    // existing error block renders the top-up CTA, which still opens
    // the real purchase modal — full top-up flow exercised, no spend.
    if (forceZeroBuzz) {
      setSimulatedInsufficient(true);
      return;
    }
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
      // Hydrate the job with the returned workflowId + initial snapshot.
      patchJob(localId, {
        workflowId: snap.workflowId,
        status: snap.status as QueueJobStatus,
        cost: snap.cost?.total ?? estimatedCost,
        imageUrls: snap.imageUrls ?? [],
        ...(snap.error ? { error: snap.error } : {}),
      });
      // submit() does NOT auto-poll (SDK gotcha #10) — start this job's
      // own poll loop unless it already came back terminal (cached hit).
      if (!JOB_TERMINAL.has(snap.status as QueueJobStatus) && snap.workflowId) {
        runJobPollLoop(localId, snap.workflowId);
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
      patchJob(localId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'submit failed',
      });
    }
  };

  // The platform returns Buzz-budget rejection as a workflow `error` snapshot
  // or via the `error` ref. Sniff for budget/insufficient-funds language to
  // surface the top-up CTA. (No structured error.code field today.)
  const errMessage = (error?.message ?? result?.error ?? '').toLowerCase();
  const isInsufficient =
    errMessage.includes('insufficient') ||
    errMessage.includes('not enough') ||
    errMessage.includes('budget') ||
    errMessage.includes('balance');

  return (
    <div ref={rootRef} style={outerContainerStyle(theme)}>
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

          {/* Proactive top-up surface: when forceZeroBuzz is checked OR a
              previous estimate/submit hit an insufficient-buzz error, swap
              the Generate button for the Top-Up CTA so the user never has
              to click a doomed Generate to discover they're short. The
              error block below renders the EXPLANATORY copy under it. */}
          {(forceZeroBuzz || isInsufficient || simulatedInsufficient) ? (
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

        {(forceZeroBuzz || simulatedInsufficient || isInsufficient) ? (
          // Explanatory copy under the proactive Top-Up button above.
          // Distinguishes between the real "you ran out" case and the
          // debug-toggle "we're pretending you ran out" case so a tester
          // doesn't get confused about whether their balance is actually
          // affected.
          <p style={{ ...subtleStyle, fontSize: 12, marginTop: -4 }}>
            {forceZeroBuzz
              ? 'Simulate 0 Buzz is on — Generate is hidden. Uncheck the box above to run for real.'
              : 'Not enough Buzz for this generation.'}
          </p>
        ) : null}

        {(error || result?.status === 'failed' || result?.status === 'expired' || result?.status === 'canceled') && !isInsufficient && !simulatedInsufficient && (
          // Non-insufficient errors only — the insufficient path is now
          // handled proactively above the primary CTA so we don't render
          // a duplicate "Not enough Buzz" surface here.
          <div style={errorBoxStyle(theme)} role="alert">
            <p style={{ margin: 0 }}>
              {error?.message ?? result?.error ?? 'Generation failed.'}
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
 * Loading skeleton matching the block's eventual layout — header line +
 * checkpoint row + primary CTA. Subtle shimmer animation so the user
 * gets a "something's coming" signal during the BLOCK_INIT round-trip.
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

// --------- styles (inline; the host injects [data-theme]) ---------

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

