// ProjectDiscovery — scans local filesystems to find versioned projects
// the user might want to attach to a meeting as context.
//
// Design goals:
//   - Fast: skip node_modules, .git, dist, etc.
//   - Bounded: respect MAX_SCAN_DEPTH, MAX_FILES_PER_PROJECT, MAX_FILE_BYTES.
//   - Pure: no DB writes, no IPC, no side effects beyond reading the FS
//     and shelling out to `git` for remotes and last commit.
//   - Cross-platform: home-dir expansion, POSIX/Windows path handling.
//
// The discovery is *intentionally* permissive: it may return duplicates
// (e.g. monorepos where both the root and a sub-package look like
// projects). Dedup is the job of ProjectContextManager.

import { execFile } from 'child_process';
import { promises as fs, existsSync, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    DEFAULT_SCAN_ROOTS,
    DiscoveredFile,
    DiscoveredProject,
    EXCLUDED_PATH_SEGMENTS,
    KEY_DOC_FILES,
    PROJECT_LIMITS,
    PROJECT_MARKERS,
    READABLE_FILE_EXTS,
} from '../types/projectContext';

export interface DiscoveryProgress {
    scannedRoots: number;
    totalRoots: number;
    currentRoot: string;
    found: number;
}

export interface DiscoveryOptions {
    roots?: string[];
    onProgress?: (progress: DiscoveryProgress) => void;
    abortSignal?: { aborted: boolean };
}

function expandHome(p: string): string {
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

function isExcluded(absolutePath: string): boolean {
    const segments = absolutePath.split(path.sep);
    return segments.some((seg) => EXCLUDED_PATH_SEGMENTS.includes(seg));
}

function hasProjectMarker(absoluteDir: string): boolean {
    for (const marker of PROJECT_MARKERS) {
        if (existsSync(path.join(absoluteDir, marker))) {
            return true;
        }
    }
    return false;
}

function runGit(args: string[], cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
        execFile('git', args, { cwd, timeout: 4000, maxBuffer: 64 * 1024 }, (err, stdout) => {
            if (err) {
                resolve(null);
            } else {
                resolve(typeof stdout === 'string' ? stdout.trim() || null : null);
            }
        });
    });
}

