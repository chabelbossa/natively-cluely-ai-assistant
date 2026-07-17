#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'electron/meeting/MeetingSummaryQuality.ts');
const sourceAgentPath = path.join(repoRoot, 'electron/meeting/MeetingSummaryAgent.ts');
const compiledPath = path.join(repoRoot, 'dist-electron/electron/meeting/MeetingSummaryQuality.js');
const compiledAgentPath = path.join(repoRoot, 'dist-electron/electron/meeting/MeetingSummaryAgent.js');

if (
  !fs.existsSync(compiledPath)
  || !fs.existsSync(compiledAgentPath)
  || Math.max(fs.statSync(sourcePath).mtimeMs, fs.statSync(sourceAgentPath).mtimeMs) > Math.min(fs.statSync(compiledPath).mtimeMs, fs.statSync(compiledAgentPath).mtimeMs)
) {
  const build = spawnSync('npm', ['run', 'build:electron'], { cwd: repoRoot, encoding: 'utf8' });
  if (build.status !== 0) {
    process.stderr.write(build.stdout || '');
    process.stderr.write(build.stderr || '');
    process.exit(build.status || 1);
  }
}

const {
  collapseRepeatedTextBlock,
  countDuplicateSummaryItems,
  deduplicateSummaryItems,
  getSummarySectionBulletLimit,
  isRepeatedMeetingTitle,
  sanitizeMeetingTitle,
  summaryNeedsReview,
} = require(compiledPath);
const { MeetingSummaryAgent } = require(compiledAgentPath);

const presentationBuild = buildSync({
  entryPoints: [path.join(repoRoot, 'src/lib/summaryPresentation.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  write: false,
});
const presentationModule = new Module('summary-presentation-test', module);
presentationModule.filename = path.join(repoRoot, 'dist-test/summaryPresentation.js');
presentationModule.paths = module.paths;
presentationModule._compile(presentationBuild.outputFiles[0].text, presentationModule.filename);
const {
  insertEditableSummaryItemAfter,
  selectSupplementalSummaryItems,
  summaryItemsEquivalent,
} = presentationModule.exports;

assert.equal(
  sanitizeMeetingTitle('RightQ Analytica Access and Sprint SetupRightQ Analytica Access and Sprint Setup'),
  'RightQ Analytica Access and Sprint Setup',
);
assert.equal(sanitizeMeetingTitle('Titre : Revue stratégique des pharmacies'), 'Revue stratégique des pharmacies');
assert.equal(sanitizeMeetingTitle('Architecture produit et synchronisation'), 'Architecture produit et synchronisation');
assert.equal(isRepeatedMeetingTitle('Revue produitRevue produit'), true);
assert.equal(isRepeatedMeetingTitle('Revue produit et plan produit'), false);
assert.equal(collapseRepeatedTextBlock('Décision finale. Décision finale.'), 'Décision finale.');

const deduplicated = deduplicateSummaryItems([
  'Action : vérifier le déploiement en production avant vendredi',
  'Vérifier le déploiement en production avant vendredi',
  'Action : envoyer le rapport au responsable technique',
], 6);
assert.deepEqual(deduplicated, [
  'Action : vérifier le déploiement en production avant vendredi',
  'Action : envoyer le rapport au responsable technique',
]);
assert.equal(countDuplicateSummaryItems([...deduplicated, deduplicated[0]]), 1);
assert.equal(getSummarySectionBulletLimit("Plan d'action"), 6);
assert.equal(getSummarySectionBulletLimit('Risques'), 4);
assert.equal(summaryNeedsReview(85, ['too_few_bullets', 'duplicate_summary_items:1']), true);
assert.equal(summaryNeedsReview(100, []), false);

const supplementalActions = selectSupplementalSummaryItems(
  ['Action : préparer le déploiement', 'Envoyer le rapport final au responsable'],
  ['Préparer le déploiement'],
);
assert.deepEqual(supplementalActions, [{ item: 'Envoyer le rapport final au responsable', sourceIndex: 1 }]);
const supplementalKeyPoints = selectSupplementalSummaryItems(
  ['Envoyer le rapport final au responsable', 'La phase pilote commence lundi'],
  ['Préparer le déploiement', ...supplementalActions.map(({ item }) => item)],
);
assert.deepEqual(supplementalKeyPoints, [{ item: 'La phase pilote commence lundi', sourceIndex: 1 }]);
assert.equal(summaryItemsEquivalent('Action : préparer le déploiement', 'Préparer le déploiement'), true);
assert.deepEqual(
  insertEditableSummaryItemAfter(['Ancienne puce', 'Puce suivante'], 0, 'Puce modifiée'),
  ['Puce modifiée', '', 'Puce suivante'],
);

const summaryAgent = new MeetingSummaryAgent({});
const factualSummary = {
  overview: 'La réunion a défini une décision prioritaire sur les espaces de travail, ainsi que les rôles à limiter et les validations nécessaires avant le déploiement.',
  actionItems: ['Action : vérifier les permissions avant le déploiement', 'Action : envoyer le document explicatif'],
  keyPoints: ['Décision retenue : isoler les données de chaque espace', 'Risque : éviter un accès trop large aux comptes'],
  sections: [
    { title: 'Résumé exécutif', bullets: ['Priorité : documenter le fonctionnement avant la mise en œuvre', 'Les espaces isolent comptes, conversations et paramètres'] },
    { title: 'Décisions', bullets: ['Décision retenue : rattacher les données existantes à un espace par défaut', 'Décision retenue : limiter chaque rôle aux fonctions autorisées'] },
    { title: "Plan d'action", bullets: ['Action : préparer le document demandé', 'Action : tester les permissions de chaque rôle', 'Action : vérifier ensuite les accès des agents'] },
    { title: 'Questions ouvertes', bullets: ['Question ouverte : clarifier le périmètre exact du freelance', 'À vérifier : définir les accès de support'] },
    { title: 'Risques', bullets: ['Risque : exposer des conversations à un rôle non autorisé', 'Risque : mélanger les paramètres de deux espaces'] },
    { title: 'Points à vérifier', bullets: ['À vérifier : valider l’isolation des comptes', 'À vérifier : confirmer les règles avant le déploiement'] },
  ],
};
const technicalEvidence = {
  digest: '[PERSISTED TRANSCRIPT]\n[2026-07-17T12:57:59.868Z] INTERLOCUTOR: Les espaces de travail isolent les comptes.\n[AI USAGE HISTORY]\nL’abonnement expire dans 30 jours.',
  factDigest: '[PERSISTED TRANSCRIPT]\n[2026-07-17T12:57:59.868Z] INTERLOCUTOR: Les espaces de travail isolent les comptes.',
  sourcesUsed: ['persisted_transcript', 'ai_usage_history'],
  diagnostics: [],
};
const technicalEvidenceQuality = summaryAgent.evaluateSummary(factualSummary, technicalEvidence);
assert.equal(technicalEvidenceQuality.checks.includes('missing_numeric_facts'), false);
assert.equal(technicalEvidenceQuality.checks.includes('missing_subscription_expiry'), false);

console.log('Meeting summary normalization tests passed (18 assertions).');
