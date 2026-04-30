const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Helper Disguise Configuration ───
// Display name used for helper processes in Activity Monitor
const DISGUISE_BASE = 'CoreServices';

const HELPER_SUFFIXES = ['', ' (GPU)', ' (Renderer)', ' (Plugin)'];

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
    // CRITICAL: ALL executables that call ScreenCaptureKit or CoreAudio Tap
    // MUST have the com.apple.security.screen-capture entitlement. The Rust
    // native module (index.*.node) runs inside "Natively Helper.app", so both
    // the .node binary AND the Helper .app must carry the entitlement.
    // Without it, macOS TCC silently blocks audio capture (rms=0.0).

    const entitlementsPath = path.join(context.packager.info.projectDir, 'assets', 'entitlements.mac.plist');

    if (!fs.existsSync(entitlementsPath)) {
        throw new Error(`[Ad-Hoc Signing] Entitlements file not found: ${entitlementsPath}`);
    }

    const signWithEntitlements = (targetPath, label) => {
        if (!fs.existsSync(targetPath)) {
            console.log(`[Ad-Hoc Signing] Skipping (not found): ${label || targetPath}`);
            return;
        }
        console.log(`[Ad-Hoc Signing] Signing with entitlements: ${label || path.basename(targetPath)}`);
        execSync(`codesign --force --entitlements "${entitlementsPath}" --sign - "${targetPath}"`, { stdio: 'inherit' });
    };

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

    // ── Step 2a: Deep sign (baseline — no entitlements) ──
    // This signs all nested Mach-O files, dylibs, and frameworks with a plain
    // ad-hoc signature. We then OVERRIDE specific binaries with entitlements.
    console.log(`[Ad-Hoc Signing] Deep-signing all nested code in ${appPath}...`);

    try {
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
        console.log('[Ad-Hoc Signing] Baseline deep sign completed.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed during deep signing pass:', error);
        throw error;
    }

    // ── Step 2b: Re-sign native binaries with entitlements (innermost first) ──
    const parakeetHelperPath = path.join(appPath, 'Contents', 'Resources', 'helpers', 'parakeet-stt-helper');
    signWithEntitlements(parakeetHelperPath, 'parakeet-stt-helper');

    const unpackedNativeDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'native-module');
    if (fs.existsSync(unpackedNativeDir)) {
        const files = fs.readdirSync(unpackedNativeDir);
        for (const file of files) {
            if (file.endsWith('.node')) {
                try {
                    signWithEntitlements(path.join(unpackedNativeDir, file), file);
                } catch (error) {
                    console.error(`[Ad-Hoc Signing] Failed to sign ${file}:`, error);
                }
            }
        }
    }

    // ── Step 2c: Re-sign ALL Electron Helper apps with entitlements ──
    // The Rust native module (.node) is loaded by "Natively Helper.app" (Electron's
    // main process). Without screen-capture entitlement on the Helper, macOS TCC
    // silently blocks ScreenCaptureKit and CoreAudio Tap — producing rms=0.0.
    const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
    for (const suffix of HELPER_SUFFIXES) {
        const helperName = `${appName} Helper${suffix}`;
        const helperPath = path.join(frameworksDir, `${helperName}.app`);
        signWithEntitlements(helperPath, helperName);
    }

    // ── Step 2d: Seal the top-level .app bundle ──
    // This must be LAST — it records hashes of all inner signatures.
    try {
        console.log(`[Ad-Hoc Signing] Sealing top-level app ${appPath}...`);
        execSync(`codesign --force --entitlements "${entitlementsPath}" --sign - "${appPath}"`, { stdio: 'inherit' });
        console.log('[Ad-Hoc Signing] Successfully sealed the application.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to seal the application:', error);
        throw error;
    }

    // ── Step 3: Verify entitlements on critical binaries ──
    console.log('[Ad-Hoc Signing] Verifying entitlements...');
    verifyEntitlement(path.join(appPath, 'Contents', 'MacOS', appName), 'Main executable');
    verifyEntitlement(path.join(frameworksDir, `${appName} Helper.app`), 'Main Helper');
    const nodeFiles = fs.existsSync(unpackedNativeDir) ? fs.readdirSync(unpackedNativeDir).filter(f => f.endsWith('.node')) : [];
    for (const file of nodeFiles) {
        verifyEntitlement(path.join(unpackedNativeDir, file), file);
    }
};
