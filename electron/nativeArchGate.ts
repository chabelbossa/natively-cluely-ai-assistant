/**
 * NATIVE-ARCH BOOT GATE — module-load-time arch verification.
 *
 * Refuses to launch if better-sqlite3 / keytar were built for a different
 * architecture than this hardware. Without this gate, a Rosetta-poisoned
 * `.node` (x86_64 on arm64) fails at first dlopen inside DatabaseManager's
 * `import Database from 'better-sqlite3'` — which fires at module-load time,
 * well before app.whenReady() can run any async gate.
 *
 * The gate must run BEFORE the imports in main.ts can pull in
 * DatabaseManager: main.ts does `import './nativeArchGate'` as its FIRST
 * import. With CommonJS output (esbuild format:'cjs', no bundling), that
 * compiles to the first `require("./nativeArchGate")`, so this module's
 * IIFE runs first and any later require chain that would dlopen
 * better-sqlite3 never starts if the gate throws.
 *
 * On mismatch: throws synchronously. The uncaughtException handler below
 * renders the dialog and exits with code 1. We do NOT call process.exit()
 * here because the user hasn't seen the dialog yet — process.exit() races
 * with showErrorBox's modal rendering.
 */
(() => {
  // ESCAPE HATCH: this gate's only failure mode of last resort is a
  // FALSE POSITIVE — misclassifying a healthy `.node` as wrong-arch and
  // showing a fatal modal + app.exit(1) BEFORE any window exists, which
  // permanently locks the user out of boot with no in-app recovery.
  // NATIVELY_SKIP_ARCH_GATE=1 disables the gate entirely so a false positive
  // can never trap a user; worst case without the gate is a clear dlopen
  // error later, not a silent lockout. (The gate remains ON by default.)
  if (process.env.NATIVELY_SKIP_ARCH_GATE === '1') {
    try { console.warn('[nativeArch] NATIVELY_SKIP_ARCH_GATE=1 — boot arch gate DISABLED'); } catch { /* best-effort */ }
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');

  /**
   * Walk up from a starting directory until we find a directory that
   * contains node_modules/better-sqlite3/build/Release/better_sqlite3.node.
   * In the transpiled main.js, __dirname is dist-electron/electron/, but the
   * actual node_modules lives at the repo root, two levels up. Walking up is
   * robust to both bundled and source-run layouts.
   */
  function findRepoRoot(startDir: string): string {
    let dir = startDir;
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  /**
   * Detect a packaged build WITHOUT requiring the Electron `app` object
   * (the gate may run before electron is safe to load). The two signals:
   *
   *   1. Electron sets `process.resourcesPath` to `…/Natively.app/Contents/Resources`
   *      when the bundle is packaged. In dev it's `undefined` or points
   *      at the running `electron` executable's Resources dir.
   *   2. `process.defaultApp === true` is set when Electron is invoked
   *      as a normal CLI binary (i.e. dev mode), and is NOT set when the
   *      app was launched from a `.app` bundle.
   */
  function isPackagedBuild(): boolean {
    const rp = (process as any).resourcesPath as string | undefined;
    if (typeof rp !== 'string') return false;
    if ((process as any).defaultApp === true) return false;
    // Real packaged apps: resourcesPath ends in a `.app/Contents/Resources`
    // segment. There is no `.app` directory segment in any Electron dev tree.
    return rp.includes('.app/');
  }

  // Register the arch-mismatch handler BEFORE running the check. The
  // check throws synchronously, and if the throw reaches process-level
  // without a handler attached, it becomes an uncaughtException with
  // no useful UX.
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (!(err instanceof Error) || !/^\[nativeArch(?::packaged)?\]/.test(err.message)) return;
    const packaged = err.message.startsWith('[nativeArch:packaged]');
    const detail = err.message
      .replace(/^\[nativeArch(?::packaged)?\]\s*/, '')
      .replace(/^Architecture mismatch:\s*/, '');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dialog, app: electronApp } = require('electron');
      // showErrorBox is modal and blocks until the user clicks OK.
      dialog.showErrorBox(
        packaged
          ? 'Natively was built for a different chip — please reinstall'
          : 'Native modules are wrong architecture — run this command to fix:',
        detail,
      );
      electronApp.exit(1);
    } catch {
      // Electron not loaded (e.g. running under bare node in a test or
      // harness). Print the diagnostic to stderr and exit cleanly with
      // code 1 — every consumer in the toolchain treats non-zero as failure.
      console.error('[nativeArch] ' + detail);
      process.exit(1);
    }
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nativeArch = require('./lib/nativeArch.cjs');
    const packaged = isPackagedBuild();
    const verifyOpts = packaged
      ? { resourcesPath: (process as any).resourcesPath, packaged: true }
      : {};
    const repoRoot = packaged ? undefined : findRepoRoot(__dirname);
    const result = nativeArch.verifyAll(repoRoot, verifyOpts);
    if (result.ok || result.skipped) return;
    const detail = packaged
      ? `Detected: ${result.hardware}\n` +
        `Built:    ${result.mismatches.map((m: any) => m.actual).join(', ')}\n\n` +
        `${result.fix}\n\n` +
        `Mismatched files:\n` +
        result.mismatches.map((m: any) => `  - ${m.path} (built ${m.actual}, need ${m.expected})`).join('\n')
      : `Detected: ${result.hardware}\n` +
        `Built:    ${result.mismatches.map((m: any) => m.actual).join(', ')}\n\n` +
        `The compiled binaries were built under Rosetta and will not load under the ` +
        `native Electron runtime. The local database, meeting history, and modes ` +
        `will not work until rebuilt.\n\n` +
        `Fix (copy and paste into a terminal):\n\n` +
        `  ${result.fix}\n\n` +
        `Mismatched files:\n` +
        result.mismatches.map((m: any) => `  - ${m.path} (built ${m.actual}, need ${m.expected})`).join('\n');
    throw new Error(`${packaged ? '[nativeArch:packaged]' : '[nativeArch]'} Architecture mismatch:\n` + detail);
  } catch (e: any) {
    if (e instanceof Error && /^\[nativeArch(?::packaged)?\]/.test(e.message)) {
      // Re-throw synchronously so the uncaughtException handler above
      // displays the dialog and exits cleanly.
      throw e;
    }
    // Some other failure during the verify itself (e.g. missing sysctl,
    // missing file binary). Don't block the app on infra issues — fall
    // through. The postinstall guard still covers the actual mismatch case.
    console.warn('[nativeArch] verify failed (non-fatal, will continue):', e?.message || e);
  }
})();

export {};
