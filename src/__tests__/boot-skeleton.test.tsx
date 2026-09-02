/**
 * Boot skeleton — the static shimmer that index.html paints BEFORE this
 * bundle exists, and its agreement with the React `!ready` skeleton that
 * replaces it a few hundred ms later.
 *
 * Two independent failure modes are guarded here, because they have
 * different causes and only one of them is visible from inside React:
 *
 *   1. PARITY. index.html and App.tsx each declare the same four bars. They
 *      are different files in different languages, so nothing but a test
 *      keeps them equal — and a drift is not a crash, it is a visible jump
 *      at hydration. Tests below compare the two DECLARATIONS, not one side
 *      against a constant, so editing either file alone goes red.
 *
 *   2. THEME AGREEMENT. `useBlockContext().theme` is `'light'` before
 *      BLOCK_INIT — a sentinel from the SDK transport, not the host's real
 *      theme. index.html guesses from `prefers-color-scheme`, so if App.tsx
 *      honoured that sentinel a dark-mode viewer would get dark -> white ->
 *      dark. `bootThemeGuess()` exists to stop that, and the tests here pin
 *      it against the sentinel explicitly (the mock keeps returning
 *      `theme: 'light'` while the OS says dark — that IS the bug's shape).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import {
  encodeBlockInitFragment,
  parseBlockInitFragment,
} from '@civitai/app-sdk/blocks';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockReady,
  setMockTheme,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

// Import AFTER the mock is registered so the App picks up the stubs.
import { App } from '../App';

// Vite rewrites `import.meta.url` to a served path, so it cannot locate a
// file on disk here. vitest's cwd is the project root (vite.config.ts's dir).
const repoFile = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const INDEX_HTML = repoFile('index.html');
const APP_SRC = repoFile('src/App.tsx');

/* ------------------------------------------------------------------ *
 *  matchMedia control — jsdom has no OS theme, so the boot guess has
 *  to be driven explicitly. Returning a MediaQueryList whose `matches`
 *  we choose is the whole lever bootThemeGuess() reads.
 * ------------------------------------------------------------------ */

function setPrefersDark(matches: boolean | 'throw'): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      if (matches === 'throw') throw new Error('matchMedia unavailable');
      return {
        matches: query.includes('prefers-color-scheme: dark') ? matches : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    })
  );
}

/** Render the App in its pre-BLOCK_INIT boot state. */
async function renderBoot(): Promise<HTMLElement> {
  setMockReady(false);
  const { container } = await renderApp(<App />);
  const skeleton = container.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (!skeleton) throw new Error('boot skeleton did not render');
  return skeleton;
}

type Geometry = { width: string; height: string; marginTop: string };

const geometryOf = (els: ArrayLike<Element>): Geometry[] =>
  Array.from(els, (el) => {
    const s = (el as HTMLElement).style;
    return {
      width: s.width,
      height: s.height,
      // React omits marginTop on the first two bars; the DOM reports ''
      // for an unset property on both sides, so '' is a real value here.
      marginTop: s.marginTop,
    };
  });

/** The four `.gfm-boot-bar` elements as declared inside #root in index.html. */
function staticBars(): Element[] {
  const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
  const root = doc.querySelector('#root');
  if (!root) throw new Error('#root missing from index.html');
  return Array.from(root.querySelectorAll('.gfm-boot-bar'));
}

/** All `linear-gradient(...)` declarations in a blob of source, normalised. */
const gradients = (src: string): string[] =>
  (src.match(/linear-gradient\([^)]*\)/g) ?? []).map((g) =>
    g.toLowerCase().replace(/\s+/g, ' ')
  );

/** The body of `function LoadingSkeleton` in App.tsx. */
function loadingSkeletonSource(): string {
  const start = APP_SRC.indexOf('function LoadingSkeleton');
  expect(start).toBeGreaterThan(-1);
  const end = APP_SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return APP_SRC.slice(start, end);
}

