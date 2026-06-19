const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Helper Disguise Configuration ───
// Display name used for helper processes in Activity Monitor
const DISGUISE_BASE = 'CoreServices';

const HELPER_SUFFIXES = ['', ' (GPU)', ' (Renderer)', ' (Plugin)'];
const FRAMEWORK_NAMES = [
    'Electron Framework.framework',
    'Mantle.framework',
    'ReactiveObjC.framework',
    'Squirrel.framework',
];

function codesign(args, label) {
    console.log(`[Ad-Hoc Signing] codesign ${label || args[args.length - 1]}`);
    execFileSync('codesign', args, { stdio: 'inherit' });
}

function signPlain(targetPath, label) {
    if (!fs.existsSync(targetPath)) {
        console.log(`[Ad-Hoc Signing] Skipping (not found): ${label || targetPath}`);
        return;
    }
    codesign([
        '--force',
        '--options',
        'runtime',
        '--timestamp=none',
        '--sign',
        '-',
        targetPath,
    ], label || path.basename(targetPath));
}

function signWithEntitlements(targetPath, entitlementsPath, label) {
    if (!fs.existsSync(targetPath)) {
        console.log(`[Ad-Hoc Signing] Skipping (not found): ${label || targetPath}`);
        return;
    }
    codesign([
        '--force',
        '--options',
        'runtime',
        '--timestamp=none',
        '--entitlements',
        entitlementsPath,
        '--sign',
        '-',
        targetPath,
    ], label || path.basename(targetPath));
}

function verifySignature(targetPath, label) {
    if (!fs.existsSync(targetPath)) return;
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', targetPath], { stdio: 'inherit' });
    const details = execSync(`codesign -dv --verbose=4 "${targetPath.replace(/"/g, '\\"')}" 2>&1`, {
        encoding: 'utf8',
    });
    const output = String(details);
    if (!/flags=.*runtime/.test(output)) {
        throw new Error(`[Ad-Hoc Signing] ${label || targetPath} is missing hardened runtime flags.`);
    }
}

function getDirectChildPaths(dirPath, predicate) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
        .map((entry) => path.join(dirPath, entry))
        .filter(predicate);
}

/**
 * Update the display names inside each helper's Info.plist so Activity Monitor
 * shows "CoreServices Helper" instead of "Natively Helper".
 *
 * IMPORTANT: We only modify CFBundleDisplayName and CFBundleName.
 * We do NOT rename the .app folders or the executable binaries — doing so
 * would break Electron's internal process spawning (Chromium hardcodes the
 * helper paths based on productName).
 */
function disguiseHelperPlists(appOutDir, appName) {
    const frameworksDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Frameworks');

    if (!fs.existsSync(frameworksDir)) {
        console.log('[Helper Disguise] Frameworks directory not found, skipping.');
        return;
    }

    for (const suffix of HELPER_SUFFIXES) {
        const helperName = `${appName} Helper${suffix}`;
        const disguisedName = `${DISGUISE_BASE} Helper${suffix}`;
        const helperAppPath = path.join(frameworksDir, `${helperName}.app`);
        const plistPath = path.join(helperAppPath, 'Contents', 'Info.plist');

        if (!fs.existsSync(plistPath)) {
            console.log(`[Helper Disguise] Skipping (not found): ${helperName}.app`);
            continue;
        }

        console.log(`[Helper Disguise] ${helperName} → display as "${disguisedName}"`);

        try {
            // Update CFBundleDisplayName (Activity Monitor display)
            execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName '${disguisedName}'" "${plistPath}"`, { stdio: 'pipe' });
            // Update CFBundleName (Dock / menu bar fallback)
            execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName '${disguisedName}'" "${plistPath}"`, { stdio: 'pipe' });
        } catch (err) {
            console.warn(`[Helper Disguise] PlistBuddy warning for ${helperName}:`, err.message);
        }
    }

    console.log('[Helper Disguise] All helper plists updated successfully.');
}

