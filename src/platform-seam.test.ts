import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE PORT'S CLOSING CONDITION, MADE MECHANICAL.
 *
 * This block used to reach civitai through the blocks-react bridge package,
 * over postMessage. It now reaches it through `@civitai/sdk` over the public
 * `/api/v1/blocks/*` REST routes, and everything platform-shaped lives behind
 * `src/platform/` — which is the ONLY directory allowed to name `@civitai/sdk`.
 *
 * Both halves matter and they fail in opposite directions:
 *
 *   - the bridge clause is the migration's finish line. Measured by hand it is
 *     a grep somebody has to remember to re-run; as a test it fires on the day
 *     someone re-adds the dependency for "just one hook".
 *   - the seam clause is what keeps the finish line meaningful. A port that
 *     leaves `@civitai/sdk` calls scattered through a 3,400-line `App.tsx` has
 *     moved the coupling, not removed it, and the NEXT transport change is the
 *     same 25-file diff this one was. The reason `App.tsx` changed at its
 *     import block rather than throughout is that the seam exists; nothing but
 *     a guard keeps it that way.
 *
 * 🔴 IT CARRIES ITS OWN POSITIVE CONTROL, and that is not decoration. Both
 * assertions are ZERO-valued — "no file imports X" — and a zero is exactly what
 * a scanner wired to nothing also returns: a wrong root, a wrong extension
 * filter, a typo'd needle, and this file passes forever while asserting
 * nothing. So it additionally asserts that the scan SAW files, and that
 * `src/platform/` really does import `@civitai/sdk`. Report the pair, never the
 * zero alone.
 */

/**
 * 🔴 `dirname(fileURLToPath(url))`, NOT `new URL('.', url)`. Under this repo's
 * jsdom environment the global `URL` resolves a bare `'.'` against the DOCUMENT
 * base, so `new URL('.', import.meta.url)` returns `http://localhost:3000/src`
 * — a well-formed URL pointing at nothing, which `fileURLToPath` then rejects.
 * Measured here; the path arithmetic below has to stay on `node:path`.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(SRC, '..', 'package.json');

/** Every `.ts`/`.tsx` under `src/`, as paths relative to `src/`. */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(relative(SRC, full));
    }
  }
  return out;
}

/**
 * Whether a file IMPORTS the package, as opposed to merely mentioning it.
 *
 * A bare substring search would count this file's own prose, and every 🔴 note
 * in `src/platform/` explaining what the bridge package used to do — which is
 * most of the comments the port added. Matching the module specifier is what
 * makes the assertion about code.
 */
function importsPackage(source: string, pkg: string): boolean {
  const quoted = `['"]${pkg.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:/[^'"]*)?['"]`;
  return new RegExp(`(?:from|import|require|vi\\.mock)\\s*\\(?\\s*${quoted}`).test(source);
}

function importersOf(pkg: string): string[] {
  return sourceFiles().filter((rel) => importsPackage(readFileSync(join(SRC, rel), 'utf8'), pkg));
}

describe('platform seam', () => {
  it('scans a non-empty set of sources (the control for the two zeros below)', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('App.tsx');
    expect(files).toContain(join('platform', 'workflows.ts'));
  });

  it('has no importer of the bridge package left anywhere in src', () => {
    expect(importersOf('@civitai/blocks-react')).toEqual([]);
  });

  it('does not list the bridge package as a dependency', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as Record<
      string,
      Record<string, string> | unknown
    >;
    const deps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    expect(Object.keys(deps)).not.toContain('@civitai/blocks-react');
    // The positive half: the replacement IS declared. Without this the
    // assertion above passes just as well on a repo that depends on neither.
    expect(Object.keys(deps)).toContain('@civitai/sdk');
  });

  it('confines @civitai/sdk to src/platform/ — and proves the scan can see it there', () => {
    const importers = importersOf('@civitai/sdk');
    // Positive control: a needle that matches nothing would make the next
    // assertion pass vacuously.
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((rel) => !rel.startsWith(`platform${sep}`))).toEqual([]);
  });
});
