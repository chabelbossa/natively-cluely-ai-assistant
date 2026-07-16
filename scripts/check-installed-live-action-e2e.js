#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appPath = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '/Applications/Natively.app');
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Natively');
const timeoutMs = Number(process.env.NATIVELY_INSTALLED_E2E_TIMEOUT_MS || 180_000);
const requestedModel = String(process.env.NATIVELY_E2E_MODEL || 'codex:gpt-5.6-terra').trim();
const playwrightElectronLoader = path.join(__dirname, 'playwright-electron-autostart-loader.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installedProcessIds() {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const processIds = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (command.includes(executablePath)) processIds.add(pid);
    if (command.includes(path.join(appPath, 'Contents', 'Frameworks', 'Natively Helper'))) {
      processIds.add(pid);
      processIds.add(ppid);
    }
  }
  return [...processIds].filter((pid) => Number.isFinite(pid) && pid > 1);
}

async function stopInstalledApp() {
  try {
    execFileSync('osascript', ['-e', 'tell application id "com.electron.meeting-notes" to quit'], { stdio: 'ignore' });
  } catch {}

  const gracefulDeadline = Date.now() + 8_000;
  while (Date.now() < gracefulDeadline && installedProcessIds().length > 0) {
    await sleep(250);
  }

  for (const pid of installedProcessIds()) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  const forcedDeadline = Date.now() + 4_000;
  while (Date.now() < forcedDeadline && installedProcessIds().length > 0) {
    await sleep(200);
  }
  if (installedProcessIds().length > 0) {
    throw new Error(`Could not stop the installed Natively process at ${executablePath}`);
  }
}

async function waitForOverlay(electronApp) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const pages = electronApp.windows();
    const overlay = pages.find((page) => page.url().includes('window=overlay'));
    if (overlay) return overlay;
    await sleep(250);
  }
  throw new Error(`Installed overlay window did not load. URLs: ${electronApp.windows().map((page) => page.url()).join(', ')}`);
}

async function waitForActionStatus(page, actionId, acceptedStatuses) {
  await page.waitForFunction(
    ({ id, statuses }) => {
      const node = document.querySelector(`[data-action-id="${id}"]`);
      return Boolean(node && statuses.includes(node.getAttribute('data-action-status')));
    },
    { id: actionId, statuses: acceptedStatuses },
    { timeout: timeoutMs },
  );
}