exports.default = async function (context) {
    // Only process on macOS
    if (process.platform !== 'darwin') {
        return;
    }

    const appOutDir = context.appOutDir;
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    // ── Step 1: Disguise helper display names (before signing) ──
    try {
        disguiseHelperPlists(appOutDir, appName);
    } catch (error) {
        console.error('[Helper Disguise] Failed to update helper plists:', error);
        // Non-fatal: continue to signing
    }

    // ── Step 2: Ad-hoc sign all code inside-out with entitlements ──
    //
    // macOS codesign requires INSIDE-OUT signing: innermost binaries first,
    // then enclosing .app bundles, then the top-level .app. Each outer seal
    // records hashes of inner signatures — if you sign outer first, then
    // re-sign inner, the outer seal is invalidated.
    //
    // CRITICAL: all processes that call ScreenCaptureKit or CoreAudio Tap must
    // have the com.apple.security.screen-capture entitlement. The Rust native
    // module (index.*.node) is a Mach-O shared library loaded by Electron, so it
    // needs a valid runtime signature for library validation; the entitlement
    // belongs on the hosting .app process.

    const entitlementsPath = path.join(context.packager.info.projectDir, 'assets', 'entitlements.mac.plist');

    if (!fs.existsSync(entitlementsPath)) {
        throw new Error(`[Ad-Hoc Signing] Entitlements file not found: ${entitlementsPath}`);
    }

    const verifyEntitlement = (targetPath, label) => {
        if (!fs.existsSync(targetPath)) return;
        try {
            const output = execSync(`codesign -d --entitlements - "${targetPath}" 2>&1`, { encoding: 'utf8' });
            if (output.includes('screen-capture')) {
                console.log(`[Ad-Hoc Signing] ✅ ${label}: screen-capture entitlement present`);
            } else {
                console.error(`[Ad-Hoc Signing] ⚠️  ${label}: screen-capture entitlement MISSING!`);
            }
        } catch (err) {
            console.warn(`[Ad-Hoc Signing] Could not verify ${label}:`, err.message);
        }
    };

    // ── Step 2a: Runtime deep-sign baseline ──
    // macOS 27 rejects ad-hoc nested code that verifies on disk but lacks
    // hardened runtime flags at launch. Start with a runtime-aware deep pass,
    // then explicitly re-seal the important nested bundles inside-out.
    try {
        console.log(`[Ad-Hoc Signing] Deep-signing all nested code with runtime in ${appPath}...`);
        codesign([
            '--force',
            '--deep',
            '--options',
            'runtime',
            '--timestamp=none',
            '--sign',
            '-',
            appPath,
        ], 'runtime deep baseline');
        console.log('[Ad-Hoc Signing] Runtime deep sign completed.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed during runtime deep signing pass:', error);
        throw error;
    }

    const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');

    // ── Step 2b: Re-sign standalone binaries with entitlements (innermost first) ──
    const parakeetHelperPath = path.join(appPath, 'Contents', 'Resources', 'helpers', 'parakeet-stt-helper');
    signWithEntitlements(parakeetHelperPath, entitlementsPath, 'parakeet-stt-helper');

    const unpackedNativeDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'native-module');
    if (fs.existsSync(unpackedNativeDir)) {
        const files = fs.readdirSync(unpackedNativeDir);
        for (const file of files) {
            if (file.endsWith('.node')) {
                try {
                    signPlain(path.join(unpackedNativeDir, file), file);
                } catch (error) {
                    console.error(`[Ad-Hoc Signing] Failed to sign ${file}:`, error);
                }
            }
        }
    }

    const crashpadHandlerPath = path.join(
        frameworksDir,
        'Electron Framework.framework',
        'Versions',
        'A',
        'Helpers',
        'chrome_crashpad_handler',
    );
    signPlain(crashpadHandlerPath, 'chrome_crashpad_handler');

    // ── Step 2c: Re-sign frameworks before enclosing helper apps ──
    for (const frameworkPath of getDirectChildPaths(
        frameworksDir,
        (candidate) => FRAMEWORK_NAMES.includes(path.basename(candidate)),
    )) {
        signPlain(frameworkPath, path.basename(frameworkPath));
    }

    // ── Step 2d: Re-sign ALL Electron Helper apps with entitlements ──
    // The Rust native module (.node) is loaded by "Natively Helper.app" (Electron's
    // main process). Without screen-capture entitlement on the Helper, macOS TCC
    // silently blocks ScreenCaptureKit and CoreAudio Tap — producing rms=0.0.
    for (const suffix of HELPER_SUFFIXES) {
        const helperName = `${appName} Helper${suffix}`;
        const helperPath = path.join(frameworksDir, `${helperName}.app`);
        signWithEntitlements(helperPath, entitlementsPath, helperName);
    }

    // ── Step 2e: Seal the top-level .app bundle ──
    // This must be LAST — it records hashes of all inner signatures.
    try {
        console.log(`[Ad-Hoc Signing] Sealing top-level app ${appPath}...`);
        signWithEntitlements(appPath, entitlementsPath, appName);
        console.log('[Ad-Hoc Signing] Successfully sealed the application.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to seal the application:', error);
        throw error;
    }

    // ── Step 3: Verify entitlements on critical binaries ──
    console.log('[Ad-Hoc Signing] Verifying entitlements...');
    verifyEntitlement(path.join(appPath, 'Contents', 'MacOS', appName), 'Main executable');
    verifyEntitlement(path.join(frameworksDir, `${appName} Helper.app`), 'Main Helper');
    verifyEntitlement(parakeetHelperPath, 'parakeet-stt-helper');
    const nodeFiles = fs.existsSync(unpackedNativeDir) ? fs.readdirSync(unpackedNativeDir).filter(f => f.endsWith('.node')) : [];
    verifySignature(appPath, appName);
    verifySignature(path.join(frameworksDir, 'Electron Framework.framework'), 'Electron Framework');
    verifySignature(parakeetHelperPath, 'parakeet-stt-helper');
    for (const file of nodeFiles) {
        verifySignature(path.join(unpackedNativeDir, file), file);
    }
};