beforeEach(() => {
  resetBlocksReactMock();
  setPrefersDark(false);
  // The fragment is read from the real `location.hash`, so a test that sets
  // one must not leak it into the next — a stale hash would silently make a
  // later OS-fallback assertion read the previous test's host theme.
  window.location.hash = '';
  // Same isolation for the attribute the boot script writes: App.tsx reads it,
  // so a leftover would make a later OS-fallback assertion read a stale host
  // theme and pass for the wrong reason.
  document.documentElement.removeAttribute('data-civitai-boot-theme');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('index.html ships a skeleton that paints before the bundle', () => {
  it('renders markup inside #root (not an empty mount point)', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const root = doc.querySelector('#root');
    expect(root).not.toBeNull();
    // The entire point: something is on screen before /src/main.tsx runs.
    expect(root!.children.length).toBeGreaterThan(0);
    expect(staticBars()).toHaveLength(4);
  });

  it('is parser-rendered markup, not inert or paint-blocked content', () => {
    // NOTE the invariant this does NOT assert: where the skeleton sits
    // relative to the bundle's <script>. `vite build` hoists that script
    // into <head>, ABOVE #root — which is harmless, because a
    // `type="module"` script is deferred by default and blocks neither the
    // parser nor first paint. Asserting document order would therefore
    // pin a property the real artifact does not have. What must hold is
    // that the markup is live in the parsed document and nothing ahead of
    // it stops the parser reaching it.
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');

    // <template>/<noscript> contents are not in the element tree, so a
    // skeleton hidden in either is simply not found here.
    expect(doc.querySelector('#root .gfm-boot')).not.toBeNull();

    // What "paint-blocked" means here, precisely: nothing ahead of the skeleton
    // may require a NETWORK FETCH before the parser reaches it. A classic
    // script with a `src` does; an INLINE one does not — it blocks the parser
    // only for its own execution, which is why the boot script in <head> is
    // allowed to be one. It has to be: it resolves the host's theme before the
    // skeleton paints, and a deferred script runs far too late for that.
    //
    // 🔴 The exemption is for INLINE scripts only, and the assertion below is
    // what keeps it that way — adding a `src` to the boot script would turn it
    // into exactly the fetch this guard exists to forbid, and would otherwise
    // slip through as "still a classic script, still exempt".
    const fetchBlocking = Array.from(doc.querySelectorAll('script')).filter(
      (s) =>
        s.hasAttribute('src') &&
        s.getAttribute('type') !== 'module' &&
        !s.hasAttribute('defer') &&
        !s.hasAttribute('async')
    );
    expect(fetchBlocking.map((s) => s.outerHTML)).toEqual([]);

    const inlineHeadScripts = Array.from(doc.querySelectorAll('head script'));
    expect(inlineHeadScripts.length).toBeGreaterThan(0); // the boot script
    for (const s of inlineHeadScripts) {
      expect(s.hasAttribute('src')).toBe(false);
    }
  });

  it('is REMOVED by React on mount — createRoot clears the container', async () => {
    // The whole design rests on this: the skeleton lives inside #root and
    // React deletes it, so nothing has to clean it up and there is no
    // moment where both are on screen. That is real react-dom behaviour
    // (`createRoot` clears the container before its first commit), not
    // something this repo controls — so it is worth pinning against a
    // react-dom bump rather than assumed.
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = doc.querySelector('#root')!.innerHTML;
    document.body.appendChild(container);
    expect(container.querySelectorAll('.gfm-boot-bar')).toHaveLength(4);

    setMockReady(false);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    expect(container.querySelectorAll('.gfm-boot-bar')).toHaveLength(0);
    // ...and React's own skeleton took its place, so the swap is not a gap.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it('inlines its own resets rather than leaning on src/index.css', () => {
    // index.css arrives WITH the bundle, so anything it provides is absent
    // during the gap. The UA's default 8px body margin would otherwise
    // offset the skeleton and snap when the real stylesheet lands.
    const inlineCss = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? '';
    expect(inlineCss).toMatch(/body\s*\{[^}]*margin:\s*0/);
  });

  it('declares a prefers-color-scheme: dark variant', () => {
    // Positive control for the parity test below — if this block ever
    // disappears, the dark-gradient comparison would compare nothing to
    // nothing and pass vacuously.
    expect(INDEX_HTML).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe('static skeleton matches the React skeleton it hands off to', () => {
  it('declares the same four bar geometries', async () => {
    const rendered = await renderBoot();
    expect(geometryOf(rendered.children)).toEqual(geometryOf(staticBars()));
  });

  it('declares the same shimmer gradients, light and dark', () => {
    const fromApp = gradients(loadingSkeletonSource());
    const fromHtml = gradients(INDEX_HTML);
    expect(fromApp).toHaveLength(2); // light + dark, per LoadingSkeleton
    expect(new Set(fromHtml)).toEqual(new Set(fromApp));
  });

  it('declares the same container backgrounds, light and dark', () => {
    // outerContainerStyle()'s two values, quoted out of App.tsx source.
    const outer = APP_SRC.slice(APP_SRC.indexOf('const outerContainerStyle'));
    const bg = /background:\s*theme === 'dark' \? '(#[0-9a-f]+)' : '(#[0-9a-f]+)'/i.exec(outer);
    expect(bg).not.toBeNull();
    const [, dark = '', light = ''] = bg ?? [];
    expect(dark).not.toBe('');
    expect(light).not.toBe('');
    const css = INDEX_HTML.toLowerCase();
    expect(css).toContain(`background: ${light.toLowerCase()}`);
    expect(css).toContain(`background: ${dark.toLowerCase()}`);
  });

  it('uses the same inner padding and bar gap', async () => {
    const rendered = await renderBoot();
    const inner = rendered.parentElement as HTMLElement;
    const inlineCss = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? '';
    const bootInner = /\.gfm-boot-inner\s*\{([^}]*)\}/.exec(inlineCss)?.[1] ?? '';

    expect(bootInner).toContain(`padding: ${inner.style.padding}`);
    // The React inner's own `gap` is inert (its only visible child is the
    // skeleton), so the gap that shows is the skeleton div's.
    expect(bootInner).toContain(`gap: ${rendered.style.gap}`);
  });
});

describe('boot theme is guessed from the OS, not from the SDK sentinel', () => {
  it('paints dark for a dark-mode viewer while theme is still the sentinel', async () => {
    // This is the regression: the mock reports the SDK's pre-init
    // `theme: 'light'` exactly as the real transport does. Reading it here
    // is what produced dark -> white -> dark at hydration.
    setMockTheme('light');
    setPrefersDark(true);

    const skeleton = await renderBoot();
    const outer = skeleton.closest('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('dark');
    expect(outer.style.background).toBe('rgb(26, 27, 30)'); // #1a1b1e
  });

  it('paints light for a light-mode viewer', async () => {
    setMockTheme('light');
    setPrefersDark(false);

    const skeleton = await renderBoot();
    const outer = skeleton.closest('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('light');
    expect(outer.style.background).toBe('rgb(255, 255, 255)'); // #ffffff
  });

  it('falls back to light where matchMedia is unavailable', async () => {
    setPrefersDark('throw');
    const skeleton = await renderBoot();
    expect((skeleton.closest('[data-theme]') as HTMLElement).dataset.theme).toBe('light');
  });

  it('still lets the host theme win once BLOCK_INIT has landed', async () => {
    // The guess is boot-only. A dark OS must not override a light host.
    setPrefersDark(true);
    setMockTheme('light');
    setMockReady(true);

    const { container } = await renderApp(<App />);
    const outer = container.querySelector('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('light');
  });
});

/* ------------------------------------------------------------------ *
 *  The host's theme, read before the bundle exists
 * ------------------------------------------------------------------ */

describe("the boot theme comes from the HOST's fragment, not a guess", () => {
  /**
   * Run index.html's inline boot script in isolation and report what it
   * resolved. Extracted from the FILE rather than reimplemented here — a copy
   * would drift from the thing under test and pass forever.
   */
  function runBootScript(hash: string, prefersDark: boolean): string | null {
    const src = /<script>([\s\S]*?)<\/script>/.exec(INDEX_HTML)?.[1];
    if (!src) throw new Error('no inline boot script found in index.html');
    const root: Record<string, string> = {};
    const fakeDoc = {
      documentElement: {
        setAttribute: (k: string, v: string) => {
          root[k] = v;
        },
      },
    };
    const fakeWin = {
      matchMedia: (q: string) => ({ matches: q.includes('dark') && prefersDark }),
    };
    // eslint-disable-next-line no-new-func
    new Function('location', 'document', 'window', src)({ hash }, fakeDoc, fakeWin);
    return root['data-civitai-boot-theme'] ?? null;
  }

  it("uses the HOST's theme when the fragment carries one, over the OS", () => {
    // The whole point: OS says dark, host says light — the host wins, so there
    // is nothing left to repaint when BLOCK_INIT lands.
    const hash = '#' + encodeBlockInitFragment({
      theme: 'light',
      renderMode: 'iframe',
      blockInstanceId: 'bi_abc',
    });
    expect(runBootScript(hash, true)).toBe('light');
    expect(parseBlockInitFragment(hash).theme).toBe('light');
  });

  it('agrees with the SDK decoder on the SDK encoder\'s own output', () => {
    // 🔴 THE DRIFT GUARD. index.html cannot import the SDK — the bundle
    // carrying it is exactly what has not loaded yet — so it reimplements the
    // parse. Feeding the SDK's OWN encoder through both sides is what stops
    // the copy silently diverging from the format it is copying.
    for (const theme of ['dark', 'light'] as const) {
      const hash = '#' + encodeBlockInitFragment({
        theme,
        renderMode: 'iframe',
        blockInstanceId: 'bi_abc',
      });
      expect(parseBlockInitFragment(hash).theme).toBe(theme);
      expect(runBootScript(hash, theme === 'light')).toBe(theme);
    }
  });

  it('falls back to the OS guess when there is no fragment', () => {
    expect(runBootScript('', true)).toBe('dark');
    expect(runBootScript('', false)).toBe('light');
  });

  it("React's boot render uses what the script PAINTED, after the SDK strips the hash", async () => {
    // 🔴 THE REGRESSION THIS EXISTS FOR, and it shipped once. `bootThemeGuess`
    // was first written as `parseBlockInitFragment(location.hash)`. That is
    // wrong in a way no mocked test can see: the SDK's own iframeTransport
    // reads the fragment during init and then STRIPS it from the URL
    // (stripBlockInitFragment + history.replaceState), and that init runs
    // BEFORE this component renders. Mocking @civitai/blocks-react means the
    // transport never runs, so the hash survives in tests and the re-parse
    // looked correct — while the real browser showed dark-then-light.
    //
    // So this reproduces the POST-STRIP state: hash EMPTY, attribute set. OS
    // says dark, host said light; light must win.
    setPrefersDark(true);
    setMockTheme('light');
    window.location.hash = '';
    document.documentElement.setAttribute('data-civitai-boot-theme', 'light');

    const skeleton = await renderBoot();
    expect((skeleton.closest('[data-theme]') as HTMLElement).dataset.theme).toBe('light');
  });

  it('React agrees with the boot script for a HOST-dark fragment', async () => {
    // The other direction, driven end-to-end from the SDK's own encoder: the
    // script resolves the attribute, React reads that same attribute. OS light,
    // host dark.
    const hash =
      '#' +
      encodeBlockInitFragment({
        theme: 'dark',
        renderMode: 'iframe',
        blockInstanceId: 'bi_abc',
      });
    const painted = runBootScript(hash, false);
    expect(painted).toBe('dark');

    setPrefersDark(false);
    setMockTheme('light');
    document.documentElement.setAttribute('data-civitai-boot-theme', painted!);
    const skeleton = await renderBoot();
    expect((skeleton.closest('[data-theme]') as HTMLElement).dataset.theme).toBe('dark');
  });

  it("React's boot render falls back to the OS when the script left no attribute", async () => {
    // Control for the pair above: with no attribute the OS guess is the only
    // signal, so their passing proves the attribute is what moved them.
    setPrefersDark(true);
    setMockTheme('light');
    const skeleton = await renderBoot();
    expect((skeleton.closest('[data-theme]') as HTMLElement).dataset.theme).toBe('dark');
  });

  it('ignores a fragment it cannot trust rather than half-reading it', () => {
    // An unknown version must degrade to "no fast path", not to a partial read
    // — the same totality rule the SDK decoder documents. OS says dark, so a
    // correct fallback is 'dark'; a half-read would return 'light'.
    expect(runBootScript('#civitai-block=v2&theme=light', true)).toBe('dark');
    // No marker at all: a block's own hash route must not be mistaken for one.
    expect(runBootScript('#theme=light', true)).toBe('dark');
    // Truncated / junk.
    expect(runBootScript('#civitai-block=v1&theme=', true)).toBe('dark');
    expect(runBootScript('#%%%', true)).toBe('dark');
  });

  it('the attribute actually DRIVES the paint — both themes have a rule', () => {
    // 🔴 THE STEP NOTHING PINNED. script -> attribute -> React was guarded three
    // ways; attribute -> PIXELS was guarded nowhere, and deleting either
    // `[data-civitai-boot-theme=...]` rule left the whole suite green while a
    // dark host on a light OS would paint white and then repaint — the exact
    // defect this feature removes, shipped silently.
    const css = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? '';
    const ruleFor = (theme: 'dark' | 'light', sel: string) =>
      new RegExp(
        `\\[data-civitai-boot-theme='${theme}'\\]\\s+\\${sel}\\s*\\{[^}]*background[^}]*\\}`
      ).test(css);
    for (const theme of ['dark', 'light'] as const) {
      expect(ruleFor(theme, '.gfm-boot')).toBe(true);
      expect(ruleFor(theme, '.gfm-boot-bar')).toBe(true);
    }
    // 🔴 AND THEY MUST BE EFFECTIVE, not merely present. Wrapping all four in
    // `@media (min-width: 99999px)` leaves them declared with the right colours
    // and completely inert in every real viewport — and the presence check
    // above passes. So: the attribute rules must sit at the TOP LEVEL of the
    // stylesheet, outside any `@media` block.
    const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const theme of ['dark', 'light'] as const) {
      expect(
        new RegExp(`\\[data-civitai-boot-theme='${theme}'\\]`).test(topLevel)
      ).toBe(true);
    }

    // ...and they must carry the SAME colours the media-query/base rules use,
    // or the attribute path and the no-JS path disagree.
    const dark = /\[data-civitai-boot-theme='dark'\]\s+\.gfm-boot\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const light = /\[data-civitai-boot-theme='light'\]\s+\.gfm-boot\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark.toLowerCase()).toContain('#1a1b1e');
    expect(light.toLowerCase()).toContain('#ffffff');
  });

  it('matches the SDK on inputs the encoder never emits, including the dangerous one', () => {
    // 🔴 The encoder-output drift test can only exercise the canonical form —
    // it is structurally incapable of finding a disagreement, because that is
    // the one input on which the two cannot disagree. These are the inputs a
    // differential actually found.
    //
    // The dangerous direction is ACCEPT-where-the-SDK-REJECTS: two markers,
    // the first unknown. The SDK reads the FIRST key and refuses; an unanchored
    // `.test()` found the second and accepted.
    const twoMarkers = '#civitai-block=v2&civitai-block=v1&theme=light';
    expect(parseBlockInitFragment(twoMarkers).theme).toBeUndefined();
    expect(runBootScript(twoMarkers, true)).toBe('dark'); // OS fallback, not 'light'

    // Order-independence and unknown extra keys must still be accepted.
    expect(runBootScript('#civitai-block=v1&zz=1&theme=dark', false)).toBe('dark');
    expect(parseBlockInitFragment('#civitai-block=v1&zz=1&theme=dark').theme).toBe('dark');

    // The THEME key has the same first-key rule: an invalid first value means
    // no fast path, not "skip it and take the next one".
    expect(parseBlockInitFragment('#civitai-block=v1&theme=blue&theme=dark').theme).toBeUndefined();
    expect(runBootScript('#civitai-block=v1&theme=blue&theme=dark', false)).toBe('light');

    // A superstring version must NOT satisfy the v1 gate.
    expect(runBootScript('#civitai-block=v11&theme=light', true)).toBe('dark');
    expect(parseBlockInitFragment('#civitai-block=v11&theme=light').theme).toBeUndefined();
  });

  it('declares bootSkeleton in the manifest, so the host stands its veil down', () => {
    // Without this the host covers the iframe until BLOCK_READY and every
    // other guard in this file is pinning something no user can see.
    const manifest = JSON.parse(repoFile('block.manifest.json'));
    expect(manifest.bootSkeleton).toBe(true);
  });
});
