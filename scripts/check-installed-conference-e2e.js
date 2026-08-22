#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const appPath = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '/Applications/Natively.app');
const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Natively');
const loaderPath = path.join(__dirname, 'playwright-electron-autostart-loader.js');
const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
const isolatedCredentialsPath = path.join(os.tmpdir(), `natively-conference-e2e-credentials-${process.pid}.enc`);
const requestedModel = String(process.env.NATIVELY_E2E_MODEL || 'codex:gpt-5.6-terra').trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stopInstalledApp() {
  try {
    execFileSync('osascript', ['-e', 'tell application id "com.electron.meeting-notes" to quit'], {
      stdio: 'ignore',
      timeout: 4_000,
    });
  } catch {}
  await sleep(2_000);
}

function readTrace(tracePath) {
  assert.ok(tracePath && fs.existsSync(tracePath), `Conference trace missing: ${tracePath || 'none'}`);
  return fs.readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalize(text) {
  return String(text || '').toLocaleLowerCase('fr-FR').normalize('NFKC');
}

async function main() {
  assert.ok(fs.existsSync(executablePath), `Installed Natively executable missing: ${executablePath}`);
  assert.ok(fs.existsSync(codexAuthPath), `Codex authentication missing: ${codexAuthPath}`);
  fs.rmSync(isolatedCredentialsPath, { force: true });
  await stopInstalledApp();

  let electronApp;
  try {
    electronApp = await electron.launch({
      executablePath,
      args: ['-r', loaderPath],
      env: {
        ...process.env,
        NATIVELY_MEETING_DEBUG: '1',
        NATIVELY_CREDENTIALS_PATH: isolatedCredentialsPath,
      },
      timeout: 60_000,
    });

    const result = await electronApp.evaluate(async ({ app }, payload) => {
      await app.whenReady();
      const appRoot = app.getAppPath();
      const nodeRequire = process.getBuiltinModule('node:module').createRequire(`${appRoot}/package.json`);
      const pathModule = nodeRequire('node:path');
      const fsModule = nodeRequire('node:fs');
      const { AppState } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/main.js'));
      const { CredentialsManager } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/services/CredentialsManager.js'));
      const { ModesManager } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/services/ModesManager.js'));
      const { MeetingDebugRecorder } = nodeRequire(pathModule.join(appRoot, 'dist-electron/electron/diagnostics/MeetingDebugRecorder.js'));

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
        alias: 'conference-installed-e2e',
        email: String(identityClaims.email || identityClaims['https://api.openai.com/profile']?.email || 'conference-e2e@local').toLowerCase(),
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

      const state = AppState.getInstance();
      const manager = state.getIntelligenceManager();
      const llmHelper = state.processingHelper.getLLMHelper();
      const modes = ModesManager.getInstance();
      const previousModeId = modes.getActiveMode()?.id || null;
      const conferenceMode = modes.getModes().find((mode) => mode.templateType === 'conference');
      if (!conferenceMode) throw new Error('Installed Conference mode was not seeded.');

      llmHelper.initializeCodexAuth();
      llmHelper.setModel(payload.model);
      modes.setActiveMode(conferenceMode.id);
      manager.reset();

      const now = Date.now();
      const segments = [
        {
          speaker: 'me', canonicalRole: 'me', source: 'mic', qualityFlags: [], final: true, confidence: 0.96,
          timestamp: now - 240_000,
          text: "Comment est-ce que je peux améliorer mon classement, mon clustering ? Parce que du coup, si je relance 10 fois mon algorithme, je vais avoir 10 classements différents.",
        },
        {
          speaker: 'me', canonicalRole: 'me', source: 'mic', qualityFlags: [], final: true, confidence: 0.84,
          timestamp: now - 203_000,
          text: "Quand ça arrêtait qu'on a compris, oui, parce que on s'arrête.",
        },
        {
          speaker: 'me', canonicalRole: 'me', source: 'mic', qualityFlags: [], final: true, confidence: 0.78,
          timestamp: now - 92_000,
          text: "c'est la méthode du couple. Vous regardez la coupe de descon et lorsque la pompe devient pratiquement plus vous pouvez vous la mettre à...",
        },
        {
          speaker: 'me', canonicalRole: 'me', source: 'mic', qualityFlags: [], final: true, confidence: 0.96,
          timestamp: now - 1_000,
          text: "mais sur mes 5000 tables, j'en ai environ 80 qui se promènent entre une classe et les autres, entre les 10 runs différents. Est-ce que vous voyez tous le problème dont on est en train de faire ?",
        },
      ];
      for (const segment of segments) manager.recordTranscriptOnly(segment);

      const recorder = MeetingDebugRecorder.getInstance();
      recorder.startSession({ test: 'installed-conference-e2e', fixture: 'Machine Learning Models and Evaluation' });
      try {
        const answer = await manager.runWhatShouldISay(undefined, 0.95, undefined, 'conference-answer-e2e');
        const clarification = await manager.runClarify('conference-clarify-e2e');
        const questionToAsk = await manager.runFollowUpQuestions('conference-question-e2e');
        const tracePath = recorder.getCurrentFilePath();
        recorder.finishSession({ test: 'installed-conference-e2e', success: true });
        return {
          appRoot,
          provider: llmHelper.getCurrentProvider(),
          model: llmHelper.getCurrentModel(),
          previousModeId,
          conferenceModeId: conferenceMode.id,
          answer,
          clarification,
          questionToAsk,
          tracePath,
        };
      } finally {
        modes.setActiveMode(previousModeId);
        manager.reset();
      }
    }, { codexAuthPath, model: requestedModel });

    assert.ok(result.appRoot.includes('Natively.app/Contents/Resources/app.asar'), `Unexpected packaged root: ${result.appRoot}`);
    assert.equal(result.provider, 'codex');
    assert.match(result.model, /^codex:gpt-5\.6-(sol|terra|luna)$/);

    const answer = normalize(result.answer);
    const clarification = normalize(result.clarification);
    const questionToAsk = String(result.questionToAsk || '').trim();
    assert.ok(answer.length >= 160, `Conference answer is underdeveloped: ${result.answer}`);
    assert.ok(/cluster|classe|stabil|consensus|co.?association|silhouette/.test(answer), `Conference answer missed the clustering problem: ${result.answer}`);
    assert.doesNotMatch(answer, /pas assez de contexte|problème exact|not enough context/);
    assert.ok(clarification.length >= 120, `Conference clarification is underdeveloped: ${result.clarification}`);
    assert.ok(/cluster|classe|stabil|80|5000|dix|10/.test(clarification), `Conference clarification is not grounded: ${result.clarification}`);
    assert.match(questionToAsk, /[?？]\s*$/);
    assert.ok(/classe|cluster|80|5000|stabil|run/i.test(questionToAsk), `Question to ask is generic: ${questionToAsk}`);
    assert.doesNotMatch(questionToAsk, /prochaine décision attendue|préciser.*clustering/i);

    const events = readTrace(result.tracePath);
    const contexts = events.filter((event) => event.type === 'action_context');
    assert.equal(contexts.length, 3, `Expected three conference action packets, found ${contexts.length}`);
    for (const context of contexts) {
      assert.equal(context.payload?.contextMode, 'conference');
      const target = normalize(context.payload?.actionTarget?.text);
      for (const term of ['clustering', '10 classements', '5000 tables', '80']) {
        assert.ok(target.includes(normalize(term)), `Packaged target lost ${term}: ${context.payload?.actionTarget?.text}`);
      }
    }

    console.log(JSON.stringify({
      status: 'passed',
      appPath,
      provider: result.provider,
      model: result.model,
      restoredModeId: result.previousModeId,
      conferenceModeId: result.conferenceModeId,
      answer: result.answer,
      clarification: result.clarification,
      questionToAsk: result.questionToAsk,
      actionPackets: contexts.map((event) => ({
        action: event.payload?.action,
        contextMode: event.payload?.contextMode,
        target: event.payload?.actionTarget,
      })),
      tracePath: result.tracePath,
    }, null, 2));
  } finally {
    if (electronApp) {
      try { await electronApp.close(); } catch {}
    }
    await stopInstalledApp();
    fs.rmSync(isolatedCredentialsPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`[installed-conference-e2e] failed: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
