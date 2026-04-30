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

    // ── Step 2: Ad-hoc sign nested code, then seal the app ──
    // Resolve the path to the entitlements file so V8 gets JIT memory permissions
    const entitlementsPath = path.join(context.packager.info.projectDir, 'assets', 'entitlements.mac.plist');

    const signWithEntitlements = (targetPath) => {
        if (!fs.existsSync(targetPath)) return;
        console.log(`[Ad-Hoc Signing] Signing ${targetPath} with entitlements...`);
        execSync(`codesign --force --entitlements "${entitlementsPath}" --sign - "${targetPath}"`, { stdio: 'inherit' });
    };

    // First pass: sign Electron frameworks/helpers and all nested Mach-O files.
    // The final app seal is intentionally performed again after entitlement-bearing
    // binaries are re-signed below.
    console.log(`[Ad-Hoc Signing] Signing nested code in ${appPath}...`);

    try {
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
        console.log('[Ad-Hoc Signing] Nested signing pass completed.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed during nested signing pass:', error);
        throw error;
    }

    // Re-sign entitlement-bearing native executables after the deep pass, then seal
    // the top-level .app without --deep so macOS sees a coherent bundle seal.
    const parakeetHelperPath = path.join(appPath, 'Contents', 'Resources', 'helpers', 'parakeet-stt-helper');
    signWithEntitlements(parakeetHelperPath);

    const unpackedNativeDir = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'native-module');
    if (fs.existsSync(unpackedNativeDir)) {
        const files = fs.readdirSync(unpackedNativeDir);
        for (const file of files) {
            if (file.endsWith('.node')) {
                try {
                    signWithEntitlements(path.join(unpackedNativeDir, file));
                } catch (error) {
                    console.error(`[Ad-Hoc Signing] Failed to sign ${file}:`, error);
                }
            }
        }
    }

    try {
        console.log(`[Ad-Hoc Signing] Sealing top-level app ${appPath}...`);
        execSync(`codesign --force --entitlements "${entitlementsPath}" --sign - "${appPath}"`, { stdio: 'inherit' });
        console.log('[Ad-Hoc Signing] Successfully sealed the application.');
    } catch (error) {
        console.error('[Ad-Hoc Signing] Failed to seal the application:', error);
        throw error;
    }
};
