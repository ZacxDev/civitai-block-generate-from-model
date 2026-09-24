/**
 * The viewer-facing signal for the ONE gap the @civitai/sdk port cannot close:
 * `useCheckpointPicker().persist` is a no-op (no `SET_USER_CHECKPOINT` host
 * request, no REST route for block user settings — see the hook's docblock in
 * `src/platform/hooks.ts` and README → "Known gaps"). A checkpoint swap applies
 * instantly and dies on remount.
 *
 * Before this suite the block said nothing about that: the viewer swapped, saw
 * the label change, and had no way to know the choice was session-scoped. A
 * README is not a UI. The note under the checkpoint row is the fix, and these
 * tests are what stop it being deleted as "cosmetic".
 *
 * Which of these are REGRESSION tests and which are INVARIANT GUARDS, stated
 * plainly rather than implied:
 *
 *   REGRESSION (watched red on the pre-change tree, `Unable to find an element
 *   by: [data-testid="gfm-checkpoint-session-only"]` — the node did not exist):
 *     - "renders the session-only note after a swap"
 *     - "pins the exact wording of the note"
 *     - "announces the note politely rather than as an alert"
 *     - "styles the note as information, not as an error" — note that its red
 *       is CONFOUNDED: on the old tree it fails because there is no note at
 *       all, not because the styling was wrong. It cannot prove the styling
 *       decision on its own; it is here to keep the note from later being
 *       promoted into `errorTextStyle` or `role="alert"`.
 *
 *     - "does not roll back the label when persist rejects" — red for its OWN reason:
 *       the deleted `catch` reverted the label to the publisher default, so
 *       `Juggernaut Flux` was absent. Deliberately asserts the label BEFORE the
 *       note so its red is attributable to the rollback and nothing else.
 *       Reachable only through the mock: the real `persist` cannot reject (in a
 *       production build `import.meta.env.DEV` is false and the body is empty).
 *       It pins the ABSENCE of that dead rollback branch. If `persist` ever
 *       becomes a real request that CAN reject, this test is the thing to
 *       revisit — together with the call site.
 *
 *   INVARIANT GUARD (green before AND after; pins a property, not a fix):
 *     - "shows no note before the viewer has swapped anything"
 *     - "shows no note when the viewer dismisses the picker without choosing"
 *       Both passed vacuously on the old tree — the note never existed. They
 *       are here to stop it being widened into an always-on nag for the 90%
 *       who never open the picker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  platformMockFactory,
  getMockSpies,
  renderApp,
  resetPlatformMock,
  setMockContext,
  DEFAULT_CHECKPOINT,
} from '../test/test-utils';

vi.mock('../platform/index.js', () => platformMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetPlatformMock();
});

/**
 * The exact string the viewer reads. Pinned WHOLE and normalised rather than by
 * keyword: the artifact under test is prose, and a word-level guard is walkable
 * by a reword that guts the meaning. A cosmetic reword must fail this test and
 * update it deliberately — that is the price of a machine-readable claim.
 */
const SESSION_ONLY_COPY =
  'Applies to this session only — reloading the block restores the default checkpoint.';

const SWAPPED_CHECKPOINT = {
  versionId: 12345,
  modelId: 12000,
  modelName: 'Juggernaut Flux',
  versionName: 'v3',
  baseModel: 'Flux.1 D',
};

