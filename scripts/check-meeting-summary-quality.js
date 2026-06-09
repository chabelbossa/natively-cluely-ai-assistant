#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = parseArgs(process.argv.slice(2));
const meetingId = args['meeting-id'];
if (!meetingId) {
  fail('Usage: pnpm run meeting:summary:guard -- --meeting-id <id> [--reference summary_chatgpt.txt] [--db path]');
}

const dbPath = args.db || path.join(os.homedir(), 'Library/Application Support/natively/natively.db');
const referencePath = args.reference ? path.resolve(args.reference) : null;
if (!fs.existsSync(dbPath)) fail(`Database not found: ${dbPath}`);
if (referencePath && !fs.existsSync(referencePath)) fail(`Reference not found: ${referencePath}`);

const meeting = queryJson(dbPath, `
  select id, title, summary_json
  from meetings
  where id = '${escapeSql(meetingId)}'
  limit 1
`)[0];
if (!meeting) fail(`Meeting not found: ${meetingId}`);

const summaryJson = safeJson(meeting.summary_json || '{}');
const detailed = summaryJson.detailedSummary || {};
const summaryText = renderSummaryText(detailed);
const referenceText = referencePath ? fs.readFileSync(referencePath, 'utf8') : '';
const report = evaluateSummary(summaryText, detailed, referenceText);

console.log(JSON.stringify({
  meetingId,
  title: meeting.title,
  referencePath,
  ...report,
}, null, 2));

if (report.failures.length > 0) process.exit(1);

function evaluateSummary(summaryText, detailed, referenceText) {
  const normalizedSummary = normalize(summaryText);
  const normalizedReference = normalize(referenceText);
  const failures = [];
  const warnings = [];
  const sections = Array.isArray(detailed.sections) ? detailed.sections : [];
  const populatedSections = sections.filter(section => Array.isArray(section.bullets) && section.bullets.length > 0);
  const bullets = sections.reduce((count, section) => count + (Array.isArray(section.bullets) ? section.bullets.length : 0), 0);
  const planActionBullets = sections
    .filter(section => normalize(section.title || '').includes('plan d action'))
    .reduce((count, section) => count + (Array.isArray(section.bullets) ? section.bullets.length : 0), 0);
  const actionLikeCount = (Array.isArray(detailed.actionItems) ? detailed.actionItems.length : 0) + planActionBullets;
  const quality = detailed.quality || {};

  if (summaryText.length < 1800) failures.push(`summary_too_short:${summaryText.length}`);
  if (populatedSections.length < 4) failures.push(`too_few_populated_sections:${populatedSections.length}`);
  if (bullets < 12) failures.push(`too_few_section_bullets:${bullets}`);
  if (actionLikeCount < 3) failures.push(`too_few_action_items:${actionLikeCount}`);
  if (!quality || typeof quality.score !== 'number') failures.push('summary_quality_metadata_missing');
  if (typeof quality.score === 'number' && quality.score < 72) failures.push(`summary_quality_score_low:${quality.score}`);
  if (quality.needsReview === true) failures.push('summary_marked_needs_review');

  const sectionTitles = sections.map(section => normalize(section.title || '')).join(' | ');
  for (const title of ['resume executif', 'decisions', 'plan d action', 'questions ouvertes', 'risques', 'points a verifier']) {
    if (!sectionTitles.includes(title)) failures.push(`missing_agentic_section:${title}`);
  }

  const categoryChecks = [
    ['decisions', /\b(decision|decide|retenu|orientation|trancher|arbitrage)\b/],
    ['actions', /\b(action|faire|tester|verifier|audit|implementer|developper|envoyer|analyser)\b/],
    ['open_questions', /\b(question|ambigu|trancher|clarifier|a verifier|a definir)\b/],
    ['risks', /\b(risque|stabilite|proteger|bloquant|fragile|abuse|compte)\b/],
    ['priorities', /\b(priorite|priorite 0|priorite 1|p0|p1|avant|ensuite)\b/],
  ];
  for (const [name, pattern] of categoryChecks) {
    if (!pattern.test(normalizedSummary)) failures.push(`missing_category:${name}`);
  }

  const requiredSignals = buildRequiredSignals(normalizedReference || normalizedSummary);
  for (const [name, pattern] of requiredSignals) {
    if (!pattern.test(normalizedSummary)) failures.push(`missing_signal:${name}`);
  }

  if (referenceText) {
    const coverage = referenceCoverage(normalizedSummary, normalizedReference);
    if (coverage < 0.42) failures.push(`reference_keyword_coverage_low:${coverage.toFixed(3)}`);
    if (coverage < 0.55) warnings.push(`reference_keyword_coverage_warning:${coverage.toFixed(3)}`);
  }

  return {
    summaryChars: summaryText.length,
    sections: sections.length,
    populatedSections: populatedSections.length,
    bullets,
    quality,
    failures,
    warnings,
  };
}

function buildRequiredSignals(source) {
  const signals = [
    ['typing_recording', /\b(typing|ecrire|enregistrer|recording|audio)\b/],
    ['proxy_ip', /\b(proxy|proxies|ip|adresse|adresses)\b/],
    ['subscription_expiry', /\b(abonnement|expiration|renouvel|notification)\b/],
    ['provider_test_strategy', /\b(webshare|gratuit|statique|test)\b/],
    ['ip_purchase_tradeoff', /\b(25|50)\b/],
    ['account_audit_numbers', /\b(196|200|qr|pin|connecte|connectes)\b/],
    ['capacity_ambiguity', /\b(utilisateur|utilisateurs|compte|comptes)\b/],
  ];
  return signals.filter(([, pattern]) => pattern.test(source));
}

function referenceCoverage(summary, reference) {
  const refTerms = importantTerms(reference);
  if (refTerms.length === 0) return 1;
  const present = refTerms.filter(term => summary.includes(term));
  return present.length / refTerms.length;
}

function importantTerms(text) {
  const stop = new Set([
    'avec', 'dans', 'pour', 'que', 'qui', 'une', 'des', 'les', 'est', 'sur', 'pas',
    'plus', 'donc', 'comme', 'cela', 'cest', 'sont', 'avoir', 'faire', 'etre',
    'avant', 'apres', 'aussi', 'tout', 'leur', 'leurs', 'mais', 'nous', 'vous',
  ]);
  const counts = new Map();
  for (const token of text.split(/\s+/)) {
    if (token.length < 5 || stop.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([term]) => term);
}

function renderSummaryText(detailed) {
  const parts = [];
  if (detailed.overview) parts.push(detailed.overview);
  if (Array.isArray(detailed.actionItems)) parts.push(...detailed.actionItems);
  if (Array.isArray(detailed.keyPoints)) parts.push(...detailed.keyPoints);
  if (Array.isArray(detailed.sections)) {
    for (const section of detailed.sections) {
      parts.push(section.title || '');
      if (Array.isArray(section.bullets)) parts.push(...section.bullets);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function queryJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return output ? JSON.parse(output) : [];
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    parsed[key] = value;
  }
  return parsed;
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
