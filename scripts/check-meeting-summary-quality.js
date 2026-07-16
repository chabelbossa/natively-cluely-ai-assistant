#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const args = parseArgs(process.argv.slice(2));
if (args['self-test']) {
  runSelfTest();
  process.exit(0);
}
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
const transcriptText = referenceText || queryJson(dbPath, `
  select content
  from transcripts
  where meeting_id = '${escapeSql(meetingId)}'
  order by timestamp_ms asc
`).map(row => row.content || '').filter(Boolean).join('\n');
const report = evaluateSummary(summaryText, detailed, transcriptText, meeting.title);

console.log(JSON.stringify({
  meetingId,
  title: meeting.title,
  referencePath,
  evidenceSource: referenceText ? 'reference_file' : transcriptText ? 'persisted_transcript' : 'none',
  ...report,
}, null, 2));

if (report.failures.length > 0) process.exit(1);

function evaluateSummary(summaryText, detailed, referenceText, meetingTitle = '') {
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
  const summaryItems = [
    ...(Array.isArray(detailed.actionItems) ? detailed.actionItems : []),
    ...(Array.isArray(detailed.keyPoints) ? detailed.keyPoints : []),
    ...sections.flatMap(section => Array.isArray(section.bullets) ? section.bullets : []),
  ].filter(Boolean);
  const duplicateItems = countDuplicateItems(summaryItems);
  const overlyLongItems = summaryItems.filter(item => String(item).length > 320).length;

  if (isRepeatedTitle(meetingTitle)) failures.push('duplicate_title');
  if (normalize(meetingTitle).length > 140) failures.push(`title_too_long:${meetingTitle.length}`);
  if (summaryText.length < 700) failures.push(`summary_too_short:${summaryText.length}`);
  if (summaryText.length > 7500) failures.push(`summary_too_long:${summaryText.length}`);
  else if (summaryText.length > 6000) warnings.push(`summary_length_warning:${summaryText.length}`);
  if (populatedSections.length < 4) failures.push(`too_few_populated_sections:${populatedSections.length}`);
  if (bullets < 8) failures.push(`too_few_section_bullets:${bullets}`);
  if (bullets > 28) failures.push(`too_many_section_bullets:${bullets}`);
  if (summaryItems.length > 42) failures.push(`too_many_summary_items:${summaryItems.length}`);
  if (actionLikeCount < 2) failures.push(`too_few_action_items:${actionLikeCount}`);
  if (duplicateItems > 0) failures.push(`duplicate_summary_items:${duplicateItems}`);
  if (overlyLongItems > 0) failures.push(`overly_long_summary_items:${overlyLongItems}`);
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
    ['priorities', /\b(priorite|prioritaire|prioritaires|priorite 0|priorite 1|p0|p1|avant|ensuite)\b/],
  ];
  for (const [name, pattern] of categoryChecks) {
    if (!pattern.test(normalizedSummary)) failures.push(`missing_category:${name}`);
  }

  const requiredSignals = buildRequiredSignals(normalizedReference);
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
    summaryItems: summaryItems.length,
    duplicateItems,
    quality,
    failures,
    warnings,
  };
}

function isRepeatedTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return false;
  for (let separatorLength = 0; separatorLength <= 3; separatorLength += 1) {
    const contentLength = clean.length - separatorLength;
    if (contentLength <= 0 || contentLength % 2 !== 0) continue;
    const half = contentLength / 2;
    const first = clean.slice(0, half).trim();
    const second = clean.slice(half + separatorLength).trim();
    if (first.length >= 4 && normalize(first) === normalize(second)) return true;
  }
  return false;
}

function summaryItemKey(item) {
  return normalize(String(item || '').replace(/^(?:decision retenue|décision retenue|action|question ouverte|risque|a verifier|à vérifier)\s*:\s*/i, ''));
}

function countDuplicateItems(items) {
  const kept = [];
  let duplicates = 0;
  for (const item of items) {
    const key = summaryItemKey(item);
    if (!key) continue;
    const duplicate = kept.some(existing => {
      if (existing === key) return true;
      const shorter = existing.length <= key.length ? existing : key;
      const longer = existing.length > key.length ? existing : key;
      return shorter.length >= 48 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
    });
    if (duplicate) duplicates += 1;
    else kept.push(key);
  }
  return duplicates;
}

