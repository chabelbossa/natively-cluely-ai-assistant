// ProjectContextManager — the user-facing layer on top of the
// project_contexts tables. It owns:
//   - the row<->object mapping (mirror of ModesManager's rowToX pattern)
//   - dedup-by-git-remote when ingesting a fresh discovery batch
//   - the singleton active-project state
//   - the prompt-block builder used by LLMHelper
//   - the scan-orchestration helpers (which call ProjectDiscovery and
//     merge results into the DB).

import { randomUUID } from 'crypto';

import { DatabaseManager } from '../db/DatabaseManager';
import {
    DiscoveredFile,
    DiscoveredProject,
    PROJECT_LIMITS,
    ProjectContext,
    ProjectIndexedFile,
    ProjectTopic,
    UpsertProjectContextInput,
} from '../types/projectContext';
import { ProjectDiscovery } from './ProjectDiscovery';

function rowToProject(row: any): ProjectContext {
    return {
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        stack: row.stack ?? null,
        description: row.description ?? '',
        autoSummary: row.auto_summary ?? '',
        gitRemote: row.git_remote ?? null,
        lastCommit: row.last_commit ?? null,
        lastScannedAt: row.last_scanned_at ?? '',
        isActive: row.is_active === 1,
        createdAt: row.created_at,
    };
}

function rowToTopic(row: any): ProjectTopic {
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        description: row.description ?? '',
        sortOrder: row.sort_order ?? 0,
        createdAt: row.created_at,
    };
}

function rowToFile(row: any): ProjectIndexedFile {
    return {
        id: row.id,
        projectId: row.project_id,
        filePath: row.file_path,
        fileName: row.file_name,
        content: row.content ?? '',
        sizeBytes: row.size_bytes ?? 0,
        indexedAt: row.indexed_at,
    };
}