async function injectTranscriptAndStartTrace(electronApp) {
  const now = Date.now();
  const segments = [
    {
      speaker: 'Interviewer',
      text: 'Comment allez-vous garantir la cohérence des stocks entre les pharmacies ?',
      timestamp: now - 54_000,
      final: true,
      confidence: 0.98,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
    {
      speaker: 'Interviewer',
      text: "Les stocks des pharmacies peuvent changer hors ligne tandis que l'inventaire central reçoit aussi des réapprovisionnements concurrents.",
      timestamp: now - 29_000,
      final: true,
      confidence: 0.98,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
    {
      speaker: 'Interviewer',
      text: 'Une mauvaise résolution des conflits laisserait un stock négatif et rendrait les quantités affichées peu fiables pour les équipes en magasin.',
      timestamp: now - 6_000,
      final: true,
      confidence: 0.99,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
  ];

  return electronApp.evaluate(({ app }, payload) => {
    const appRoot = app.getAppPath();
    const nodeRequire = process.getBuiltinModule('node:module').createRequire(`${appRoot}/package.json`);
    const pathModule = nodeRequire('node:path');
    const { AppState } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/main.js'));
    const { MeetingDebugRecorder } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/diagnostics/MeetingDebugRecorder.js'));
    const state = AppState.getInstance();
    const manager = state.getIntelligenceManager();
    const recorder = MeetingDebugRecorder.getInstance();
    const llmHelper = state.processingHelper.getLLMHelper();

    manager.reset();
    if (payload.model) llmHelper.setModel(payload.model);
    recorder.startSession({ test: 'installed-live-action-e2e' });
    for (const segment of payload.segments) manager.recordTranscriptOnly(segment);

    return {
      appPath: appRoot,
      isPackaged: app.isPackaged,
      provider: llmHelper.getCurrentProvider(),
      model: llmHelper.getCurrentModel(),
      tracePath: recorder.getCurrentFilePath(),
    };
  }, { segments, model: requestedModel });
}

async function finishTrace(electronApp, success) {
  return electronApp.evaluate(({ app }, didSucceed) => {
    const appRoot = app.getAppPath();
    const nodeRequire = process.getBuiltinModule('node:module').createRequire(`${appRoot}/package.json`);
    const pathModule = nodeRequire('node:path');
    const { MeetingDebugRecorder } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/diagnostics/MeetingDebugRecorder.js'));
    const recorder = MeetingDebugRecorder.getInstance();
    const tracePath = recorder.getCurrentFilePath();
    recorder.finishSession({ test: 'installed-live-action-e2e', success: didSucceed });
    return tracePath;
  }, success);
}

function readTrace(tracePath) {
  assert.ok(tracePath && fs.existsSync(tracePath), `Debug trace was not written: ${tracePath || 'missing path'}`);
  return fs.readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  assert.ok(fs.existsSync(executablePath), `Installed Natively executable missing: ${executablePath}`);
  await stopInstalledApp();

  let electronApp;
  let tracePath = null;
  let traceStarted = false;
  let testSucceeded = false;
  const rendererErrors = [];

  try {
    electronApp = await electron.launch({
      executablePath,
      args: ['-r', playwrightElectronLoader],
      env: {
        ...process.env,
        NATIVELY_MEETING_DEBUG: '1',
      },
      timeout: 60_000,
    });

    const overlay = await waitForOverlay(electronApp);
    overlay.on('pageerror', (error) => rendererErrors.push(error.message));
    await overlay.waitForLoadState('domcontentloaded');
    const actionButton = overlay.locator('[data-testid="natively-action-what-to-answer"]');
    await actionButton.waitFor({ state: 'attached', timeout: 45_000 });

    const appInfo = await injectTranscriptAndStartTrace(electronApp);
    tracePath = appInfo.tracePath;
    traceStarted = true;
    assert.equal(appInfo.isPackaged, true, 'The E2E must run against a packaged application');
    assert.ok(appInfo.appPath.includes('Natively.app/Contents/Resources/app.asar'), `Unexpected packaged root: ${appInfo.appPath}`);
    assert.equal(appInfo.provider, 'codex', `Installed live actions must use Codex, found ${appInfo.provider}`);
    assert.match(appInfo.model, /^codex:gpt-5\.6-(sol|terra|luna)$/, `Installed live action model is not GPT-5.6: ${appInfo.model}`);

    await actionButton.click({ force: true });
    const actionCard = overlay.locator('[data-action-intent="what_to_answer"]').last();
    await actionCard.waitFor({ state: 'attached', timeout: 15_000 });
    const actionId = await actionCard.getAttribute('data-action-id');
    assert.ok(actionId, 'The clicked action did not create an actionId-tagged card');

    await waitForActionStatus(overlay, actionId, ['completed', 'failed']);
    const terminalCard = overlay.locator(`[data-action-id="${actionId}"]`);
    const status = await terminalCard.getAttribute('data-action-status');
    const answer = (await terminalCard.innerText()).trim();
    assert.equal(status, 'completed', `Installed What to say failed: ${answer}`);
    assert.ok(answer.length >= 40, `Installed What to say returned an implausibly short answer: ${answer}`);
    assert.equal(await terminalCard.count(), 1, 'A single actionId must render exactly one terminal card');
    const serviceTier = await terminalCard.getAttribute('data-service-tier');
    assert.match(String(serviceTier || ''), /^(fast|standard)$/, `Missing service-tier telemetry on the terminal card: ${serviceTier}`);
    if (serviceTier === 'standard') {
      assert.equal(await terminalCard.getAttribute('data-service-tier-fallback'), 'true');
      assert.match(answer, /Standard fallback/, 'Standard fallback must be visible in the installed UI');
    }

    const lateToken = ' __LATE_TOKEN_MUST_BE_IGNORED__';
    await electronApp.evaluate(({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('intelligence-suggested-answer-token', {
          token: payload.token,
          question: 'What to Answer',
          confidence: 0.9,
          actionId: payload.actionId,
        });
      }
    }, { actionId, token: lateToken });
    await sleep(500);
    assert.equal((await terminalCard.innerText()).includes(lateToken.trim()), false, 'A token arriving after completion changed the terminal card');

    const lateFinal = `${answer}\n\n[late final coalesced]`;
    await electronApp.evaluate(({ BrowserWindow }, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('intelligence-suggested-answer', {
          answer: payload.answer,
          question: 'What to Answer',
          confidence: 0.9,
          actionId: payload.actionId,
        });
      }
    }, { actionId, answer: lateFinal });
    await sleep(500);
    assert.equal(await terminalCard.count(), 1, 'A late final event created a duplicate card');
    assert.equal(await terminalCard.getAttribute('data-action-status'), 'completed');
    assert.equal((await terminalCard.innerText()).trim(), answer, 'A late final event changed an immutable terminal card');

    tracePath = await finishTrace(electronApp, true);
    traceStarted = false;
    const events = readTrace(tracePath);
    const actionContexts = events.filter((event) => event.type === 'action_context');
    const actionResults = events.filter((event) => event.type === 'action_result' && event.payload?.actionId === actionId);
    assert.equal(actionContexts.length, 1, `Expected one isolated action_context, found ${actionContexts.length}`);
    assert.equal(actionResults.length, 1, `Expected one action_result for ${actionId}, found ${actionResults.length}`);

    const actionResult = actionResults[0];
    const actionTarget = actionContexts[0].payload?.actionTarget || {};
    assert.equal(actionTarget.source, 'interlocutor', `Unexpected action target source: ${JSON.stringify(actionTarget)}`);
    assert.equal(actionTarget.kind, 'direct_question', `Unexpected action target kind: ${JSON.stringify(actionTarget)}`);
    assert.match(
      String(actionTarget.text || ''),
      /cohérence des stocks.*pharmacies/i,
      `The action targeted the wrong turn: ${JSON.stringify(actionTarget)}`,
    );
    assert.ok(String(actionResult.payload?.answer || '').length >= 40, 'The packaged trace does not contain a real answer');
    assert.equal(actionResult.payload?.provider, 'codex', `The packaged action used ${actionResult.payload?.provider}`);
    assert.match(String(actionResult.payload?.model || ''), /gpt-5\.6-(sol|terra|luna)/, `The packaged action used ${actionResult.payload?.model}`);

    await sleep(3_250);
    await actionButton.click({ force: true });
    const secondCard = overlay.locator('[data-action-intent="what_to_answer"]').last();
    await secondCard.waitFor({ state: 'attached', timeout: 15_000 });
    const errorActionId = await secondCard.getAttribute('data-action-id');
    assert.ok(errorActionId && errorActionId !== actionId, 'A second click must receive a new actionId');
    const fastMessage = 'Codex Fast is unavailable for codex:gpt-5.6-terra on account "e2e". No standard-mode fallback was used.';
    await electronApp.evaluate(({ app, BrowserWindow }, payload) => {
      const appRoot = app.getAppPath();
      const nodeRequire = process.getBuiltinModule('node:module').createRequire(`${appRoot}/package.json`);
      const pathModule = nodeRequire('node:path');
      const { AppState } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/main.js'));
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('intelligence-error', {
          error: payload.message,
          mode: 'what_to_say',
          actionId: payload.actionId,
          code: 'fast_unavailable',
        });
      }
      AppState.getInstance().getIntelligenceManager().reset();
    }, { actionId: errorActionId, message: fastMessage });

    await waitForActionStatus(overlay, errorActionId, ['failed']);
    const failedCard = overlay.locator(`[data-action-id="${errorActionId}"]`);
    const failureText = (await failedCard.innerText()).trim();
    assert.equal(await failedCard.count(), 1, 'Fast failure must remain a single action card');
    assert.ok(
      failureText.endsWith(fastMessage),
      `Fast failure must stay explicit and must not be replaced by a generic fallback: ${failureText}`,
    );
    await sleep(750);
    assert.equal(await failedCard.getAttribute('data-action-status'), 'failed', 'A late cancellation/result overwrote the Fast failure');
    assert.equal(rendererErrors.length, 0, `Renderer errors detected: ${rendererErrors.join(' | ')}`);

    testSucceeded = true;
    console.log(JSON.stringify({
      appPath,
      packagedRoot: appInfo.appPath,
      actionId,
      actionTarget,
      provider: actionResult.payload?.provider,
      model: actionResult.payload?.model,
      serviceTier,
      answerCharacters: String(actionResult.payload?.answer || '').length,
      fastUnavailableUi: 'passed',
      tracePath,
    }, null, 2));
  } finally {
    if (electronApp && traceStarted) {
      try {
        tracePath = await finishTrace(electronApp, testSucceeded);
      } catch {}
    }
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {}
    }
    await stopInstalledApp().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[installed-live-action-e2e] failed: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