async function safeReadText(filePath: string, maxBytes: number): Promise<string | null> {
    try {
        const st = statSync(filePath);
        if (!st.isFile() || st.size > maxBytes || st.size === 0) return null;
        const ext = path.extname(filePath).toLowerCase();
        if (!READABLE_FILE_EXTS.includes(ext)) return null;
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

function pickFirstReadme(files: DiscoveredFile[]): DiscoveredFile | null {
    const lower = (s: string) => s.toLowerCase();
    for (const key of KEY_DOC_FILES) {
        const hit = files.find((f) => lower(f.fileName) === lower(key));
        if (hit) return hit;
    }
    return null;
}

function extractAutoSummary(readme: string | null, packageJson: any | null): string {
    if (readme) {
        // Strip the first H1 heading and grab the first meaningful paragraph.
        const lines = readme.split(/\r?\n/);
        const out: string[] = [];
        let pastTitle = false;
        for (const line of lines) {
            if (!pastTitle) {
                if (/^#\s+/.test(line)) {
                    pastTitle = true;
                }
                continue;
            }
            const trimmed = line.trim();
            if (!trimmed) {
                if (out.length > 0) break; // paragraph ended
                continue;
            }
            out.push(trimmed);
            if (out.join(' ').length > PROJECT_LIMITS.MAX_AUTO_SUMMARY_CHARS) break;
        }
        const text = out.join(' ').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, PROJECT_LIMITS.MAX_AUTO_SUMMARY_CHARS);
    }
    if (packageJson?.description && typeof packageJson.description === 'string') {
        return packageJson.description.slice(0, PROJECT_LIMITS.MAX_AUTO_SUMMARY_CHARS);
    }
    return '';
}

function inferStack(rootDir: string, packageJson: any | null): string {
    const tags = new Set<string>();
    if (packageJson?.dependencies || packageJson?.devDependencies) {
        const allDeps = {
            ...(packageJson.dependencies || {}),
            ...(packageJson.devDependencies || {}),
        };
        const depKeys = Object.keys(allDeps);
        if (depKeys.includes('next')) tags.add('Next.js');
        if (depKeys.includes('react-native') || depKeys.includes('expo')) tags.add('React Native');
        if (depKeys.includes('react')) tags.add('React');
        if (depKeys.includes('@nestjs/core')) tags.add('NestJS');
        if (depKeys.includes('express')) tags.add('Express');
        if (depKeys.includes('electron')) tags.add('Electron');
        if (depKeys.includes('fastify')) tags.add('Fastify');
        if (depKeys.includes('vue')) tags.add('Vue');
        if (depKeys.includes('svelte')) tags.add('Svelte');
        if (depKeys.includes('tailwindcss')) tags.add('Tailwind');
        if (depKeys.includes('typescript')) tags.add('TypeScript');
        if (depKeys.includes('prisma') || depKeys.includes('@prisma/client')) tags.add('Prisma');
        if (depKeys.includes('drizzle-orm')) tags.add('Drizzle');
        if (depKeys.includes('typeorm')) tags.add('TypeORM');
        if (depKeys.includes('firebase')) tags.add('Firebase');
        if (depKeys.includes('better-sqlite3') || depKeys.includes('sqlite3')) tags.add('SQLite');
        if (depKeys.includes('pg')) tags.add('PostgreSQL');
        if (depKeys.includes('mongodb')) tags.add('MongoDB');
        if (depKeys.includes('three')) tags.add('Three.js');
        if (depKeys.includes('framer-motion') || depKeys.includes('motion')) tags.add('Framer Motion');
    }
    // File-extension sniff
    try {
        const entries = require('fs').readdirSync(rootDir);
        if (entries.includes('pubspec.yaml')) tags.add('Flutter/Dart');
        if (entries.includes('Cargo.toml')) tags.add('Rust');
        if (entries.includes('go.mod')) tags.add('Go');
        if (entries.includes('requirements.txt') || entries.includes('pyproject.toml')) tags.add('Python');
        if (entries.includes('pnpm-workspace.yaml') || entries.includes('pnpm-lock.yaml')) tags.add('pnpm');
        if (entries.includes('yarn.lock')) tags.add('Yarn');
    } catch { /* non-fatal */ }

    return Array.from(tags).slice(0, 8).join(' + ') || '';
}

async function readPackageJson(rootDir: string): Promise<any | null> {
    const pjPath = path.join(rootDir, 'package.json');
    try {
        const st = statSync(pjPath);
        if (!st.isFile() || st.size > 200_000) return null;
        const raw = await fs.readFile(pjPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function discoverProjectAt(rootDir: string): Promise<DiscoveredProject | null> {
    if (!hasProjectMarker(rootDir)) return null;

    const packageJson = await readPackageJson(rootDir);
    const name = (packageJson?.name && typeof packageJson.name === 'string')
        ? packageJson.name
        : path.basename(rootDir);

    // Collect key docs (top-level only — keeps the scan fast).
    const files: DiscoveredFile[] = [];
    for (const key of KEY_DOC_FILES) {
        if (files.length >= PROJECT_LIMITS.MAX_FILES_PER_PROJECT) break;
        const abs = path.join(rootDir, key);
        const text = await safeReadText(abs, PROJECT_LIMITS.MAX_FILE_BYTES);
        if (text != null) {
            files.push({
                filePath: key,
                fileName: key,
                content: text,
                sizeBytes: text.length,
            });
        }
    }

    // Also try docs/**/*.md (one level deep) to capture a few more useful files.
    try {
        const docsDir = path.join(rootDir, 'docs');
        const st = statSync(docsDir);
        if (st.isDirectory()) {
            const subEntries = await fs.readdir(docsDir);
            for (const sub of subEntries) {
                if (files.length >= PROJECT_LIMITS.MAX_FILES_PER_PROJECT) break;
                if (isExcluded(sub)) continue;
                const ext = path.extname(sub).toLowerCase();
                if (!READABLE_FILE_EXTS.includes(ext)) continue;
                const abs = path.join(docsDir, sub);
                const text = await safeReadText(abs, PROJECT_LIMITS.MAX_FILE_BYTES);
                if (text != null) {
                    files.push({
                        filePath: path.join('docs', sub),
                        fileName: sub,
                        content: text,
                        sizeBytes: text.length,
                    });
                }
            }
        }
    } catch { /* no docs/ — non-fatal */ }

    const readme = pickFirstReadme(files);
    const autoSummary = extractAutoSummary(readme?.content ?? null, packageJson);
    const stack = inferStack(rootDir, packageJson);

    let gitRemote: string | null = null;
    let lastCommit: string | null = null;
    if (existsSync(path.join(rootDir, '.git'))) {
        const [remote, last] = await Promise.all([
            runGit(['config', '--get', 'remote.origin.url'], rootDir),
            runGit(['log', '-1', '--format=%h %s'], rootDir),
        ]);
        gitRemote = remote;
        lastCommit = last;
    }

    return {
        rootPath: rootDir,
        name,
        stack,
        description: '',
        autoSummary,
        gitRemote,
        lastCommit,
        files,
    };
}

async function walkForProjects(
    rootDir: string,
    depth: number,
    results: DiscoveredProject[],
    abortSignal?: { aborted: boolean },
): Promise<void> {
    if (abortSignal?.aborted) return;
    if (depth > PROJECT_LIMITS.MAX_SCAN_DEPTH) return;
    if (isExcluded(rootDir)) return;

    let stat;
    try {
        stat = statSync(rootDir);
    } catch {
        return;
    }
    if (!stat.isDirectory()) return;

    // If this directory itself is a project, capture it and STOP descending
    // (a project root is a leaf for discovery — subdirs would be inner
    // packages of the same project, which we don't want to surface
    // separately).
    if (hasProjectMarker(rootDir)) {
        const p = await discoverProjectAt(rootDir);
        if (p) results.push(p);
        return;
    }

    let entries: string[];
    try {
        entries = await fs.readdir(rootDir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (abortSignal?.aborted) return;
        if (isExcluded(entry)) continue;
        const abs = path.join(rootDir, entry);
        try {
            const st = statSync(abs);
            if (st.isDirectory()) {
                await walkForProjects(abs, depth + 1, results, abortSignal);
            }
        } catch {
            // unreadable — skip
        }
    }
}

/**
 * Scan the given roots and return every project found. Roots are
 * expanded (~ -> home dir) and may not exist — they are silently skipped.
 */
export async function discoverProjects(opts: DiscoveryOptions = {}): Promise<DiscoveredProject[]> {
    const roots = (opts.roots ?? DEFAULT_SCAN_ROOTS).map(expandHome);
    const results: DiscoveredProject[] = [];
    const seen = new Set<string>(); // dedupe by absolute path

    for (let i = 0; i < roots.length; i++) {
        const root = roots[i];
        opts.onProgress?.({
            scannedRoots: i,
            totalRoots: roots.length,
            currentRoot: root,
            found: results.length,
        });
        if (!existsSync(root)) continue;
        await walkForProjects(root, 0, results, opts.abortSignal);
    }

    // Dedupe results by absolute path.
    const unique = results.filter((p) => {
        if (seen.has(p.rootPath)) return false;
        seen.add(p.rootPath);
        return true;
    });

    opts.onProgress?.({
        scannedRoots: roots.length,
        totalRoots: roots.length,
        currentRoot: '',
        found: unique.length,
    });

    // Sort: by folder name, case-insensitive.
    unique.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return unique;
}

/**
 * Discover a single project at a given path. Used for "rescan" actions.
 * Returns null if the path no longer looks like a project.
 */
export async function rediscoverProject(rootPath: string): Promise<DiscoveredProject | null> {
    const abs = expandHome(rootPath);
    if (!existsSync(abs)) return null;
    return discoverProjectAt(abs);
}

export const ProjectDiscovery = {
    discoverProjects,
    rediscoverProject,
    DEFAULT_SCAN_ROOTS,
};
