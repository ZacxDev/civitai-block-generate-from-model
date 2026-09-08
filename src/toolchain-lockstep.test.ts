import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 A LOCAL SHELL AND CI THAT INSTALL DIFFERENT TOOLCHAINS MAKE A GREEN RUN
 * MEAN NOTHING.
 *
 * `flake.nix` is what a contributor's shell installs (`nix develop` / direnv);
 * `.github/workflows/ci.yml` is what the merge gate installs. When those two
 * disagree, "it passes locally" stops being evidence about the gate and the
 * gate stops being evidence about anyone's machine — and nothing announces the
 * split, because both sides stay green while testing different things.
 *
 * That is not hypothetical here. Before the flake landed, this workflow pinned
 * `node-version: '22'` as a literal and installed with npm, while no flake
 * existed at all — so there was no reproducible shell to disagree with, and
 * the first one written would have silently disagreed with CI.
 *
 * The two pins are handled asymmetrically, on purpose:
 *
 *   node — ONE authority, `.nvmrc`. flake.nix reads it with `builtins.readFile`
 *          and CI reads it via `actions/setup-node`'s `node-version-file`.
 *          Neither restates a version, so neither can drift. What this file
 *          guards is that the arrangement is still WIRED THAT WAY: a future
 *          edit that hardcodes `node-version: 22` back into the workflow would
 *          reintroduce exactly the split described above, and nothing else
 *          would notice.
 *
 *   pnpm — TWO statements, because `pnpm/action-setup` reads only its own
 *          `version:` input or `package.json`'s `packageManager` field, and
 *          adding `packageManager` would change what the PLATFORM's builder
 *          does, since it runs against that same file. So the major is written
 *          down twice and asserted equal here. This is the assertion that
 *          actually compares two values; the node ones assert a structure.
 *
 * A THIRD consumer joins them at the bottom of this file: the PLATFORM's own
 * builder, driven by `block.manifest.json`'s `buildCommand`. CI green says
 * nothing about that one — `.github/` is not part of the submitted bundle — so
 * the workflow and the manifest are two independent statements of "how this
 * repo is built", and the last assertion derives both and compares them.
 *
 * Read off disk rather than imported: `tsconfig.json` scopes `include` to
 * `src` (plus `vite.config.ts`), and `import.meta.url` makes the paths
 * independent of the runner's working directory.
 *
 * Every extractor below THROWS when the shape it expects is missing, rather
 * than returning undefined. A guard that silently passes once someone deletes
 * the step it inspects is worse than no guard: it reads as coverage while
 * providing none.
 */

function repoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/**
 * The `with:` block belonging to one `- uses: <action>` step, as raw lines.
 *
 * Deliberately not a YAML parse: this repo ships no YAML dependency, and
 * adding one to read a workflow would be a bigger change than the thing it
 * verifies. The workflow is small and fully under this repo's control, so a
 * line scan bounded by the next list item at the step's own indentation is
 * sufficient — and it fails loudly if the step is gone.
 */
