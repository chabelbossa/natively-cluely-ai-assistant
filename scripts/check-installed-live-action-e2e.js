#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appPath = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '/Applications/Natively.app');
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Natively');
const timeoutMs = Number(process.env.NATIVELY_INSTALLED_E2E_TIMEOUT_MS || 180_000);
const requestedModel = String(process.env.NATIVELY_E2E_MODEL || 'codex:gpt-5.6-terra').trim();
const playwrightElectronLoader = path.join(__dirname, 'playwright-electron-autostart-loader.js');
const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
const isolatedCredentialsPath = path.join(os.tmpdir(), `natively-installed-e2e-credentials-${process.pid}.enc`);

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
    execFileSync('osascript', ['-e', 'tell application id "com.electron.meeting-notes" to quit'], {
      stdio: 'ignore',
      timeout: 3_000,
      killSignal: 'SIGKILL',
    });
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
  for (const pid of installedProcessIds()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && installedProcessIds().length > 0) {
    await sleep(100);
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

async function injectTranscriptAndStartTrace(electronApp, scenario = 'direct-question') {
  const now = Date.now();
  const directQuestionSegments = [
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
  const workspaceExplanationSegments = [
    {
      speaker: 'Interviewer',
      text: 'Les données existantes seront rattachées à un espace de travail par défaut. Chaque nouvel espace isolera ses comptes WhatsApp, ses conversations et ses paramètres.',
      timestamp: now - 44_000,
      final: true,
      confidence: 0.99,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
    {
      speaker: 'Interviewer',
      text: 'Chaque organisation pourra inviter des utilisateurs avec des rôles et permissions différents. Un freelance pourra être limité à un seul compte WhatsApp ou à une partie des fonctions.',
      timestamp: now - 21_000,
      final: true,
      confidence: 0.99,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
    {
      speaker: 'Interviewer',
      text: 'Les agents de support pourront gérer uniquement les chats autorisés. Essayez de préparer un petit document qui explique comment on va gérer tout ça.',
      timestamp: now - 3_000,
      final: true,
      confidence: 0.99,
      canonicalRole: 'interlocutor',
      source: 'system',
      qualityFlags: ['system_audio', 'speaker_stable', 'trusted_interlocutor'],
    },
  ];
  const segments = scenario === 'workspace-document'
    ? workspaceExplanationSegments
    : directQuestionSegments;

  return electronApp.evaluate(({ app }, payload) => {
    const appRoot = app.getAppPath();
    const nodeRequire = process.getBuiltinModule('node:module').createRequire(`${appRoot}/package.json`);
    const pathModule = nodeRequire('node:path');
    const { AppState } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/main.js'));
    const { MeetingDebugRecorder } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/diagnostics/MeetingDebugRecorder.js'));
    const { CredentialsManager } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/services/CredentialsManager.js'));
    const state = AppState.getInstance();
    const manager = state.getIntelligenceManager();
    const recorder = MeetingDebugRecorder.getInstance();
    const llmHelper = state.processingHelper.getLLMHelper();

    const fsModule = nodeRequire('node:fs');
    const auth = JSON.parse(fsModule.readFileSync(payload.codexAuthPath, 'utf8'));
    const tokens = auth.tokens || {};
    const decodeJwtPayload = (token) => {
      try {
        return JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
      } catch {
        return {};
      }
    };
    const identityClaims = decodeJwtPayload(tokens.id_token || tokens.access_token);
    const accessClaims = decodeJwtPayload(tokens.access_token);
    const credentialsManager = CredentialsManager.getInstance();
    credentialsManager.saveCredentials = () => {};
    credentialsManager.credentials.codexAccounts = [{
      alias: 'installed-e2e',
      email: String(identityClaims.email || identityClaims['https://api.openai.com/profile']?.email || 'codex-e2e@local').toLowerCase(),
      enabled: true,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: new Date(Number(accessClaims.exp || 0) * 1000 || Date.now() + 3_600_000).toISOString(),
      obtainedAt: auth.last_refresh || new Date().toISOString(),
      consecutiveErrors: 0,
      requestCount: 0,
      weight: 1,
    }];
    llmHelper.initializeCodexAuth();

    manager.reset();
    if (payload.model) llmHelper.setModel(payload.model);
    recorder.startSession({ test: 'installed-live-action-e2e', scenario: payload.scenario });
    for (const segment of payload.segments) manager.recordTranscriptOnly(segment);

    return {
      appPath: appRoot,
      isPackaged: app.isPackaged,
      provider: llmHelper.getCurrentProvider(),
      model: llmHelper.getCurrentModel(),
      tracePath: recorder.getCurrentFilePath(),
    };
  }, { segments, model: requestedModel, scenario, codexAuthPath });
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
  assert.ok(fs.existsSync(codexAuthPath), `Codex CLI authentication missing: ${codexAuthPath}`);
  fs.rmSync(isolatedCredentialsPath, { force: true });
  await stopInstalledApp();

  let electronApp;
  let tracePath = null;
  let traceStarted = false;
  let testSucceeded = false;
  const rendererErrors = [];

  try {
    console.log('[installed-live-action-e2e] launching packaged app');
    electronApp = await electron.launch({
      executablePath,
      args: ['-r', playwrightElectronLoader],
      env: {
        ...process.env,
        NATIVELY_MEETING_DEBUG: '1',
        NATIVELY_CREDENTIALS_PATH: isolatedCredentialsPath,
      },
      timeout: 60_000,
    });

    console.log('[installed-live-action-e2e] waiting for overlay');
    const overlay = await waitForOverlay(electronApp);
    console.log(`[installed-live-action-e2e] overlay ready: ${overlay.url()}`);
    overlay.on('pageerror', (error) => rendererErrors.push(error.message));
    await overlay.waitForLoadState('domcontentloaded');
    const actionButton = overlay.locator('[data-testid="natively-action-what-to-answer"]');
    await actionButton.waitFor({ state: 'attached', timeout: 45_000 });

    console.log('[installed-live-action-e2e] injecting direct-question context');
    const appInfo = await injectTranscriptAndStartTrace(electronApp);
    console.log('[installed-live-action-e2e] direct-question context injected');
    tracePath = appInfo.tracePath;
    traceStarted = true;
    assert.equal(appInfo.isPackaged, true, 'The E2E must run against a packaged application');
    assert.ok(appInfo.appPath.includes('Natively.app/Contents/Resources/app.asar'), `Unexpected packaged root: ${appInfo.appPath}`);
    assert.equal(appInfo.provider, 'codex', `Installed live actions must use Codex, found ${appInfo.provider}`);
    assert.match(appInfo.model, /^codex:gpt-5\.6-(sol|terra|luna)$/, `Installed live action model is not GPT-5.6: ${appInfo.model}`);

    await actionButton.click({ force: true });
    console.log('[installed-live-action-e2e] direct-question action clicked');
    const actionCard = overlay.locator('[data-action-intent="what_to_answer"]').last();
    await actionCard.waitFor({ state: 'attached', timeout: 15_000 });
    const actionId = await actionCard.getAttribute('data-action-id');
    assert.ok(actionId, 'The clicked action did not create an actionId-tagged card');

    await waitForActionStatus(overlay, actionId, ['completed', 'failed']);
    console.log('[installed-live-action-e2e] direct-question action reached terminal state');
    const terminalCard = overlay.locator(`[data-action-id="${actionId}"]`);
    const status = await terminalCard.getAttribute('data-action-status');
    const answer = (await terminalCard.innerText()).trim();
    assert.equal(status, 'completed', `Installed What to say failed: ${answer}`);
    assert.ok(answer.length >= 120, `Installed What to say returned an underdeveloped answer: ${answer}`);
    assert.equal(await terminalCard.count(), 1, 'A single actionId must render exactly one terminal card');
    const serviceTier = await terminalCard.getAttribute('data-service-tier');
    assert.equal(serviceTier, 'fast', `Installed GPT-5.6 action did not use Fast: ${serviceTier}`);

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
    const directAnswer = String(actionResult.payload?.answer || '');
    assert.ok(directAnswer.length >= 120, 'The packaged trace does not contain a substantive answer');
    const directAnswerNormalized = directAnswer.toLocaleLowerCase('fr-FR');
    const coveredStockFacts = ['stock', 'hors ligne', 'conflit', 'idempotent', 'version', 'transaction', 'négatif', 'synchron']
      .filter((term) => directAnswerNormalized.includes(term)).length;
    assert.ok(coveredStockFacts >= 2, `The direct answer ignored the stock-consistency constraints: ${directAnswer}`);
    assert.equal(actionResult.payload?.provider, 'codex', `The packaged action used ${actionResult.payload?.provider}`);
    assert.match(String(actionResult.payload?.model || ''), /gpt-5\.6-(sol|terra|luna)/, `The packaged action used ${actionResult.payload?.model}`);

    await sleep(3_250);
    console.log('[installed-live-action-e2e] injecting workspace-document context');
    const workspaceInfo = await injectTranscriptAndStartTrace(electronApp, 'workspace-document');
    tracePath = workspaceInfo.tracePath;
    traceStarted = true;
    await actionButton.click({ force: true });
    console.log('[installed-live-action-e2e] workspace-document action clicked');
    const secondCard = overlay.locator('[data-action-intent="what_to_answer"]').last();
    await secondCard.waitFor({ state: 'attached', timeout: 15_000 });
    const workspaceActionId = await secondCard.getAttribute('data-action-id');
    assert.ok(workspaceActionId && workspaceActionId !== actionId, 'A second click must receive a new actionId');
    await waitForActionStatus(overlay, workspaceActionId, ['completed', 'failed']);
    console.log('[installed-live-action-e2e] workspace-document action reached terminal state');
    const workspaceCard = overlay.locator(`[data-action-id="${workspaceActionId}"]`);
    const workspaceStatus = await workspaceCard.getAttribute('data-action-status');
    const workspaceAnswer = (await workspaceCard.innerText()).trim();
    assert.equal(workspaceStatus, 'completed', `Installed multi-turn answer failed: ${workspaceAnswer}`);
    assert.ok(workspaceAnswer.length >= 120, `Installed multi-turn answer is underdeveloped: ${workspaceAnswer}`);
    assert.equal(await workspaceCard.getAttribute('data-service-tier'), 'fast', 'Multi-turn GPT-5.6 action did not use Fast');

    tracePath = await finishTrace(electronApp, true);
    traceStarted = false;
    const workspaceEvents = readTrace(tracePath);
    const workspaceContexts = workspaceEvents.filter((event) => event.type === 'action_context');
    const workspaceResults = workspaceEvents.filter((event) => event.type === 'action_result' && event.payload?.actionId === workspaceActionId);
    assert.equal(workspaceContexts.length, 1, `Expected one workspace action_context, found ${workspaceContexts.length}`);
    assert.equal(workspaceResults.length, 1, `Expected one workspace action_result, found ${workspaceResults.length}`);
    const workspaceTarget = workspaceContexts[0].payload?.actionTarget || {};
    assert.equal(workspaceTarget.kind, 'implicit_request', `Workspace request was not recognized: ${JSON.stringify(workspaceTarget)}`);
    assert.match(String(workspaceTarget.text || ''), /préparer un petit document/i, `Wrong workspace request target: ${JSON.stringify(workspaceTarget)}`);
    assert.equal(workspaceContexts[0].payload?.languageHint, 'fr', 'Workspace request language was not detected as French');
    const workspaceAnswerNormalized = workspaceAnswer.toLocaleLowerCase('fr-FR');
    const coveredWorkspaceFacts = ['espace', 'whatsapp', 'rôle', 'freelance', 'support', 'document']
      .filter((term) => workspaceAnswerNormalized.includes(term)).length;
    assert.ok(coveredWorkspaceFacts >= 4, `Multi-turn answer did not synthesize enough of the explanation: ${workspaceAnswer}`);

    await sleep(3_250);
    await actionButton.click({ force: true });
    const thirdCard = overlay.locator('[data-action-intent="what_to_answer"]').last();
    await thirdCard.waitFor({ state: 'attached', timeout: 15_000 });
    const errorActionId = await thirdCard.getAttribute('data-action-id');
    assert.ok(errorActionId && errorActionId !== workspaceActionId, 'A third click must receive a new actionId');
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
      stockFactsCovered: coveredStockFacts,
      workspaceActionId,
      workspaceTarget,
      workspaceAnswerCharacters: workspaceAnswer.length,
      workspaceFactsCovered: coveredWorkspaceFacts,
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
    fs.rmSync(isolatedCredentialsPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`[installed-live-action-e2e] failed: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