function normalise(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Open Advanced and click Change, with the picker resolving to exactly
 * `resolved`.
 *
 * The WHOLE resolved value is passed, never just its `selected` field, and the
 * helper takes no default. An earlier draft had `swapCheckpoint(selected =
 * SWAPPED_CHECKPOINT)` and a dismissal case calling `swapCheckpoint(undefined)`
 * — which re-applies the default, so the "dismissed" test actually picked a
 * checkpoint and its assertion was inverted. It was caught only because it went
 * red. Left as a note so nobody reintroduces the default.
 */
async function openPicker(resolved: unknown) {
  getMockSpies().checkpointOpen.mockResolvedValue(resolved);
  setMockContext({ modelType: 'LORA', checkpoint: DEFAULT_CHECKPOINT });
  await renderApp(<App />);
  await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
  await userEvent.click(screen.getByRole('button', { name: /^Change$/ }));
}

/** The viewer picked a different checkpoint. */
const swapCheckpoint = () => openPicker({ selected: SWAPPED_CHECKPOINT });

/**
 * The viewer closed the picker without choosing. `{}` is what the real
 * `useCheckpointPicker().open` returns in that case (`if (!selected) return {}`
 * in src/platform/hooks.ts) — not `{ selected: undefined }` invented here.
 */
const dismissPicker = () => openPicker({});

describe('checkpoint swap is disclosed as session-only', () => {
  it('renders the session-only note after a swap', async () => {
    await swapCheckpoint();
    const note = await screen.findByTestId('gfm-checkpoint-session-only');
    expect(note).toBeInTheDocument();
    // The label really did change — otherwise the note would be describing
    // nothing and this test would pass on a block that ignored the picker.
    expect(screen.getByText(/Juggernaut Flux/)).toBeInTheDocument();
  });

  it('pins the exact wording of the note', async () => {
    await swapCheckpoint();
    const note = await screen.findByTestId('gfm-checkpoint-session-only');
    expect(normalise(note.textContent)).toBe(SESSION_ONLY_COPY);
  });

  it('announces the note politely rather than as an alert', async () => {
    await swapCheckpoint();
    const note = await screen.findByTestId('gfm-checkpoint-session-only');
    // role="status" is the polite live region. role="alert" would be assertive
    // and would frame a non-failure as something gone wrong.
    expect(note).toHaveAttribute('role', 'status');
  });

  /* INVARIANT GUARD — see the file docblock. Green before and after. */
  it('shows no note before the viewer has swapped anything', async () => {
    setMockContext({ modelType: 'LORA', checkpoint: DEFAULT_CHECKPOINT });
    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    // The row is there; the note is not. The publisher default IS persisted —
    // it comes down in BLOCK_INIT — so there is nothing to disclose yet.
    expect(screen.getByText(/Generating with:/)).toBeInTheDocument();
    expect(screen.queryByTestId('gfm-checkpoint-session-only')).not.toBeInTheDocument();
  });

  /* INVARIANT GUARD — see the file docblock. Green before and after. */
  it('shows no note when the viewer dismisses the picker without choosing', async () => {
    await dismissPicker();
    // The "Change" button was clicked, so this is not passing by never having
    // reached the handler.
    expect(getMockSpies().checkpointOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('gfm-checkpoint-session-only')).not.toBeInTheDocument();
  });

  /* INVARIANT GUARD — see the file docblock. Green before and after. */
  it('styles the note as information, not as an error', async () => {
    await swapCheckpoint();
    const note = await screen.findByTestId('gfm-checkpoint-session-only');
    // `errorTextStyle` paints #f03e3e (Mantine red[7]). The note must not.
    expect(note.style.color).not.toMatch(/f03e3e|rgb\(240,\s*62,\s*62\)/i);
    // And no error banner may appear alongside it — nothing failed.
    expect(screen.queryByText(/^Checkpoint:/)).not.toBeInTheDocument();
  });

  it('does not roll back the label when persist rejects', async () => {
    // Pins the ABSENCE of the rollback `catch` that used to wrap `persist`.
    // That branch set the label back to null and wrote 'could not save
    // checkpoint' into the error banner — code that read as "persistence
    // failure is handled" while persistence does not happen at all.
    getMockSpies().checkpointPersist.mockRejectedValue(new Error('boom'));
    await swapCheckpoint();
    // Asserted BEFORE anything about the note, on purpose: if this test leaned
    // on the note's presence it would go red on the old tree for the note's
    // absence rather than for the rollback, and would prove nothing about the
    // branch it claims to pin. The label staying on the viewer's choice is the
    // rollback's own signature — the deleted `catch` reverted it to
    // 'Flux Cinematic', the publisher default from BLOCK_INIT.
    await waitFor(() => {
      expect(screen.getByText(/Juggernaut Flux/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Flux Cinematic/)).not.toBeInTheDocument();
    // The deleted branch's own string is gone with it.
    expect(screen.queryByText(/could not save checkpoint/i)).not.toBeInTheDocument();
    // The disclosure does not depend on `persist` having resolved.
    expect(screen.getByTestId('gfm-checkpoint-session-only')).toBeInTheDocument();
    // What DOES happen, stated rather than denied: `persist` sits inside the
    // picker's own try, so a rejection it cannot produce today would surface
    // through that catch carrying the error's own message. Pinned because it is
    // the current contract and the marker for whoever makes `persist` real —
    // at that point this banner is mislabelled ("Checkpoint: <persist error>"
    // under a heading meant for picker failures) and both this test and
    // `handleChangeCheckpoint` need a deliberate decision, not a silent drift.
    expect(screen.getByText(/^Checkpoint:\s*boom$/)).toBeInTheDocument();
  });
});
