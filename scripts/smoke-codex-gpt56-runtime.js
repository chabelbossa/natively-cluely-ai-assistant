#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
const codexBinary = process.env.CODEX_CLI_PATH
    || (fs.existsSync(bundledCodex) ? bundledCodex : 'codex');

const versionResult = spawnSync(codexBinary, ['--version'], { encoding: 'utf8' });
if (versionResult.status !== 0) {
    console.error(`Unable to run Codex: ${versionResult.stderr || versionResult.stdout}`);
    process.exit(1);
}

const versionOutput = `${versionResult.stdout}${versionResult.stderr}`.trim();
const versionMatch = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
if (!versionMatch || Number(versionMatch[1]) !== 0 || Number(versionMatch[2]) < 144) {
    console.error(`GPT-5.6 requires Codex 0.144.0 or newer; found ${versionOutput}.`);
    process.exit(1);
}

const cases = [
    { model: 'gpt-5.6-sol', effort: 'low', expected: 'GPT56_SOL_OK' },
    { model: 'gpt-5.6-terra', effort: 'medium', expected: 'GPT56_TERRA_OK' },
    { model: 'gpt-5.6-luna', effort: 'low', expected: 'GPT56_LUNA_OK' },
];

for (const testCase of cases) {
    let lastOutput = '';
    let passed = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = spawnSync(codexBinary, [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--ignore-rules',
            '--sandbox',
            'read-only',
            '-m',
            testCase.model,
            '-c',
            `model_reasoning_effort="${testCase.effort}"`,
            '--color',
            'never',
            `Do not use tools. Reply with exactly: ${testCase.expected}`,
        ], {
            cwd: os.tmpdir(),
            encoding: 'utf8',
            timeout: 150_000,
        });

        lastOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (result.status === 0 && lastOutput.includes(testCase.expected)) {
            passed = true;
            break;
        }

        if (attempt === 1) {
            const reason = result.error?.code === 'ETIMEDOUT' ? 'timeout' : `exit ${result.status}`;
            console.warn(`${testCase.model} (${testCase.effort}) ${reason}; retrying once...`);
        }
    }

    if (!passed) {
        console.error(`${testCase.model} (${testCase.effort}) failed after two attempts:\n${lastOutput}`);
        process.exit(1);
    }
    console.log(`${testCase.model} (${testCase.effort}): OK`);
}

console.log(`Codex GPT-5.6 OAuth smoke passed with ${versionOutput}.`);
