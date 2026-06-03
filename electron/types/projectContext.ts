// Project Context types — used by ProjectDiscovery, ProjectContextManager,
// IPC handlers, preload bridge, and the LLM prompt assembly.
//
// A "ProjectContext" is a versioned local project that the user can pick
// as the active context for a meeting. It is ORTHOGONAL to "Mode" (persona):
// you can be in mode "Sales" while the active project is "PharmaOps".

export interface ProjectContext {
  id: string;
  name: string;
  rootPath: string;
  stack: string | null;
  description: string;
  autoSummary: string;
  gitRemote: string | null;
  lastCommit: string | null;
  lastScannedAt: string;
  isActive: boolean;
  createdAt: string;
}

export interface ProjectTopic {
  id: string;
  projectId: string;
  title: string;
  description: string;
  sortOrder: number;
  createdAt: string;
}

export interface ProjectIndexedFile {
  id: string;
  projectId: string;
  filePath: string;
  fileName: string;
  content: string;
  sizeBytes: number;
  indexedAt: string;
}

// A "discovered" project — the result of a filesystem scan, before any
// user editing. The fields are slightly different from a stored
// ProjectContext: the user may not have validated the discovery yet.
export interface DiscoveredProject {
  rootPath: string;
  name: string;
  stack: string;
  description: string;
  autoSummary: string;
  gitRemote: string | null;
  lastCommit: string | null;
  files: DiscoveredFile[];
}

export interface DiscoveredFile {
  filePath: string; // relative to rootPath
  fileName: string;
  content: string;
  sizeBytes: number;
}

// Used to seed a new project from a discovery result, while letting the
// caller override the id and active flag.
export interface UpsertProjectContextInput {
  id?: string;
  name: string;
  rootPath: string;
  stack: string | null;
  description: string;
  autoSummary: string;
  gitRemote: string | null;
  lastCommit: string | null;
  isActive?: boolean;
}

// Default scan roots used by ProjectDiscovery when the user has not
// configured a custom list. Mac/Linux/Windows-safe: the "~" prefix is
// expanded to os.homedir() at scan time.
export const DEFAULT_SCAN_ROOTS: string[] = [
  '~/aws.bj',
  '~/Desktop/Projects',
  '~/locapay',
  '~/ReactNative/Locapay',
  '~/projects',
];

// Filenames (no extension) that mark a directory as a "project root" when
// they sit at the top level. presence of any one of these triggers a scan
// of the directory.
export const PROJECT_MARKERS: string[] = [
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'pubspec.yaml',
  '.git',
];

// Filenames (relative paths) that ProjectDiscovery will try to read for
// auto-summary extraction. First match wins.
export const KEY_DOC_FILES: string[] = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.MD',
  'ARCHITECTURE.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CHANGELOG.md',
];

// Directory names excluded entirely from the scan. Matches anywhere in
// the path. This protects us from descending into node_modules, build
// outputs, vcs internals, etc.
export const EXCLUDED_PATH_SEGMENTS: string[] = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'release',
  'build',
  'target',
  '.expo',
  '.turbo',
  'coverage',
  '.cache',
  '.parcel-cache',
  'out',
  'temp',
  '.DS_Store',
];

// File extensions considered for auto-extraction. Other extensions are
// skipped to avoid binary bloat.
export const READABLE_FILE_EXTS: string[] = [
  '.md',
  '.markdown',
  '.txt',
  '.rst',
];

// Hard caps enforced by ProjectDiscovery / ProjectContextManager to keep
// the system prompt and DB row sizes bounded.
export const PROJECT_LIMITS = {
  MAX_SCAN_DEPTH: 3,
  MAX_FILES_PER_PROJECT: 20,
  MAX_FILE_BYTES: 50_000,        // 50 KB per file
  MAX_AUTO_SUMMARY_CHARS: 1_500,
  MAX_DESCRIPTION_CHARS: 4_000,
  MAX_TOPIC_TITLE_CHARS: 200,
  MAX_TOPIC_DESCRIPTION_CHARS: 1_000,
  MAX_TOTAL_PROMPT_CHARS: 3_000, // the [ACTIVE PROJECT] block sent to the LLM
};
