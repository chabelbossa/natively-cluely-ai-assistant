#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const catalog = read('src/config/codexModels.ts');
const client = read('electron/services/CodexResponsesClient.ts');
const llmHelper = read('electron/LLMHelper.ts');
const ipcHandlers = read('electron/ipcHandlers.ts');
const providerCard = read('src/components/settings/CodexProviderCard.tsx');
const modelUtils = read('src/utils/modelUtils.ts');

const failures = [];
const checks = [
    {
        name: 'catalog includes Sol, Terra, and Luna',
        source: catalog,
        pattern: /codex:gpt-5\.6-sol[\s\S]*codex:gpt-5\.6-terra[\s\S]*codex:gpt-5\.6-luna/,
    },
    {
        name: 'balanced meeting default uses Terra with medium reasoning',
        source: catalog,
        pattern: /DEFAULT_CODEX_MODEL = 'codex:gpt-5\.6-terra'[\s\S]*DEFAULT_CODEX_REASONING_EFFORT[^=]*= 'medium'/,
    },
    {
        name: 'Sol and Terra support Ultra while Luna stops at Max',
        source: catalog,
        pattern: /GPT_56_REASONING_EFFORTS[\s\S]*'max',[\s\S]*'ultra'[\s\S]*GPT_56_LUNA_REASONING_EFFORTS[\s\S]*'max',[\s\S]*supportedReasoningEfforts: GPT_56_REASONING_EFFORTS[\s\S]*supportedReasoningEfforts: GPT_56_REASONING_EFFORTS[\s\S]*supportedReasoningEfforts: GPT_56_LUNA_REASONING_EFFORTS/,
    },
    {
        name: 'deprecated ChatGPT-sign-in models are absent from the visible catalog',
        source: modelUtils,
        reject: /codex:gpt-5\.3['"]|codex:gpt-5\.2|codex:gpt-5\.1|codex:gpt-5['"]/,
    },
    {
        name: 'Codex transport identifies the minimum GPT-5.6 client contract',
        source: client,
        pattern: /MINIMUM_GPT_56_CODEX_VERSION = "0\.144\.0"[\s\S]*Originator: "codex_cli_rs"[\s\S]*Version: MINIMUM_GPT_56_CODEX_VERSION/,
    },
    {
        name: 'Codex Fast uses the current priority wire value with an explicit Standard fallback',
        source: client,
        pattern: /DEFAULT_SERVICE_TIER = "priority"[\s\S]*body\.service_tier = serviceTier[\s\S]*retrying explicitly in Standard mode/,
        reject: /DEFAULT_SERVICE_TIER = "fast"/,
    },
    {
        name: 'non-streaming and streaming Codex calls both send normalized reasoning',
        source: llmHelper,
        pattern: /generateWithCodex[\s\S]*reasoning: \{ effort: this\.getCodexReasoningEffort\(resolvedModelId\) \}[\s\S]*streamWithCodex[\s\S]*reasoning: \{ effort: this\.getCodexReasoningEffort\(resolvedModelId\) \}/,
    },
    {
        name: 'Codex connection test performs a real model request',
        source: `${llmHelper}\n${ipcHandlers}`,
        pattern: /testCodexConnection[\s\S]*Reply with exactly: OK[\s\S]*test-llm-connection[\s\S]*\.testCodexConnection\(/,
    },
    {
        name: 'reasoning effort is exposed through IPC',
        source: ipcHandlers,
        pattern: /get-codex-reasoning-effort[\s\S]*set-codex-reasoning-effort/,
    },
    {
        name: 'settings expose outcome presets plus advanced model and reasoning controls',
        source: providerCard,
        pattern: /CODEX_EXPERIENCE_PRESETS[\s\S]*Response profile[\s\S]*CODEX_MODELS\.map[\s\S]*supportedReasoningEfforts\.map/,
    },
];

for (const check of checks) {
    if (check.pattern && !check.pattern.test(check.source)) failures.push(check.name);
    if (check.reject && check.reject.test(check.source)) failures.push(check.name);
}

if (failures.length > 0) {
    console.error('Codex GPT-5.6 integration guard failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Codex GPT-5.6 integration guard passed (${checks.length} checks).`);