function stepBlock(workflow: string, actionPrefix: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*-\\s+uses:\\s*${actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(line),
  );
  const startLine = start === -1 ? undefined : lines[start];
  if (startLine === undefined) {
    // `tsconfig.json` sets `noUncheckedIndexedAccess`, so this narrowing is
    // what makes `startLine` a string below — and it is the same throw the
    // -1 case wants anyway.
    throw new Error(`ci.yml has no \`- uses: ${actionPrefix}…\` step`);
  }
  const indent = startLine.match(/^\s*/)![0].length;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // A new list item at the same indentation ends this step. Blank lines and
    // deeper-indented lines belong to it.
    if (line.trim() !== '' && new RegExp(`^\\s{${indent}}-\\s`).test(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * The package manager CI installs, derived from the workflow rather than
 * assumed: a `pnpm/action-setup` step means pnpm, and its absence means the
 * plain `npm` that ships with `actions/setup-node`. Throws if the workflow is
 * empty, so "no evidence either way" can never be compared to anything.
 */
function ciPackageManager(workflow: string): 'pnpm' | 'npm' {
  if (workflow.trim() === '') {
    throw new Error('.github/workflows/ci.yml is empty — no CI package manager to compare against');
  }
  return /^\s*-\s+uses:\s*pnpm\/action-setup@/m.test(workflow) ? 'pnpm' : 'npm';
}

/** Every `key: value` at any depth inside a step block, as pairs. */
function settingsIn(block: string[]): Array<[string, string]> {
  return block
    .map((line) => line.match(/^\s*([A-Za-z][\w-]*):\s*(\S.*?)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]] as [string, string]);
}

describe('toolchain lockstep', () => {
  const workflow = repoFile('../.github/workflows/ci.yml');
  const flake = repoFile('../flake.nix');
  const nvmrc = repoFile('../.nvmrc');

  it('states the node major once, in .nvmrc, in the form the flake can consume', () => {
    // flake.nix interpolates this straight into the attribute name
    // `pkgs."nodejs_${nodeMajor}"`. A patch-level `.nvmrc` (`24.19.0`) names an
    // attribute nixpkgs does not have, so the shell dies on eval rather than
    // falling back — the failure is loud, but it is also entirely preventable
    // here, and `actions/setup-node` accepts a bare major just as happily.
    expect(nvmrc.trim()).toMatch(/^\d+$/);
  });

  it('has flake.nix read .nvmrc rather than restating the node version', () => {
    expect(flake).toContain('builtins.readFile ./.nvmrc');
  });

  it('has CI read .nvmrc rather than restating the node version', () => {
    const setupNode = settingsIn(stepBlock(workflow, 'actions/setup-node@'));
    const byKey = new Map(setupNode);

    expect(byKey.get('node-version-file')).toBe('.nvmrc');

    // The half that actually stops the drift. `node-version-file` being
    // present proves nothing on its own: `actions/setup-node` accepts BOTH
    // inputs and prefers the literal `node-version`, so a workflow carrying
    // both would read `.nvmrc` in this assertion's eyes and install something
    // else in reality. This repo shipped `node-version: '22'` until the pnpm
    // conversion, so the literal is the exact shape most likely to come back.
    expect(byKey.has('node-version')).toBe(false);
  });

  it('pins the same pnpm major in flake.nix and in CI', () => {
    const flakePin = flake.match(/^\s*pnpmMajor = "(\d+)";/m);
    if (!flakePin) {
      throw new Error('flake.nix has no `pnpmMajor = "<n>";` line to compare against');
    }

    const setupPnpm = new Map(settingsIn(stepBlock(workflow, 'pnpm/action-setup@')));
    const ciPin = setupPnpm.get('version');
    if (ciPin === undefined) {
      // Not a soft pass. `pnpm/action-setup` falls back to package.json's
      // `packageManager` when `version:` is absent — and this repo declares no
      // such field, so the step would fail at runtime. Either way the pins are
      // no longer comparable, which is the state this guard exists to catch.
      throw new Error('ci.yml pnpm/action-setup step declares no `version:` to compare against');
    }

    // Majors, not full versions: nixpkgs carries whatever patch it carries and
    // the action resolves the latest of the major. Pinning the patch here
    // would rot on a routine `nix flake update` and turn main red for nothing —
    // a permanently-red gate teaches everyone to merge through it.
    expect(ciPin).toBe(flakePin[1]);
  });

  it('keeps the platform builder on the same package manager as CI', () => {
    // `block.manifest.json`'s `buildCommand` is what the PLATFORM runs when it
    // builds the submitted bundle, and CI green says nothing about it: the
    // bundle does not carry `.github/`, so the workflow never executes on the
    // platform's side and the platform's command never executes on CI's. A
    // mismatch hands the builder a tree its package manager cannot install
    // reproducibly. Not hypothetical — this repo shipped exactly that state
    // (an npm `buildCommand` beside a pnpm-only lockfile) and it took
    // `civitai app validate` to catch it, long after CI had gone green.
    //
    // BOTH sides are derived. Hardcoding `'pnpm'` on the CI side would make
    // this assertion's name a lie: switching CI to npm would leave it green
    // while the two disagreed, which is the precise failure it is named for.
    const ci = ciPackageManager(workflow);

    const manifest = JSON.parse(repoFile('../block.manifest.json')) as {
      buildCommand?: unknown;
    };
    if (typeof manifest.buildCommand !== 'string') {
      throw new Error('block.manifest.json has no string "buildCommand" to compare against');
    }
    const builder = manifest.buildCommand.trim().split(/\s+/)[0];
    if (builder === undefined || builder === '') {
      throw new Error('block.manifest.json "buildCommand" is empty — no package manager to compare against');
    }

    expect(builder).toBe(ci);
  });
});