function runSelfTest() {
  const assert = require('node:assert/strict');
  const sectionTitles = ['Résumé exécutif', 'Décisions', "Plan d'action", 'Questions ouvertes', 'Risques', 'Points à vérifier'];
  const detailed = {
    overview: 'La réunion a défini une décision prioritaire et un plan concret. Les risques, questions ouvertes et validations à effectuer avant la mise en œuvre ont été clarifiés de manière opérationnelle.',
    actionItems: ['Action : vérifier le déploiement avant vendredi', 'Action : envoyer le rapport final'],
    keyPoints: ['Décision retenue : conserver le service actuel', 'Risque : surveiller la stabilité du compte'],
    sections: sectionTitles.map((title, index) => ({
      title,
      bullets: [
        `${title} : élément opérationnel unique ${index + 1} à vérifier avant la suite du projet`,
        `${title} : second élément concret ${index + 1} avec une priorité et une action définie`,
      ],
    })),
    quality: { score: 92, checks: [], sourcesUsed: ['fixture'], needsReview: false },
  };
  const text = renderSummaryText(detailed);
  const clean = evaluateSummary(text, detailed, '', 'Revue du déploiement produit');
  assert.equal(clean.failures.includes('duplicate_title'), false);

  const duplicateTitle = evaluateSummary(text, detailed, '', 'Revue produitRevue produit');
  assert.equal(duplicateTitle.failures.includes('duplicate_title'), true);

  const duplicated = structuredClone(detailed);
  duplicated.sections[1].bullets.push(duplicated.sections[0].bullets[0]);
  const duplicateItems = evaluateSummary(renderSummaryText(duplicated), duplicated, '', 'Revue produit');
  assert.equal(duplicateItems.failures.some(failure => failure.startsWith('duplicate_summary_items:')), true);

  const bloated = structuredClone(detailed);
  bloated.sections = bloated.sections.map((section, sectionIndex) => ({
    ...section,
    bullets: Array.from({ length: 6 }, (_, bulletIndex) => `${section.title} fait unique ${sectionIndex}-${bulletIndex} avec décision action risque question priorité vérification.`),
  }));
  const bloatReport = evaluateSummary(renderSummaryText(bloated), bloated, '', 'Revue produit');
  assert.equal(bloatReport.failures.some(failure => failure.startsWith('too_many_section_bullets:')), true);
  assert.deepEqual(buildRequiredSignals('une notification de connexion a ete envoyee'), []);
  assert.deepEqual(buildRequiredSignals('il faut ecrire une entreprise dans le formulaire'), []);
  assert.equal(buildRequiredSignals('saisie typing puis recording audio').some(([name]) => name === 'typing_recording'), true);
  assert.equal(buildRequiredSignals('abonnement en expiration avec notification de renouvellement').some(([name]) => name === 'subscription_expiry'), true);
  console.log('Meeting summary quality self-test passed (8 scenarios).');
}

function buildRequiredSignals(source) {
  const signals = [];
  const typingSignal = /\b(typing|ecrire|saisie)\b/;
  const recordingSignal = /\b(enregistrer|enregistrement|recording|audio)\b/;
  if (typingSignal.test(source) && recordingSignal.test(source)) {
    signals.push([
      'typing_recording',
      /(?=.*\b(?:typing|ecrire|saisie)\b)(?=.*\b(?:enregistrer|enregistrement|recording|audio)\b)/,
    ]);
  }
  const subscriptionSignal = /\b(abonnement|subscription)\b/;
  const expirySignal = /\b(expiration|expir|renouvel|notification)\b/;
  if (subscriptionSignal.test(source) && expirySignal.test(source)) {
    signals.push([
      'subscription_expiry',
      /(?=.*\b(?:abonnement|subscription)\b)(?=.*\b(?:expiration|expir|renouvel|notification)\b)/,
    ]);
  }
  const proxyMeetingSource = /\b(wachap|proxy|proxies|adresse ip|adresses ip|webshare|qr|pin|compte connecte|comptes connectes)\b/.test(source);
  if (proxyMeetingSource) {
    signals.push(
      ['proxy_ip', /\b(proxy|proxies|ip|adresse|adresses)\b/],
      ['provider_test_strategy', /\b(webshare|gratuit|statique|test)\b/],
      ['ip_purchase_tradeoff', /\b(25|50)\b/],
      ['account_audit_numbers', /\b(196|200|qr|pin|connecte|connectes)\b/],
      ['capacity_ambiguity', /\b(utilisateur|utilisateurs|compte|comptes)\b/],
    );
  }
  return signals;
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
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const output = execFileSync(
        'sqlite3',
        ['-cmd', '.timeout 5000', '-json', `${pathToFileURL(dbPath).href}?mode=ro`, sql],
        { encoding: 'utf8' },
      ).trim();
      return output ? JSON.parse(output) : [];
    } catch (error) {
      lastError = error;
      const detail = `${error?.message || ''}\n${error?.stderr || ''}`;
      if (!/unable to open database|database is (?:locked|busy)/i.test(detail) || attempt === 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (attempt + 1));
    }
  }
  throw lastError;
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
