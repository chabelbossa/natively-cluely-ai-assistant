#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const args = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(args.db || path.join(os.homedir(), 'Library/Application Support/natively/natively.db'));
if (!fs.existsSync(dbPath)) fail(`Database not found: ${dbPath}`);

const meetings = queryJson(dbPath, 'select id, title from meetings where title is not null order by start_time desc');
const repairs = meetings
  .map(meeting => ({ ...meeting, repairedTitle: collapseExactRepeatedTitle(meeting.title) }))
  .filter(meeting => normalize(meeting.title) !== normalize(meeting.repairedTitle));

const report = {
  mode: args.apply ? 'apply' : 'dry-run',
  dbPath,
  repairs: repairs.map(({ id, title, repairedTitle }) => ({ id, before: title, after: repairedTitle })),
};

if (!args.apply || repairs.length === 0) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.backup-title-repair-${timestamp}`;
execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath, `.backup '${escapeSqliteMetaPath(backupPath)}'`], { encoding: 'utf8' });

const statements = repairs.map(({ id, repairedTitle }) =>
  `update meetings set title = '${escapeSql(repairedTitle)}' where id = '${escapeSql(id)}';`,
);
execFileSync('sqlite3', ['-cmd', '.timeout 5000', dbPath, `begin immediate;\n${statements.join('\n')}\ncommit;`], { encoding: 'utf8' });

const remaining = queryJson(dbPath, 'select id, title from meetings where title is not null')
  .filter(meeting => normalize(meeting.title) !== normalize(collapseExactRepeatedTitle(meeting.title)));
if (remaining.length > 0) fail(`Repair verification failed; ${remaining.length} duplicated titles remain.`);

console.log(JSON.stringify({ ...report, backupPath, remainingDuplicatedTitles: 0 }, null, 2));

function collapseExactRepeatedTitle(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return clean;
  for (let separatorLength = 0; separatorLength <= 3; separatorLength += 1) {
    const contentLength = clean.length - separatorLength;
    if (contentLength <= 0 || contentLength % 2 !== 0) continue;
    const half = contentLength / 2;
    const first = clean.slice(0, half).trim();
    const second = clean.slice(half + separatorLength).trim();
    if (first.length >= 4 && normalize(first) === normalize(second)) return first;
  }
  return clean;
}

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function queryJson(databasePath, sql) {
  const readOnlyUri = `${pathToFileURL(databasePath).href}?mode=ro`;
  const output = execFileSync('sqlite3', ['-json', readOnlyUri, sql], { encoding: 'utf8' }).trim();
  return output ? JSON.parse(output) : [];
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    parsed[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return parsed;
}

function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}

function escapeSqliteMetaPath(value) {
  return String(value).replace(/'/g, "''");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
