#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'electron/meeting/MeetingSummaryQuality.ts');
const compiledPath = path.join(repoRoot, 'dist-electron/electron/meeting/MeetingSummaryQuality.js');

if (!fs.existsSync(compiledPath) || fs.statSync(sourcePath).mtimeMs > fs.statSync(compiledPath).mtimeMs) {
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

console.log('Meeting summary normalization tests passed (16 assertions).');
