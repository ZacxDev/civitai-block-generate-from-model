import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

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
  BlockWorkflowSnapshot,
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

export function App() {
  const { ready, context, viewer, theme, blockInstanceId } = useBlockContext();
  const settings = useBlockSettings();
  const { submit, estimate, poll, status, result, error } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  const checkpointPicker = useCheckpointPicker();
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
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selected showcase image index. Drives the prompt + gen params for
  // submit/estimate. Defaults to 0 in the carousel-mount effect below
  // (deferred because BlockInit might land before showcaseImages does).
  const [selectedShowcaseIdx, setSelectedShowcaseIdx] = useState<number | null>(null);
  // Refs to the carousel scroll container + each thumb button so we can
  // auto-scroll the selected thumb into view on mount/restore. JSDOM
  // doesn't implement scrollIntoView — see effect below for the guard.
  const carouselRef = useRef<HTMLDivElement>(null);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Estimated cost (yellow buzz) for the current params. Pulled from
  // estimate() snapshot, refreshed on mount + when the model identity
  // (checkpoint or selected showcase) changes.
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const estimateInFlightRef = useRef(0);

  // useBuzzWorkflow().submit() returns the initial snapshot but the hook
  // doesn't auto-poll — it's the caller's job to drive poll(workflowId)
  // until a terminal status. Without this effect the block sits at
  // status='polling' with the initial 'pending' snapshot forever.
  //
  // The hook flips status out of 'polling' itself when a terminal-status
  // snapshot lands, so the dep array catches the transition and the
  // cleanup tears the timer down.
  useEffect(() => {
    if (status !== 'polling') return;
    const workflowId = result?.workflowId;
    if (!workflowId) return;

    // Adaptive backoff. Cached Flux returns in <10s; cold paths take
    // 30-60s. Fast initial polls catch the cached case quickly, then
    // back off so a long-running cold workflow doesn't hammer the host.
    const SCHEDULE_MS = [2000, 2000, 3000, 5000, 8000];
    let attempt = 0;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // Don't burn poll budget while the tab is hidden — the
      // visibilitychange listener re-arms when the user comes back.
      if (typeof document !== 'undefined' && document.hidden) {
        pollTimerRef.current = null;
        return;
      }
      try {
        await poll(workflowId);
      } catch {
        // Transient host/orchestrator errors during polling — keep going.
        // The hook flips status to 'error' on its own only after the
        // workflow itself reaches a terminal failure; mid-poll
        // network/5xx hiccups are recoverable.
      }
      if (cancelled) return;
      const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
      attempt += 1;
      pollTimerRef.current = setTimeout(tick, delay);
    };

    // Leading edge — fire immediately so a workflow that's already
    // succeeded by the time submit() returns gets its result on the
    // next microtask.
    pollTimerRef.current = setTimeout(tick, 0);

    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      // Resume only when no timer is armed (the tick handler nulled it
      // out when it bailed on the hidden check). Avoids double-firing
      // if the visibilitychange races with a scheduled tick.
      if (pollTimerRef.current == null) {
        pollTimerRef.current = setTimeout(tick, 0);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimerRef.current != null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [status, result?.workflowId, poll]);

  // Derive showcase/checkpoint via a partial cast so we can run the
  // mount-defaults + auto-estimate effects unconditionally above the
  // early returns. Effects can't sit below them or React will complain
  // about hook order on the !ready re-render.
  const modelCtxRead = context as Partial<ModelSlotContext>;
  const showcaseImages: ShowcaseImage[] = modelCtxRead.showcaseImages ?? [];
  const selectedShowcase =
    selectedShowcaseIdx != null ? showcaseImages[selectedShowcaseIdx] ?? null : null;
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

  // Auto-estimate on mount + whenever the model identity changes
  // (checkpoint swap, or showcase pick — both change cost via the
  // resolved params). NOT debounced on prompt edits: prompt length
  // doesn't move cost enough to be worth a round-trip per keystroke.
  useEffect(() => {
    const modelId = modelCtxRead.modelId;
    const modelVersionId = modelCtxRead.modelVersionId;
    if (!modelId || !modelVersionId) return;
    if (!effectiveCheckpointVersionIdForEstimate) return;
    // Race guard — if a faster query lands while a slower one is in
    // flight, only the latest result wins.
    const myId = ++estimateInFlightRef.current;
    estimate({
      kind: 'textToImage',
      modelId,
      modelVersionId,
      // NOTE: estimate doesn't carry randomizeSeedOnce — that's a
      // one-shot for submit only. The estimate uses the showcase's seed
      // so cost-preview stays stable while the user is reviewing.
      // Overrides DO flow through here, but the auto-estimate effect
      // intentionally doesn't re-run on overrides changes (see deps
      // below) — re-estimating on every keystroke of width/height would
      // be noisy. The shown cost can lag user edits; that's accepted.
      params: buildSubmitParams(prompt, '' /* suffix */, selectedShowcase, overrides, false),
    })
      .then((snap) => {
        if (myId !== estimateInFlightRef.current) return;
        const cost = snap.cost?.total;
        setEstimatedCost(typeof cost === 'number' ? cost : null);
        setEstimateError(null);
      })
      .catch((err) => {
        if (myId !== estimateInFlightRef.current) return;
        setEstimateError(err instanceof Error ? err.message : 'estimate failed');
        setEstimatedCost(null);
      });
    // Intentionally narrow deps: re-estimate on checkpoint OR showcase
    // change, NOT on prompt edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modelCtxRead.modelId,
    modelCtxRead.modelVersionId,
    effectiveCheckpointVersionIdForEstimate,
    selectedShowcaseIdx,
  ]);

  if (!ready) {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <StyleSheet />
        <LoadingSkeleton theme={theme} />
      </div>
    );
  }

  const model = asModelContext(context);
  if (!model) {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <p style={errorTextStyle}>
          This block expects a model-page slot. Current slot: <code>{context.slotId}</code>
        </p>
      </div>
    );
  }

  if (!viewer) {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <Header
          theme={theme}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
          isBusy={true}
        />
        <p style={subtleStyle}>Sign in to generate.</p>
      </div>
    );
  }

  if (viewer.status === 'banned' || viewer.status === 'muted') {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
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

  // `confirming` is "estimate landed, user reviewing cost" — Generate must
  // stay clickable in that state, otherwise auto-estimate on mount locks
  // the button forever. SDK transitions confirming → submitting on click.
  const busy: WorkflowStatus[] = ['estimating', 'submitting', 'polling'];
  const isBusy = busy.includes(status);

  // Tier-3 #11: Re-generate semantics. If the user already submitted for
  // THIS showcase (without switching since), the next Generate is treated
  // as "Re-generate" — auto-arm the randomize-seed-once flag for this
  // submission. The manual 🎲 button still works independently; this is
  // an additional auto-arm path, not a replacement.
  const isRegenerate =
    selectedShowcaseIdx != null && lastSubmittedShowcaseIdx === selectedShowcaseIdx;

  // Tier-3 #11a: Try-again ALWAYS randomizes the seed. The user just
  // saw the showcase's seed render; clicking "Try again" is the obvious
  // "give me a different one" affordance. Skip the React-state hop and
  // pass the flag directly to the submit path.
  const handleTryAgain = async () => {
    try {
      const params = buildSubmitParams(prompt, suffix, selectedShowcase, overrides, true);
      // Sync state with what we just did so subsequent Generate clicks
      // continue to randomize (consistent with the re-generate counter).
      if (selectedShowcaseIdx != null) {
        setLastSubmittedShowcaseIdx(selectedShowcaseIdx);
      }
      await submit({
        kind: 'textToImage',
        modelId: model.modelId,
        modelVersionId: model.modelVersionId,
        params,
      });
    } catch {
      // Same as handleGenerate — surface via `error` in render.
    }
  };

  const handleGenerate = async () => {
    try {
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
      // Reset the one-shot randomize flag after consuming it so the
      // *next* submit reverts to the showcase's seed (unless the user
      // clicks 🎲 again). Important: must run after the build call.
      if (randomizeSeedOnce) setRandomizeSeedOnce(false);
      // Mark THIS showcase as having had a Generate fired against it so
      // the next click flips to re-generate (random seed). Do this
      // before awaiting submit so the button label updates on the next
      // render (the state change is what makes "Re-generate" appear).
      if (selectedShowcaseIdx != null) {
        setLastSubmittedShowcaseIdx(selectedShowcaseIdx);
      }
      await submit({
        kind: 'textToImage',
        modelId: model.modelId,
        modelVersionId: model.modelVersionId,
        // Use the same param-builder as the estimate effect so cost shown
        // pre-click matches cost charged at submit. The host still
        // re-validates everything server-side; this is just for parity.
        params,
      });
    } catch {
      // Surface via `error` in render; nothing to do here.
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
    <div ref={rootRef} style={containerStyle(theme)}>
      <StyleSheet />
      <Header
        theme={theme}
        advancedOpen={advancedOpen}
        onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
        isBusy={isBusy}
      />

      {checkpointError && (
        <p style={errorTextStyle}>Checkpoint: {checkpointError}</p>
      )}

      {showcaseImages.length > 0 && (
        <div className="gfm-carousel-wrap" style={carouselWrapStyle(theme)}>
          <div
            ref={carouselRef}
            className="gfm-carousel"
            style={carouselStyle}
            data-testid="gfm-carousel"
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
                disabled={isBusy}
                className="gfm-thumb"
                style={thumbButtonStyle(idx === selectedShowcaseIdx, theme)}
              >
                <img src={img.url} alt="" style={thumbImageStyle} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <PromptTextarea
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleGenerate}
          disabled={isBusy}
          theme={theme}
        />

        <AdvancedSection
          open={advancedOpen}
          editable={showAdvanced}
          showcase={selectedShowcase}
          overrides={overrides}
          onOverrideChange={(patch) => setOverrides((prev) => ({ ...prev, ...patch }))}
          randomizeSeedOnce={randomizeSeedOnce}
          onRandomizeSeed={() => setRandomizeSeedOnce(true)}
          onUndoRandomize={() => setRandomizeSeedOnce(false)}
          isBusy={isBusy}
          theme={theme}
          showCheckpointPicker={showCheckpointPicker}
          effectiveCheckpoint={effectiveCheckpoint}
          onChangeCheckpoint={handleChangeCheckpoint}
        />

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isBusy}
          className="gfm-primary"
          style={primaryButtonStyle(isBusy)}
        >
          {isBusy && <Pulse />}
          <span>{labelForStatus(status, budget, estimatedCost, isRegenerate)}</span>
        </button>

        {estimateError && (
          <p style={{ ...subtleStyle, fontSize: 12 }}>
            Couldn't estimate cost: {estimateError}
          </p>
        )}
      </div>

      {(error || result?.status === 'failed' || result?.status === 'expired' || result?.status === 'canceled') && (
        isInsufficient ? (
          // Tier-2 #10: for the insufficient-buzz path the Top-Up CTA is
          // the obvious next action — make it the primary button, demote
          // the error message to supporting copy. Visual weight matches
          // the Generate button so the user reads "do this instead."
          <div style={insufficientBoxStyle(theme)} role="alert">
            <p style={insufficientCopyStyle(theme)}>Not enough Buzz for this generation.</p>
            <button
              type="button"
              onClick={() => openPurchaseModal(budget * 10)}
              className="gfm-primary"
              style={primaryButtonStyle(false)}
            >
              <span>Top up Buzz · {budget * 10}</span>
            </button>
          </div>
        ) : (
          <div style={errorBoxStyle(theme)} role="alert">
            <p style={{ margin: 0 }}>
              {error?.message ?? result?.error ?? 'Generation failed.'}
            </p>
          </div>
        )
      )}

      {result && result.status === 'succeeded' && (
        <Result
          snapshot={result}
          theme={theme}
          modelName={model.modelName}
          isBusy={isBusy}
          onTryAgain={handleTryAgain}
        />
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

function Result({
  snapshot,
  theme,
  modelName,
  isBusy,
  onTryAgain,
}: {
  snapshot: BlockWorkflowSnapshot;
  theme: string | null;
  modelName: string;
  isBusy: boolean;
  onTryAgain: () => void | Promise<void>;
}) {
  // Tier-3 #8: cap the result image to a sane viewport height. Without
  // this a 2048×2048 generated image renders at 2048px tall and blows
  // the iframe past the manifest's 1600px ceiling. `object-fit: contain`
  // preserves aspect ratio inside the cap.
  // Block is single-image v1 — render the first URL only. Multi-image
  // results would otherwise stack vertically without limit; we'll
  // revisit when the block exposes a quantity slider.
  const firstUrl = snapshot.imageUrls?.[0] ?? null;
  return (
    <div className="gfm-fade-in" style={{ marginTop: 8 }}>
      {firstUrl && (
        <img
          key={firstUrl}
          src={firstUrl}
          alt="Generation 1"
          style={imageStyle(theme)}
          loading="lazy"
        />
      )}
      <div style={resultActionsRowStyle}>
        {snapshot.cost?.total != null ? (
          <p style={{ ...subtleStyle, marginRight: 'auto' }}>
            Spent{' '}
            <strong style={{ opacity: 1, color: 'inherit' }}>
              {snapshot.cost.total} Buzz
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
            disabled={isBusy}
            className="gfm-link"
            style={{
              ...linkButtonStyle(),
              color: theme === 'dark' ? BRAND_LIGHT_DARK : BRAND,
            }}
          >
            Download
          </button>
        )}
        <button
          type="button"
          onClick={onTryAgain}
          disabled={isBusy}
          className="gfm-link"
          style={{
            ...linkButtonStyle(),
            color: theme === 'dark' ? BRAND_LIGHT_DARK : BRAND,
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function labelForStatus(
  status: WorkflowStatus,
  budget: number,
  estimatedCost: number | null,
  isRegenerate = false
): string {
  // SDK status semantics:
  //   estimating  — cost lookup in flight (busy)
  //   confirming  — cost computed, awaiting USER click (idle; show Generate)
  //   submitting  — submit() in flight (busy)
  //   polling     — workflow running server-side (busy)
  //   idle / done / error → also idle (show Generate)
  //
  // Tier-2 #8: keep the cost visible during submitting/polling so the user
  // never loses sight of what they're paying for what they see. Fallback
  // mirrors the idle shape — `(≤ N Buzz)` — when no estimate has landed.
  // Tier-3 #11c: after the first submit on a showcase the verb flips
  // from "Generate" to "Re-generate" — the visible signal that the
  // next click will randomize the seed.
  if (status === 'estimating') return 'Estimating cost…';
  if (status === 'submitting') {
    return estimatedCost != null
      ? `Submitting · ${estimatedCost} Buzz`
      : `Submitting (≤ ${budget} Buzz)`;
  }
  if (status === 'polling') {
    return estimatedCost != null
      ? `Generating · ${estimatedCost} Buzz`
      : `Generating (≤ ${budget} Buzz)`;
  }
  // idle, confirming, done, error: the button is actionable. Show
  // the actual estimated cost when we have one, fall back to the
  // budget cap otherwise. Middle-dot separator reads cleaner than
  // parens for the known-cost case.
  const verb = isRegenerate ? 'Re-generate' : 'Generate';
  return estimatedCost != null
    ? `${verb} · ${estimatedCost} Buzz`
    : `${verb} (≤ ${budget} Buzz)`;
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

// Civitai brand blue. Tier-3 #5 nudges the CTA brighter — Generate now
// uses blue[6] (#228BE6) as its base; hover lands on blue[7] (#1C7ED6);
// active sinks to blue[8] (#1971C2). The old single-token `BRAND` stays
// for non-CTA surfaces (focus rings, link text) where the deeper blue
// reads more "stable affordance" than "primary action."
const BRAND = '#1971C2';
const BRAND_HOVER = '#1864AB';
const CTA = '#228BE6'; // blue[6] — brighter base for the Generate button
const CTA_HOVER = '#1C7ED6'; // blue[7]
const CTA_ACTIVE = '#1971C2'; // blue[8]
const CTA_GLOW_LIGHT = '0 4px 14px rgba(34, 139, 230, 0.35)';
const CTA_GLOW_LIGHT_HOVER = '0 6px 20px rgba(34, 139, 230, 0.45)';
const CTA_GLOW_DARK = '0 4px 14px rgba(34, 139, 230, 0.45)';
const CTA_GLOW_DARK_HOVER = '0 6px 20px rgba(34, 139, 230, 0.55)';
const BRAND_LIGHT_DARK = '#4DABF7'; // blue[4] — readable on dark surfaces
const FOCUS_RING = 'rgba(25, 113, 194, 0.35)';

// Tier-3 #9: ceiling for the auto-growing prompt textarea. ~5 lines of
// the 14px base font with the default line-height keeps it bounded so
// runaway pastes don't blow out the iframe.
const MAX_PROMPT_HEIGHT = 120;

// --------- styles (inline; the host injects [data-theme]) ---------

// Tier-3 #4: borderfied + slightly rounded container. The host page is
// often busy, so a 1px border + a subtle outset shadow (light theme
// only) helps the block read as a discrete surface rather than blending
// into the model page.
const containerStyle = (theme: string | null): CSSProperties => ({
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  // Match host font stack — same list Civitai uses in tailwind.config.js.
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: theme === 'dark' ? '#C1C2C5' : '#222222',
  background: theme === 'dark' ? '#1a1b1e' : '#ffffff',
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#dee2e6'}`,
  borderRadius: 12,
  boxShadow: theme === 'dark' ? 'none' : '0 1px 2px rgba(0, 0, 0, 0.04)',
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
// space for it is worth it.
const thumbButtonStyle = (selected: boolean, theme: string | null): CSSProperties => ({
  padding: 0,
  border: `2px solid ${selected ? BRAND : theme === 'dark' ? '#373A40' : '#dee2e6'}`,
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  transition: 'border-color 160ms ease-out, transform 160ms ease-out, box-shadow 160ms ease-out',
  boxShadow: selected ? `0 0 0 3px ${FOCUS_RING}` : 'none',
  // Don't let flex squish thumbs when the row overflows — they should
  // keep their 96×96 footprint and the parent scrolls instead.
  flex: '0 0 auto',
  scrollSnapAlign: 'center',
});

const thumbImageStyle: CSSProperties = {
  display: 'block',
  width: 96,
  height: 96,
  objectFit: 'cover',
};

const subtleStyle: CSSProperties = {
  opacity: 0.7,
  fontSize: 13,
  margin: 0,
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

// Tier-3 #5: brighter, bolder primary CTA. Brand glow + larger pad +
// font-weight bump. Hover behavior (translate, shadow grow) lives in
// the CSS stylesheet since :hover can't be inlined.
const primaryButtonStyle = (busy: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '12px 16px',
  borderRadius: 8,
  background: CTA,
  color: '#ffffff',
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

// Tier-2 #10: the insufficient-buzz box reframes the visual hierarchy.
// The error copy becomes a quiet label; the Top-Up button uses the same
// brand-blue primary style as Generate so it reads as THE action.
const insufficientBoxStyle = (theme: string | null): CSSProperties => ({
  padding: 12,
  borderRadius: 6,
  background: theme === 'dark' ? '#25262B' : '#f8f9fa',
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#e9ecef'}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
});

const insufficientCopyStyle = (theme: string | null): CSSProperties => ({
  margin: 0,
  fontSize: 13,
  opacity: 0.85,
  color: theme === 'dark' ? '#C1C2C5' : '#495057',
});

// Tier-2 #7: row that contains the spent-buzz line on the left and the
// inline Download / Try again actions on the right. Wraps to a second
// row on narrow widths so the buttons stay tappable.
const resultActionsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 4,
};

// Tier-3 #7, #8: 8px corner radius (matches the carousel thumbs) + a
// height cap so multi-megapixel results don't blow out the iframe.
// `object-fit: contain` is implicit (not set) since the image is
// constrained on both axes; the natural aspect ratio is preserved.
const imageStyle = (theme: string | null): CSSProperties => ({
  maxWidth: '100%',
  // Tier-3 #8: hard cap on rendered height. 480px keeps the result
  // visible without overflowing the iframe past the manifest's 1600px
  // ceiling when Advanced is also open.
  maxHeight: 480,
  width: '100%',
  height: 'auto',
  objectFit: 'contain',
  borderRadius: 8,
  display: 'block',
  marginBottom: 8,
  boxShadow:
    theme === 'dark'
      ? '0 1px 3px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04)'
      : '0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04)',
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
.gfm-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${FOCUS_RING}, ${CTA_GLOW_LIGHT};
}
[data-theme="dark"] .gfm-primary:focus-visible {
  box-shadow: 0 0 0 3px ${FOCUS_RING}, ${CTA_GLOW_DARK};
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

@media (prefers-reduced-motion: reduce) {
  /* Respect user accessibility preference — host theme also sets this. */
  .gfm-fade-in,
  .gfm-fade-in img,
  .gfm-thumb,
  .gfm-primary,
  .gfm-input,
  .gfm-dots-btn {
    animation: none !important;
    transition: none !important;
  }
  /* Tier-3 #5: the primary CTA's hover transform is the loudest part
     of the motion budget — kill the lift + the shadow growth, keep the
     color shift since color isn't motion. */
  .gfm-primary:not(:disabled):hover,
  .gfm-primary:not(:disabled):active {
    transform: none !important;
    box-shadow: none !important;
  }
}
`;