function genId(prefix: string): string {
    return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export class ProjectContextManager {
    private static instance: ProjectContextManager;

    private constructor() {}

    public static getInstance(): ProjectContextManager {
        if (!ProjectContextManager.instance) {
            ProjectContextManager.instance = new ProjectContextManager();
        }
        return ProjectContextManager.instance;
    }

    // ── Projects ──────────────────────────────────────────────────

    public getAll(): ProjectContext[] {
        return DatabaseManager.getInstance().getProjectContexts().map(rowToProject);
    }

    public getById(id: string): ProjectContext | null {
        const row = DatabaseManager.getInstance().getProjectContextById(id);
        return row ? rowToProject(row) : null;
    }

    public getByPath(rootPath: string): ProjectContext | null {
        const row = DatabaseManager.getInstance().getProjectContextByPath(rootPath);
        return row ? rowToProject(row) : null;
    }

    public getActive(): ProjectContext | null {
        const row = DatabaseManager.getInstance().getActiveProjectContext();
        return row ? rowToProject(row) : null;
    }

    /**
     * Insert or update a project by its rootPath (which is UNIQUE in the
     * schema). If the path already exists, name/stack/description/summary
     * are refreshed but the user-edited description is preserved unless
     * the caller provides a new one.
     */
    public upsertFromDiscovery(discovered: DiscoveredProject): ProjectContext {
        const db = DatabaseManager.getInstance();
        const existing = db.getProjectContextByPath(discovered.rootPath);
        const id = existing?.id ?? genId('proj');

        // Preserve any user-edited description on re-scan.
        const preservedDescription = existing?.description ?? '';

        db.upsertProjectContext({
            id,
            name: discovered.name,
            rootPath: discovered.rootPath,
            stack: discovered.stack || null,
            description: preservedDescription,
            autoSummary: discovered.autoSummary,
            gitRemote: discovered.gitRemote,
            lastCommit: discovered.lastCommit,
            isActive: existing?.isActive ?? false,
        });

        // Replace the indexed files in a single transaction.
        const files: Array<{ id: string; filePath: string; fileName: string; content: string; sizeBytes: number }> =
            discovered.files.map((f: DiscoveredFile) => ({
                id: genId('pf'),
                filePath: f.filePath,
                fileName: f.fileName,
                content: f.content,
                sizeBytes: f.sizeBytes,
            }));
        db.replaceProjectIndexedFiles(id, files);

        return this.getById(id)!;
    }

    /**
     * Take a batch of DiscoveredProject, upsert each one, then collapse
     * duplicates that share a git remote: the first one wins, the rest
     * have their topics/files merged onto the survivor. Returns the
     * surviving ProjectContext list, in user-friendly order.
     */
    public ingestDiscoveryBatch(discovered: DiscoveredProject[]): ProjectContext[] {
        // 1. Upsert everything.
        const upserted: ProjectContext[] = [];
        for (const d of discovered) {
            upserted.push(this.upsertFromDiscovery(d));
        }

        // 2. Group by git remote (skip projects without a remote — they
        //    are kept as-is since they can't be reliably deduped).
        const byRemote = new Map<string, ProjectContext[]>();
        for (const p of upserted) {
            if (!p.gitRemote) continue;
            const key = p.gitRemote;
            if (!byRemote.has(key)) byRemote.set(key, []);
            byRemote.get(key)!.push(p);
        }

        // 3. For each remote with >1 project, merge the survivors.
        const db = DatabaseManager.getInstance();
        for (const [, group] of byRemote) {
            if (group.length <= 1) continue;
            // Survivor = first (alphabetical) project.
            group.sort((a, b) => a.name.localeCompare(b.name));
            const survivor = group[0];
            const victims = group.slice(1);

            // Move topics and indexed files from victims onto the survivor.
            const txn = db.getDb()?.transaction(() => {
                for (const victim of victims) {
                    const victimTopics = db.getProjectTopics(victim.id);
                    const existingTopics = db.getProjectTopics(survivor.id);
                    let nextSort = existingTopics.length;
                    for (const t of victimTopics) {
                        db.addProjectTopic({
                            id: genId('topic'),
                            projectId: survivor.id,
                            title: t.title,
                            description: t.description,
                            sortOrder: nextSort++,
                        });
                    }
                    // Files: union by file_name.
                    const survivorFiles = new Set(
                        db.getProjectIndexedFiles(survivor.id).map((f: any) => f.file_name as string)
                    );
                    const victimFiles = db.getProjectIndexedFiles(victim.id);
                    const merged = [
                        ...db.getProjectIndexedFiles(survivor.id).map(rowToFile),
                    ];
                    for (const vf of victimFiles) {
                        if (!survivorFiles.has(vf.file_name)) {
                            merged.push({
                                id: genId('pf'),
                                projectId: survivor.id,
                                filePath: vf.file_path,
                                fileName: vf.file_name,
                                content: vf.content,
                                sizeBytes: vf.size_bytes,
                                indexedAt: new Date().toISOString(),
                            });
                        }
                    }
                    db.replaceProjectIndexedFiles(survivor.id, merged.map((f) => ({
                        id: f.id,
                        filePath: f.filePath,
                        fileName: f.fileName,
                        content: f.content,
                        sizeBytes: f.sizeBytes,
                    })));
                    // Delete the victim row — cascade wipes its topics/files.
                    db.deleteProjectContext(victim.id);
                }
            });
            try { txn?.(); } catch (e) {
                console.error('[ProjectContextManager] dedup txn failed:', e);
            }
        }

        return this.getAll();
    }

    public update(id: string, updates: { name?: string; description?: string; stack?: string | null; autoSummary?: string }): void {
        const safeUpdates: { name?: string; description?: string; stack?: string | null; autoSummary?: string } = {};
        if (updates.name !== undefined) {
            safeUpdates.name = updates.name.slice(0, 200);
        }
        if (updates.description !== undefined) {
            safeUpdates.description = updates.description.slice(0, PROJECT_LIMITS.MAX_DESCRIPTION_CHARS);
        }
        if (updates.stack !== undefined) {
            safeUpdates.stack = updates.stack;
        }
        if (updates.autoSummary !== undefined) {
            safeUpdates.autoSummary = updates.autoSummary.slice(0, PROJECT_LIMITS.MAX_AUTO_SUMMARY_CHARS);
        }
        DatabaseManager.getInstance().updateProjectContext(id, safeUpdates);
    }

    public delete(id: string): void {
        DatabaseManager.getInstance().deleteProjectContext(id);
    }

    public setActive(id: string | null): void {
        DatabaseManager.getInstance().setActiveProjectContext(id);
    }

    // ── Topics ────────────────────────────────────────────────────

    public getTopics(projectId: string): ProjectTopic[] {
        return DatabaseManager.getInstance().getProjectTopics(projectId).map(rowToTopic);
    }

    public addTopic(projectId: string, title: string, description: string): ProjectTopic {
        const safeTitle = title.trim().slice(0, PROJECT_LIMITS.MAX_TOPIC_TITLE_CHARS);
        const safeDesc = description.trim().slice(0, PROJECT_LIMITS.MAX_TOPIC_DESCRIPTION_CHARS);
        const existing = this.getTopics(projectId);
        const id = genId('topic');
        const sortOrder = existing.length;
        DatabaseManager.getInstance().addProjectTopic({
            id,
            projectId,
            title: safeTitle,
            description: safeDesc,
            sortOrder,
        });
        return {
            id,
            projectId,
            title: safeTitle,
            description: safeDesc,
            sortOrder,
            createdAt: new Date().toISOString(),
        };
    }

    public updateTopic(id: string, updates: { title?: string; description?: string; sortOrder?: number }): void {
        const safeUpdates: { title?: string; description?: string; sortOrder?: number } = {};
        if (updates.title !== undefined) safeUpdates.title = updates.title.trim().slice(0, PROJECT_LIMITS.MAX_TOPIC_TITLE_CHARS);
        if (updates.description !== undefined) safeUpdates.description = updates.description.trim().slice(0, PROJECT_LIMITS.MAX_TOPIC_DESCRIPTION_CHARS);
        if (updates.sortOrder !== undefined) safeUpdates.sortOrder = updates.sortOrder;
        DatabaseManager.getInstance().updateProjectTopic(id, safeUpdates);
    }

    public deleteTopic(id: string): void {
        DatabaseManager.getInstance().deleteProjectTopic(id);
    }

    // ── Scan orchestration ────────────────────────────────────────

    /**
     * Run a fresh scan, upsert everything found, dedupe by remote, and
     * return the final project list.
     */
    public async scanAndIngest(opts?: { roots?: string[]; onProgress?: (p: { scannedRoots: number; totalRoots: number; currentRoot: string; found: number }) => void; abortSignal?: { aborted: boolean } }): Promise<ProjectContext[]> {
        const discovered = await ProjectDiscovery.discoverProjects(opts);
        return this.ingestDiscoveryBatch(discovered);
    }

    public async rescanOne(rootPath: string): Promise<ProjectContext | null> {
        const redisc = await ProjectDiscovery.rediscoverProject(rootPath);
        if (!redisc) {
            // Project root is gone or no longer looks like a project —
            // delete it from the DB to keep the UI honest.
            const existing = this.getByPath(rootPath);
            if (existing) this.delete(existing.id);
            return null;
        }
        return this.upsertFromDiscovery(redisc);
    }

    // ── Prompt block builder ──────────────────────────────────────

    /**
     * Build the [ACTIVE PROJECT]…[/ACTIVE PROJECT] string injected into
     * the LLM system prompt. Returns an empty string if no project is
     * active, so callers can safely concatenate.
     *
     * Format:
     *   [ACTIVE PROJECT — <name>]
     *   Stack: <stack>
     *   Last commit: <lastCommit>
     *   Description: <user description>
     *   <autoSummary>
     *   [PROJECT TOPICS]
     *   - title: description
     *   [/PROJECT TOPICS]
     *   [/ACTIVE PROJECT]
     *
     * The total block is hard-capped at PROJECT_LIMITS.MAX_TOTAL_PROMPT_CHARS.
     */
    public buildActiveProjectContextBlock(): string {
        const project = this.getActive();
        if (!project) return '';

        const parts: string[] = [];
        const header = `[ACTIVE PROJECT — ${project.name}]`;
        parts.push(header);

        if (project.stack) parts.push(`Stack: ${project.stack}`);
        if (project.lastCommit) parts.push(`Last commit: ${project.lastCommit}`);
        if (project.gitRemote) parts.push(`Repository: ${project.gitRemote}`);

        const description = (project.description ?? '').trim();
        if (description) {
            parts.push(`Description: ${description}`);
        }
        const summary = (project.autoSummary ?? '').trim();
        if (summary) {
            parts.push(`\n${summary}`);
        }

        const topics = this.getTopics(project.id).filter((t) => t.title.trim().length > 0);
        if (topics.length > 0) {
            parts.push('\n[PROJECT TOPICS]');
            for (const t of topics) {
                const line = t.description.trim()
                    ? `- ${t.title}: ${t.description.trim()}`
                    : `- ${t.title}`;
                parts.push(line);
            }
            parts.push('[/PROJECT TOPICS]');
        }

        parts.push('[/ACTIVE PROJECT]');
        let block = parts.join('\n');

        if (block.length > PROJECT_LIMITS.MAX_TOTAL_PROMPT_CHARS) {
            block = block.slice(0, PROJECT_LIMITS.MAX_TOTAL_PROMPT_CHARS - 18) + '\n[...truncated]';
        }
        return block;
    }
}

export const PROJECT_CONTEXT_DEFAULT_DESCRIPTION_MAX = PROJECT_LIMITS.MAX_DESCRIPTION_CHARS;
