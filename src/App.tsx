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
        <Header model={model} />
        <p style={subtleStyle}>Sign in to generate.</p>
      </div>
    );
  }

  if (viewer.status === 'banned' || viewer.status === 'muted') {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <Header model={model} />
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

  const handleGenerate = async () => {
    try {
      const params = buildSubmitParams(
        prompt,
        suffix,
        selectedShowcase,
        overrides,
        randomizeSeedOnce
      );
      // Reset the one-shot randomize flag after consuming it so the
      // *next* submit reverts to the showcase's seed (unless the user
      // clicks 🎲 again). Important: must run after the build call.
      if (randomizeSeedOnce) setRandomizeSeedOnce(false);
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
      <Header model={model} />

      {showCheckpointPicker && (
        <div style={checkpointRowStyle(theme)}>
          <span style={subtleStyle}>
            Generating with:{' '}
            {effectiveCheckpoint ? (
              <strong style={{ color: 'inherit', opacity: 1 }}>
                {effectiveCheckpoint.modelName}
                {effectiveCheckpoint.versionName ? ` (${effectiveCheckpoint.versionName})` : ''}
              </strong>
            ) : (
              <em>no checkpoint configured</em>
            )}
          </span>
          <button
            type="button"
            onClick={handleChangeCheckpoint}
            className="gfm-link"
            style={linkButtonStyle()}
            disabled={isBusy}
          >
            Change
          </button>
        </div>
      )}
      {checkpointError && (
        <p style={errorTextStyle}>Checkpoint: {checkpointError}</p>
      )}

      {showcaseImages.length > 0 && (
        <div>
          <p style={{ ...subtleStyle, marginBottom: 6 }}>
            Remix from a preview image:
          </p>
          <div style={carouselStyle}>
            {showcaseImages.map((img, idx) => (
              <button
                key={img.id}
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
        <input
          aria-label="Prompt (optional)"
          placeholder={`Optional prompt — defaults to ${model.modelName}'s style`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="gfm-input"
          style={inputStyle(theme)}
          disabled={isBusy}
        />

        <AdvancedSection
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
          editable={showAdvanced}
          showcase={selectedShowcase}
          overrides={overrides}
          onOverrideChange={(patch) => setOverrides((prev) => ({ ...prev, ...patch }))}
          randomizeSeedOnce={randomizeSeedOnce}
          onRandomizeSeed={() => setRandomizeSeedOnce(true)}
          onUndoRandomize={() => setRandomizeSeedOnce(false)}
          isBusy={isBusy}
          theme={theme}
        />

        {(estimatedCost != null || estimateError) && (
          <p style={subtleStyle}>
            {estimateError
              ? `Couldn't estimate cost: ${estimateError}`
              : `Estimated cost: ${estimatedCost} Buzz (budget: ${budget})`}
          </p>
        )}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isBusy}
          className="gfm-primary"
          style={primaryButtonStyle(isBusy)}
        >
          {isBusy && <Pulse />}
          <span>{labelForStatus(status, budget, estimatedCost)}</span>
        </button>
      </div>

      {(error || result?.status === 'failed' || result?.status === 'expired' || result?.status === 'canceled') && (
        <div style={errorBoxStyle(theme)} role="alert">
          <p style={{ margin: 0 }}>
            {error?.message ?? result?.error ?? 'Generation failed.'}
          </p>
          {isInsufficient && (
            <button
              type="button"
              onClick={() => openPurchaseModal(budget * 10)}
              className="gfm-link"
              style={{ ...linkButtonStyle(), color: theme === 'dark' ? '#74C0FC' : '#1971C2' }}
            >
              Top up Buzz →
            </button>
          )}
        </div>
      )}

      {/* Gate the intermediate-state label on hook status === 'polling',
          not just snapshot status: the SDK leaves `result` populated with
          the estimate's snapshot (status: 'pending') even before submit,
          which would otherwise show "Queued…" with nothing actually
          queued. 'polling' only sets after submit() returns. */}
      {status === 'polling' &&
        result &&
        (result.status === 'pending' || result.status === 'processing') && (
          <p style={{ ...subtleStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Pulse />
            <span>{result.status === 'pending' ? 'Queued…' : 'Generating…'}</span>
          </p>
        )}

      {result && result.status === 'succeeded' && <Result snapshot={result} theme={theme} />}
    </div>
  );
}

// --------- helpers ---------

function Header({ model }: { model: ModelSlotContext }) {
  return (
    <header style={headerStyle}>
      <h3 style={headerTitleStyle}>Generate from this model</h3>
      <small style={subtleStyle}>
        {model.modelName} · v{model.modelVersionId}
      </small>
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
  onToggle: () => void;
  editable: boolean;
  showcase: ShowcaseImage | null;
  overrides: ParamOverrides;
  onOverrideChange: (patch: ParamOverrides) => void;
  randomizeSeedOnce: boolean;
  onRandomizeSeed: () => void;
  onUndoRandomize: () => void;
  isBusy: boolean;
  theme: string | null;
}) {
  const {
    open,
    onToggle,
    editable,
    showcase,
    overrides,
    onOverrideChange,
    randomizeSeedOnce,
    onRandomizeSeed,
    onUndoRandomize,
    isBusy,
    theme,
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
    <div style={advancedWrapperStyle(theme)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="gfm-advanced-toggle"
        style={advancedToggleStyle(theme)}
      >
        <span>⚙ Advanced {editable ? '' : '(read-only)'}</span>
        <span style={{ opacity: 0.6, transition: 'transform 180ms ease-out', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>▸</span>
      </button>
      <div
        aria-hidden={!open}
        style={advancedCollapseStyle(open)}
      >
        <div style={advancedBodyStyle(theme)}>
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

function Result({ snapshot, theme }: { snapshot: BlockWorkflowSnapshot; theme: string | null }) {
  return (
    <div className="gfm-fade-in" style={{ marginTop: 8 }}>
      {snapshot.imageUrls?.map((url, i) => (
        <img
          key={url}
          src={url}
          alt={`Generation ${i + 1}`}
          style={imageStyle(theme)}
          loading="lazy"
        />
      ))}
      {snapshot.cost?.total != null && (
        <p style={subtleStyle}>
          Spent <strong style={{ opacity: 1, color: 'inherit' }}>{snapshot.cost.total} Buzz</strong>
        </p>
      )}
    </div>
  );
}

function labelForStatus(
  status: WorkflowStatus,
  budget: number,
  estimatedCost: number | null
): string {
  // SDK status semantics:
  //   estimating  — cost lookup in flight (busy)
  //   confirming  — cost computed, awaiting USER click (idle; show Generate)
  //   submitting  — submit() in flight (busy)
  //   polling     — workflow running server-side (busy)
  //   idle / done / error → also idle (show Generate)
  switch (status) {
    case 'estimating':
      return 'Estimating cost…';
    case 'submitting':
      return 'Submitting…';
    case 'polling':
      return 'Generating…';
    default:
      // idle, confirming, done, error: the button is actionable. Show
      // the actual estimated cost when we have one, fall back to the
      // budget cap otherwise.
      return estimatedCost != null
        ? `Generate (${estimatedCost} Buzz)`
        : `Generate (≤ ${budget} Buzz)`;
  }
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

// Civitai brand blue (Mantine blue[8] = #1971C2). Hover lands on blue[9]
// (#1864AB). Light variants used for focus rings + dark-theme link text.
const BRAND = '#1971C2';
const BRAND_HOVER = '#1864AB';
const BRAND_LIGHT_DARK = '#4DABF7'; // blue[4] — readable on dark surfaces
const FOCUS_RING = 'rgba(25, 113, 194, 0.35)';

// --------- styles (inline; the host injects [data-theme]) ---------

const containerStyle = (theme: string | null): CSSProperties => ({
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  // Match host font stack — same list Civitai uses in tailwind.config.js.
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: theme === 'dark' ? '#C1C2C5' : '#222222',
  background: theme === 'dark' ? '#1A1B1E' : '#fefefe',
  borderRadius: 8,
});

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginBottom: 4,
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  lineHeight: 1.25,
};

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

const carouselStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const thumbButtonStyle = (selected: boolean, theme: string | null): CSSProperties => ({
  padding: 0,
  border: `2px solid ${selected ? BRAND : theme === 'dark' ? '#373A40' : '#dee2e6'}`,
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  transition: 'border-color 160ms ease-out, transform 160ms ease-out, box-shadow 160ms ease-out',
  boxShadow: selected ? `0 0 0 3px ${FOCUS_RING}` : 'none',
});

const thumbImageStyle: CSSProperties = {
  display: 'block',
  width: 64,
  height: 64,
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

const primaryButtonStyle = (busy: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '10px 14px',
  borderRadius: 6,
  background: BRAND,
  color: '#ffffff',
  fontSize: 14,
  fontWeight: 600,
  border: 'none',
  cursor: busy ? 'progress' : 'pointer',
  // box-shadow + transform on hover handled in CSS. Keep transition on
  // inline style so the easing applies even when CSS isn't loaded yet.
  transition: 'background-color 140ms ease-out, transform 140ms ease-out, box-shadow 140ms ease-out, opacity 140ms ease-out',
  opacity: busy ? 0.85 : 1,
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

const imageStyle = (theme: string | null): CSSProperties => ({
  maxWidth: '100%',
  borderRadius: 6,
  display: 'block',
  marginBottom: 8,
  boxShadow:
    theme === 'dark'
      ? '0 1px 3px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.04)'
      : '0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04)',
});

const advancedWrapperStyle = (theme: string | null): CSSProperties => ({
  border: `1px solid ${theme === 'dark' ? '#373A40' : '#e9ecef'}`,
  borderRadius: 6,
  background: theme === 'dark' ? '#141517' : '#f8f9fa',
  overflow: 'hidden',
});

const advancedToggleStyle = (theme: string | null): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '8px 12px',
  background: 'transparent',
  border: 'none',
  color: theme === 'dark' ? '#C1C2C5' : '#222222',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background-color 140ms ease-out',
});

// Smooth max-height collapse. 600px is a generous cap — the body is
// always shorter in practice. height: auto can't be transitioned, so the
// cap is the trade-off cost.
const advancedCollapseStyle = (open: boolean): CSSProperties => ({
  maxHeight: open ? 600 : 0,
  opacity: open ? 1 : 0,
  overflow: 'hidden',
  transition: 'max-height 200ms ease-out, opacity 160ms ease-out',
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

/* Primary CTA — lift on hover, sink on press, brand-darken bg. */
.gfm-primary:not(:disabled):hover {
  background-color: ${BRAND_HOVER};
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(25, 113, 194, 0.28);
}
.gfm-primary:not(:disabled):active {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(25, 113, 194, 0.22);
}
.gfm-primary:disabled {
  cursor: not-allowed;
  opacity: 0.78;
}
.gfm-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px ${FOCUS_RING};
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

/* Advanced toggle — subtle hover tint so the affordance reads. */
.gfm-advanced-toggle:hover {
  background-color: rgba(125, 125, 125, 0.06);
}
.gfm-advanced-toggle:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px ${FOCUS_RING};
}

@media (prefers-reduced-motion: reduce) {
  /* Respect user accessibility preference — host theme also sets this. */
  .gfm-fade-in,
  .gfm-fade-in img,
  .gfm-thumb,
  .gfm-primary,
  .gfm-input {
    animation: none !important;
    transition: none !important;
  }
}
`;

