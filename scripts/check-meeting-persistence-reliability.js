#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'electron/MeetingPersistence.ts'), 'utf8');
const failures = [];

function requirePattern(name, pattern) {
  if (!pattern.test(source)) failures.push(name);
}

const placeholderSaveIndex = source.indexOf('saveMeeting(placeholder');
const backgroundWorkerIndex = source.indexOf('this.processAndSaveMeeting(snapshot');
if (placeholderSaveIndex < 0 || backgroundWorkerIndex < 0 || placeholderSaveIndex > backgroundWorkerIndex) {
  failures.push('placeholder_must_be_durable_before_background_processing');
}

requirePattern('title_stage_timeout_missing', /withStageTimeout\([\s\S]{0,220}generateMeetingSummary\(titlePrompt[\s\S]{0,220}TITLE_STAGE_TIMEOUT_MS/);
requirePattern('structured_summary_timeout_missing', /withStageTimeout\([\s\S]{0,220}generateMeetingSummary\(summaryPrompt[\s\S]{0,220}SUMMARY_STAGE_TIMEOUT_MS/);
requirePattern('agentic_summary_timeout_missing', /withStageTimeout\([\s\S]{0,220}summaryAgent\.generate\([\s\S]{0,700}AGENTIC_SUMMARY_STAGE_TIMEOUT_MS/);
requirePattern('background_failure_fallback_missing', /processAndSaveMeeting\(snapshot[\s\S]{0,260}\.catch\([\s\S]{0,260}saveFallbackMeeting\(snapshot/);
requirePattern('fallback_not_marked_processed', /saveFallbackMeeting\([\s\S]{0,1800}isProcessed:\s*true/);
requirePattern('startup_recovery_missing', /recoverUnprocessedMeetings\s*\(/);

if (failures.length > 0) {
  console.error(`Meeting persistence reliability guard failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('Meeting persistence reliability guard passed (7 checks).');
