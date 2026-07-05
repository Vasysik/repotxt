import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

type Range = { start: number; end: number };

interface SessionState {
    includes: string[];
    excludes: string[];
    partialIncludes?: { [key: string]: Range[] };
}

interface NodeState {
    path: string;
    excluded: boolean;
    partial: boolean;
}

interface CachedFileStats {
    lines: number;
    chars: number;
    mtimeMs: number;
    size: number;
}

interface CachedFolderStats {
    lines: number;
    chars: number;
    files: number;
    version: number;
}

export class RepoAnalyzerCore {
    private workspaceRoot: string | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    private autoIgnore: Ignore = ignore();
    private manualIncludes: Set<string> = new Set();
    private manualExcludes: Set<string> = new Set();
    private partialIncludes: Map<string, Range[]> = new Map();

    // Indexed prefix lookup for "does any include sit under this folder?"
    // Sorted arrays of (normalized with trailing sep) paths for fast prefix scan.
    private sortedIncludes: string[] = [];
    private sortedPartials: string[] = [];

    // Caches: persistent across refreshes, invalidated by mtime/size.
    private fileStatsCache = new Map<string, CachedFileStats>();
    // version bumps whenever any included file under that subtree changes.
    private folderStatsCache = new Map<string, CachedFolderStats>();
    // selection stats cache (whole workspace) — invalidated by manual edits / file changes.
    private selectionStatsCache: { lines: number; chars: number; files: number; version: number } | null = null;
    private cacheVersion: number = 0;

    // Per-call memoization for exclusion checks (cleared on refresh).
    private effectiveExcludedMemo = new Map<string, boolean>();

    // Configuration cache (settings are read once per recalculation).
    private cfg = {
        excludeBinaryFiles: true,
        checkFileSize: true,
        maxFileSize: 1048576,
        binaryExtensions: new Set<string>(),
        trimTrailingWhitespace: false,
    };

    // Runtime counters for report generation
    private currentReportSize: number = 0;
    private reportLimitHit: boolean = false;

    private readonly sessionStateKey = 'repotxt.sessionState';

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private _onDidUpdateNodes = new vscode.EventEmitter<NodeState[]>();
    readonly onDidUpdateNodes = this._onDidUpdateNodes.event;

    private _onDidUpdatePartial = new vscode.EventEmitter<string>();
    readonly onDidUpdatePartial = this._onDidUpdatePartial.event;

    private refreshTimeout: NodeJS.Timeout | undefined;
    private rebuildIgnoreTimeout: NodeJS.Timeout | undefined;

    // Low-volume diagnostics. The channel is always available under
    // Output -> "RepoTxt" and intentionally logs aggregates instead of every
    // file-system event so logging cannot become the performance problem.
    private readonly outputChannel: vscode.OutputChannel;
    private watcherLogTimeout: NodeJS.Timeout | undefined;
    private watcherBurst = {
        create: 0,
        change: 0,
        delete: 0,
        excluded: 0,
        ignoreFiles: 0,
        accepted: 0,
        topPaths: new Map<string, number>(),
    };

    private selectionStatsComputeRunning = false;
    private selectionStatsRecomputePending = false;
    private workspaceReady = false;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('RepoTxt');
        this.context.subscriptions.push(this.outputChannel);
        this.log(`[activate] RepoTxt ${String(this.context.extension.packageJSON.version ?? 'dev')}`);

        void this.initialize().catch(error => this.logError('[init] failed', error));
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                void this.initialize().catch(error => this.logError('[init] workspace change failed', error));
            })
        );
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt')) {
                void this.recalculateAutoExclusions()
                    .then(() => this.refresh())
                    .catch(error => this.logError('[config] recalculation failed', error));
            }
        });
    }

    public showLogs(): void {
        this.outputChannel.show(true);
    }

    public diagnosticLog(message: string): void {
        this.log(message);
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }

    private logError(message: string, error: unknown): void {
        const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}: ${detail}`);
    }

    // ---------- Initialization ----------

    private async initialize() {
        const startedAt = Date.now();
        this.workspaceReady = false;
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.workspaceRoot = folders[0].uri.fsPath;
            this.log(`[init] workspace=${this.workspaceRoot}`);
            this.loadState();
            this.rebuildIndices();
            await this.recalculateAutoExclusions();
            this.setupFileWatcher();
            this.workspaceReady = true;
            this.refresh();
            this.log(`[init] ready in ${Date.now() - startedAt}ms`);
        } else {
            this.workspaceRoot = undefined;
            this.workspaceReady = false;
            this.fileWatcher?.dispose();
            this.fileWatcher = undefined;
            this.log('[init] no workspace folder');
        }
    }

    private setupFileWatcher() {
        if (this.fileWatcher) this.fileWatcher.dispose();
        if (!this.workspaceRoot) return;

        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '**/*')
        );
        this.log('[watcher] watching workspace pattern **/*');

        const isIgnoreFile = (uri: vscode.Uri) => {
            const names = vscode.workspace.getConfiguration('repotxt')
                .get<string[]>('ignoreFileNames', ['.gitignore']);
            return names.includes(path.basename(uri.fsPath));
        };

        const handleEvent = (uri: vscode.Uri, type: 'create' | 'change' | 'delete') => {
            const fsPath = uri.fsPath;
            this.recordWatcherEvent(fsPath, type);

            // Ignore file edits → rebuild ignore rules
            if (isIgnoreFile(uri)) {
                this.watcherBurst.ignoreFiles++;
                this.scheduleRebuildIgnore();
                return;
            }

            // Skip ALL events for paths that are excluded anyway. Previously
            // create/delete events in build/, .git/, dist/, etc. still
            // invalidated caches and scheduled a full stats recompute.
            if (this.isPathEffectivelyExcluded(fsPath)) {
                this.watcherBurst.excluded++;
                return;
            }

            this.watcherBurst.accepted++;

            // Invalidate stats for this file and any parents.
            this.fileStatsCache.delete(fsPath);
            this.blockMetricsCache.delete(fsPath);
            this.invalidateAncestorFolderStats(fsPath);
            this.selectionStatsCache = null;
            this.validateRanges(fsPath);
            this.debouncedRefresh();
        };

        this.fileWatcher.onDidCreate(uri => handleEvent(uri, 'create'));
        this.fileWatcher.onDidDelete(uri => handleEvent(uri, 'delete'));
        this.fileWatcher.onDidChange(uri => handleEvent(uri, 'change'));
    }

    private recordWatcherEvent(fsPath: string, type: 'create' | 'change' | 'delete'): void {
        this.watcherBurst[type]++;

        if (this.workspaceRoot) {
            const rel = path.relative(this.workspaceRoot, fsPath);
            const top = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
                ? rel.split(path.sep)[0] || '.'
                : '<outside-workspace>';
            this.watcherBurst.topPaths.set(top, (this.watcherBurst.topPaths.get(top) ?? 0) + 1);
        }

        if (!this.watcherLogTimeout) {
            this.watcherLogTimeout = setTimeout(() => this.flushWatcherBurstLog(), 1000);
        }
    }

    private flushWatcherBurstLog(): void {
        this.watcherLogTimeout = undefined;
        const burst = this.watcherBurst;
        const total = burst.create + burst.change + burst.delete;
        if (total === 0) return;

        const top = Array.from(burst.topPaths.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => `${name}:${count}`)
            .join(', ');

        const severity = total >= 1000 ? 'storm' : 'burst';
        this.log(
            `[watcher:${severity}] total=${total} create=${burst.create} change=${burst.change} ` +
            `delete=${burst.delete} accepted=${burst.accepted} excluded=${burst.excluded} ` +
            `ignoreFiles=${burst.ignoreFiles}${top ? ` top=[${top}]` : ''}`
        );

        burst.create = 0;
        burst.change = 0;
        burst.delete = 0;
        burst.excluded = 0;
        burst.ignoreFiles = 0;
        burst.accepted = 0;
        burst.topPaths.clear();
    }

    private scheduleRebuildIgnore() {
        if (this.rebuildIgnoreTimeout) clearTimeout(this.rebuildIgnoreTimeout);
        this.rebuildIgnoreTimeout = setTimeout(async () => {
            try {
                await this.recalculateAutoExclusions();
                this.refresh();
            } catch (error) {
                this.logError('[ignore] rebuild failed', error);
            }
        }, 200);
    }

    // ---------- Persistence ----------

    private saveState(): void {
        if (!this.workspaceRoot) return;
        const partialIncludesObj: { [key: string]: Range[] } = {};
        this.partialIncludes.forEach((ranges, p) => {
            partialIncludesObj[p] = ranges;
        });
        this.context.workspaceState.update(this.sessionStateKey, {
            includes: Array.from(this.manualIncludes),
            excludes: Array.from(this.manualExcludes),
            partialIncludes: partialIncludesObj,
        });
        this.rebuildIndices();
    }

    private loadState(): void {
        if (!this.workspaceRoot) return;
        const state = this.context.workspaceState.get<SessionState>(this.sessionStateKey);
        this.manualIncludes = new Set(state?.includes || []);
        this.manualExcludes = new Set(state?.excludes || []);
        this.partialIncludes.clear();
        if (state?.partialIncludes) {
            Object.entries(state.partialIncludes).forEach(([p, ranges]) => {
                this.partialIncludes.set(p, ranges);
            });
        }
    }

    public async resetExclusions() {
        if (!this.workspaceRoot) return;
        this.manualIncludes.clear();
        this.manualExcludes.clear();
        this.partialIncludes.clear();
        this.saveState();
        this.refresh();
        vscode.window.showInformationMessage('All manual settings (exclusions & selections) have been reset.');
    }

    // ---------- Ignore rules (auto-exclude + gitignore) ----------

    private async recalculateAutoExclusions() {
        if (!this.workspaceRoot) return;
        const startedAt = Date.now();
        let autoPatternCount = 0;
        let rootIgnoreCount = 0;
        let nestedIgnoreCount = 0;

        const config = vscode.workspace.getConfiguration('repotxt');
        this.cfg.excludeBinaryFiles = config.get<boolean>('excludeBinaryFiles', true);
        this.cfg.checkFileSize = config.get<boolean>('checkFileSize', true);
        this.cfg.maxFileSize = config.get<number>('maxFileSize', 1048576);
        const exts = config.get<string[]>('binaryFileExtensions', []).map(e => e.toLowerCase());
        this.cfg.binaryExtensions = new Set(exts);
        this.cfg.trimTrailingWhitespace = config.get<boolean>('trimTrailingWhitespace', false);

        const ig = ignore();

        // Auto patterns
        if (config.get<boolean>('autoExcludeEnabled', true)) {
            const patterns = config.get<string[]>('autoExcludePatterns', []) ?? [];
            autoPatternCount = patterns.length;
            ig.add(patterns);
        }

        // Ignore-file integration (root + nested)
        if (config.get<boolean>('respectIgnoreFiles', true)) {
            const ignoreFileNames = config.get<string[]>('ignoreFileNames', ['.gitignore']);

            // Read the ROOT ignore file(s) first. This lets the directory walk
            // below prune folders that are already ignored (e.g. a huge .venv,
            // vendor/, build/ or target/ listed in the root .gitignore) instead
            // of descending into them — which is what made activation hang on
            // large repositories.
            for (const name of ignoreFileNames) {
                const rootFile = path.join(this.workspaceRoot, name);
                try {
                    const raw = await fs.promises.readFile(rootFile, 'utf8');
                    ig.add(this.adjustGitignorePatterns(raw, ''));
                    rootIgnoreCount++;
                } catch { /* no root ignore file of this name */ }
            }

            const rootSet = new Set(
                ignoreFileNames.map(n => path.join(this.workspaceRoot!, n)),
            );

            // Now discover NESTED ignore files, skipping anything the matcher so
            // far already excludes.
            const found = await this.findIgnoreFiles(ignoreFileNames, ig);
            for (const file of found) {
                if (rootSet.has(file)) continue; // already added above
                try {
                    const raw = await fs.promises.readFile(file, 'utf8');
                    const rel = path.relative(this.workspaceRoot, path.dirname(file))
                        .split(path.sep)
                        .join('/');
                    // Adjust each pattern so it applies relative to the workspace root,
                    // not to the directory the gitignore lives in.
                    const adjusted = this.adjustGitignorePatterns(raw, rel);
                    ig.add(adjusted);
                    nestedIgnoreCount++;
                } catch (e) {
                    this.logError(`[ignore] failed to read ${file}`, e);
                }
            }
        }

        this.autoIgnore = ig;
        this.effectiveExcludedMemo.clear();
        this.log(
            `[ignore] rebuilt in ${Date.now() - startedAt}ms ` +
            `autoPatterns=${autoPatternCount} rootFiles=${rootIgnoreCount} nestedFiles=${nestedIgnoreCount}`
        );
    }

    /**
     * Find all configured ignore-files anywhere in the workspace.
     *
     * The walk is bounded so it can never hang on a huge repository:
     *  - directories already excluded by `ig` (e.g. from the root .gitignore)
     *    are not descended into;
     *  - a curated set of heavy/irrelevant dirs is always skipped;
     *  - hard caps on visited-directory count and depth act as a backstop.
     */
    private async findIgnoreFiles(
        names: string[],
        ig?: ReturnType<typeof ignore>,
    ): Promise<string[]> {
        if (!this.workspaceRoot) return [];
        const root = this.workspaceRoot;
        const found: string[] = [];
        const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

        // These essentially never hold meaningful nested ignore files and can be
        // enormous, so we never descend into them regardless of patterns.
        const skipDirs = new Set(['.git', 'node_modules', '.hg', '.svn', '.cache']);

        const MAX_DIRS = 20000; // backstop against pathological trees
        const MAX_DEPTH = 12;
        let visited = 0;
        let hitDirectoryCap = false;

        while (stack.length) {
            const { dir, depth } = stack.pop()!;
            if (++visited > MAX_DIRS) {
                hitDirectoryCap = true;
                break;
            }

            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (skipDirs.has(entry.name)) continue;
                    if (depth >= MAX_DEPTH) continue;
                    // Prune directories the current matcher already ignores.
                    if (ig) {
                        const rel = path.relative(root, full).split(path.sep).join('/');
                        if (rel && (ig.ignores(rel) || ig.ignores(rel + '/'))) continue;
                    }
                    stack.push({ dir: full, depth: depth + 1 });
                } else if (names.includes(entry.name)) {
                    found.push(full);
                }
            }
        }
        this.log(
            `[ignore-scan] visitedDirs=${Math.min(visited, MAX_DIRS)} found=${found.length} ` +
            `maxDepth=${MAX_DEPTH}${hitDirectoryCap ? ' capped=true' : ''}`
        );
        return found;
    }

    /**
     * Re-base gitignore patterns from a subdirectory so they can be added to a
     * single workspace-root Ignore instance.
     *
     *   in src/.gitignore   →   prefix = "src"
     *      *.log            →   src/**\/*.log
     *      /build           →   src/build
     *      foo/             →   src/**\/foo/
     *      !keep.log        →   !src/**\/keep.log
     */
    private adjustGitignorePatterns(raw: string, dirRel: string): string[] {
        const lines = raw.split(/\r?\n/);
        const out: string[] = [];
        for (let line of lines) {
            // strip CR / whitespace
            line = line.replace(/\s+$/g, '');
            if (!line) continue;
            // Skip pure comments (a `#` mid-line is part of the pattern per gitignore rules,
            // but escaped `\#` becomes literal `#`).
            if (line.startsWith('#')) continue;
            if (line.startsWith('\\#')) line = line.slice(1);

            let negated = false;
            if (line.startsWith('!')) {
                negated = true;
                line = line.slice(1);
            }
            if (!line) continue;

            if (!dirRel || dirRel === '.' || dirRel === '') {
                // root-level gitignore — patterns apply as-is
                out.push((negated ? '!' : '') + line);
                continue;
            }

            // Patterns rooted with leading "/" anchor to the gitignore's directory.
            // Patterns without "/" (other than trailing) match anywhere within the dir.
            const hasMidSlash = line.replace(/\/$/, '').includes('/');
            let prefixed: string;
            if (line.startsWith('/')) {
                prefixed = `${dirRel}${line}`;
            } else if (hasMidSlash) {
                // path-like pattern → relative to gitignore directory
                prefixed = `${dirRel}/${line}`;
            } else {
                // pure name pattern → recursive within gitignore directory
                prefixed = `${dirRel}/**/${line}`;
            }
            out.push((negated ? '!' : '') + prefixed);
        }
        return out;
    }

    // ---------- Exclusion logic ----------

    public isPathEffectivelyExcluded(fullPath: string): boolean {
        const memo = this.effectiveExcludedMemo.get(fullPath);
        if (memo !== undefined) return memo;
        const res = this.computeEffectiveExcluded(fullPath);
        this.effectiveExcludedMemo.set(fullPath, res);
        return res;
    }

    private computeEffectiveExcluded(fullPath: string): boolean {
        // 1) Manual rules dominate (walk up).
        const manualRule = this.checkManualRule(fullPath);
        if (manualRule !== null) return manualRule;

        // 2) Binary by extension.
        if (this.cfg.excludeBinaryFiles) {
            const ext = path.extname(fullPath).toLowerCase();
            if (ext && this.cfg.binaryExtensions.has(ext)) return true;
        }

        // 3) Auto-ignore (.gitignore + autoExcludePatterns) — relative to root.
        if (this.workspaceRoot) {
            const rel = path.relative(this.workspaceRoot, fullPath);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                const posix = rel.split(path.sep).join('/');
                try {
                    if (this.autoIgnore.ignores(posix)) return true;
                } catch {
                    // bad pattern in ignore — fall through
                }
            }
        }
        return false;
    }

    private checkManualRule(fullPath: string): boolean | null {
        let p = fullPath;
        const root = this.workspaceRoot;
        // walk up to (and including) root
        // false = explicitly included; true = explicitly excluded; null = no rule
        while (true) {
            const pSep = p + path.sep;
            if (this.manualIncludes.has(p) || this.manualIncludes.has(pSep)) return false;
            if (this.manualExcludes.has(p) || this.manualExcludes.has(pSep)) return true;
            const parent = path.dirname(p);
            if (parent === p) return null;
            if (root && !p.startsWith(root)) return null;
            p = parent;
        }
    }

    public isPathVisuallyExcluded(fullPath: string): boolean {
        const effective = this.isPathEffectivelyExcluded(fullPath);
        if (!effective) return false;
        // A folder that's excluded but contains an explicit include/partial is still rendered.
        try {
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) {
                if (this.folderContainsManualIncludes(fullPath)) return false;
                if (this.folderContainsPartialIncludes(fullPath)) return false;
            }
        } catch { /* missing path */ }
        return true;
    }

    // ---------- Index helpers for "any include/partial under this folder?" ----------

    private rebuildIndices() {
        this.sortedIncludes = Array.from(this.manualIncludes).sort();
        this.sortedPartials = Array.from(this.partialIncludes.keys()).sort();
    }

    private prefixExistsInSorted(sorted: string[], prefix: string): boolean {
        if (sorted.length === 0) return false;
        // binary search for the first element >= prefix; check if it starts with prefix
        let lo = 0, hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] < prefix) lo = mid + 1;
            else hi = mid;
        }
        return lo < sorted.length && sorted[lo].startsWith(prefix);
    }

    private folderContainsManualIncludes(dirPath: string): boolean {
        return this.prefixExistsInSorted(this.sortedIncludes, dirPath + path.sep);
    }

    private folderContainsPartialIncludes(dirPath: string): boolean {
        return this.prefixExistsInSorted(this.sortedPartials, dirPath + path.sep);
    }

    private addPathToSet(fullPath: string, set: Set<string>) {
        try {
            const st = fs.statSync(fullPath);
            if (st.isDirectory()) set.add(fullPath + path.sep);
            else set.add(fullPath);
        } catch {
            set.add(fullPath);
        }
    }

    private removePathFromSet(fullPath: string, set: Set<string>) {
        set.delete(fullPath);
        set.delete(fullPath + path.sep);
    }

    // ---------- Refresh / events ----------

    refresh(): void {
        // Don't blow up the *content* caches — they're invalidated by mtime
        // anyway and are the expensive ones. Only drop the per-pass memo.
        this.effectiveExcludedMemo.clear();
        this.selectionStatsCache = null;
        // folder stats are derived from file stats; bump version so consumers
        // re-derive but file content isn't re-read.
        this.cacheVersion++;
        this.folderStatsCache.clear();
        this._onDidChange.fire();
    }

    private debouncedRefresh() {
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => this.refresh(), 250);
    }

    private invalidateAncestorFolderStats(p: string) {
        if (!this.workspaceRoot) return;
        let cur = path.dirname(p);
        const root = this.workspaceRoot;
        while (cur && cur.startsWith(root) && cur !== path.dirname(cur)) {
            this.folderStatsCache.delete(cur);
            cur = path.dirname(cur);
        }
        this.folderStatsCache.delete(root);
    }

    // ---------- Toggle exclude ----------

    toggleExclude(fullPath: string): void {
        let isDir = false;
        try { isDir = fs.statSync(fullPath).isDirectory(); } catch { /* ignore */ }
        const fullPathWithSep = isDir ? fullPath + path.sep : fullPath;
        const isCurrentlyExcluded = this.isPathEffectivelyExcluded(fullPath);

        this.removePathFromSet(fullPath, this.manualIncludes);
        this.removePathFromSet(fullPath, this.manualExcludes);

        if (isCurrentlyExcluded) {
            this.addPathToSet(fullPath, this.manualIncludes);
            if (isDir) {
                for (const p of Array.from(this.manualExcludes)) {
                    if (p.startsWith(fullPathWithSep)) this.manualExcludes.delete(p);
                }
            }
        } else {
            this.addPathToSet(fullPath, this.manualExcludes);
            if (isDir) {
                for (const p of Array.from(this.manualIncludes)) {
                    if (p.startsWith(fullPathWithSep)) this.manualIncludes.delete(p);
                }
            }
        }
        this.saveState();
        this.invalidateAncestorFolderStats(fullPath);
        this.refresh();
    }

    toggleExcludeMultiple(fullPaths: string[]): void {
        const affectedParents = new Set<string>();
        for (const fullPath of fullPaths) {
            try {
                const isDir = fs.statSync(fullPath).isDirectory();
                const fullPathWithSep = isDir ? fullPath + path.sep : fullPath;
                const isCurrentlyExcluded = this.isPathEffectivelyExcluded(fullPath);

                this.removePathFromSet(fullPath, this.manualIncludes);
                this.removePathFromSet(fullPath, this.manualExcludes);

                if (isCurrentlyExcluded) {
                    this.addPathToSet(fullPath, this.manualIncludes);
                    if (isDir) {
                        for (const p of Array.from(this.manualExcludes)) {
                            if (p.startsWith(fullPathWithSep)) this.manualExcludes.delete(p);
                        }
                    }
                } else {
                    this.addPathToSet(fullPath, this.manualExcludes);
                    if (isDir) {
                        for (const p of Array.from(this.manualIncludes)) {
                            if (p.startsWith(fullPathWithSep)) this.manualIncludes.delete(p);
                        }
                    }
                }

                let parent = path.dirname(fullPath);
                while (parent && parent !== this.workspaceRoot && parent !== path.dirname(parent)) {
                    affectedParents.add(parent);
                    parent = path.dirname(parent);
                }
            } catch { /* ignore */ }
        }
        this.saveState();
        for (const parent of affectedParents) this.invalidateAncestorFolderStats(parent);
        this.refresh();
    }

    toggleAll(): void {
        if (!this.workspaceRoot) return;
        const isCurrentlyExcluded = this.isPathEffectivelyExcluded(this.workspaceRoot);
        this.manualIncludes.clear();
        this.manualExcludes.clear();
        if (isCurrentlyExcluded) {
            this.addPathToSet(this.workspaceRoot, this.manualIncludes);
            vscode.window.showInformationMessage('Included all files');
        } else {
            this.addPathToSet(this.workspaceRoot, this.manualExcludes);
            vscode.window.showInformationMessage('Excluded all files');
        }
        this.saveState();
        this.refresh();
    }

    // ---------- Partial selections ----------

    private validateRanges(filePath: string) {
        const ranges = this.partialIncludes.get(filePath);
        if (!ranges || ranges.length === 0) return;
        try {
            if (this.cfg.checkFileSize && fs.statSync(filePath).size > this.cfg.maxFileSize) return;
            const content = fs.readFileSync(filePath, 'utf8');
            const lineCount = content.split('\n').length;
            const validRanges = ranges
                .filter(r => r.start <= lineCount)
                .map(r => ({ start: r.start, end: Math.min(r.end, lineCount) }));
            if (validRanges.length !== ranges.length) {
                if (validRanges.length === 0) this.partialIncludes.delete(filePath);
                else this.partialIncludes.set(filePath, validRanges);
                this.saveState();
            }
        } catch { /* ignore */ }
    }

    addRanges(filePath: string, selections: readonly vscode.Selection[]): void {
        const ranges: Range[] = selections.map(sel => ({
            start: sel.start.line + 1,
            end: sel.end.line + 1,
        }));
        const existing = this.partialIncludes.get(filePath) || [];
        const merged = this.mergeRanges([...existing, ...ranges]);
        this.partialIncludes.set(filePath, merged);
        this.saveState();
        this._onDidUpdateNodes.fire([{
            path: filePath,
            excluded: this.isPathVisuallyExcluded(filePath),
            partial: true,
        }]);
        this._onDidUpdatePartial.fire(filePath);
        this.refresh();
    }

    removeRanges(filePath: string, selections: readonly vscode.Selection[]): void {
        const existing = this.partialIncludes.get(filePath);
        if (!existing || existing.length === 0) return;
        const subs: Range[] = selections.map(sel => ({
            start: sel.start.line + 1,
            end: sel.end.line + 1,
        }));
        let current = existing;
        for (const s of subs) current = current.flatMap(r => this.subtractRange(r, s));
        if (current.length === 0) this.partialIncludes.delete(filePath);
        else this.partialIncludes.set(filePath, current);
        this.saveState();
        this._onDidUpdateNodes.fire([{
            path: filePath,
            excluded: this.isPathVisuallyExcluded(filePath),
            partial: this.hasPartialIncludes(filePath),
        }]);
        this._onDidUpdatePartial.fire(filePath);
        this.refresh();
    }

    clearRanges(filePath: string): void {
        this.partialIncludes.delete(filePath);
        this.saveState();
        this._onDidUpdateNodes.fire([{
            path: filePath,
            excluded: this.isPathVisuallyExcluded(filePath),
            partial: false,
        }]);
        this._onDidUpdatePartial.fire(filePath);
        this.refresh();
    }

    clearAllRanges(): void {
        this.partialIncludes.clear();
        this.saveState();
        this.refresh();
    }

    hasPartialIncludes(filePath: string): boolean {
        return this.partialIncludes.has(filePath);
    }

    getPartialRanges(filePath: string): Range[] | undefined {
        return this.partialIncludes.get(filePath);
    }

    getWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    // ---------- Stats (mtime-keyed cache) ----------

    public getFileStats(fullPath: string): { lines: number; chars: number } {
        try {
            const st = fs.statSync(fullPath);
            const cached = this.fileStatsCache.get(fullPath);
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
                return { lines: cached.lines, chars: cached.chars };
            }

            if (this.cfg.checkFileSize && st.size > this.cfg.maxFileSize) {
                const estimatedLines = Math.ceil(st.size / 40);
                const res = { lines: estimatedLines, chars: st.size };
                this.fileStatsCache.set(fullPath, { ...res, mtimeMs: st.mtimeMs, size: st.size });
                return res;
            }

            // Fast counting without buffering the whole content as string when possible.
            // For files under 256K we still do readFileSync (simpler and fast); large
            // files take the buffer-scan path. CR bytes are not counted so the
            // numbers match the LF-normalized report content (and the saved file).
            let lines = 1;
            let chars = 0;
            if (st.size <= 256 * 1024) {
                const txt = fs.readFileSync(fullPath, 'utf8');
                for (let i = 0; i < txt.length; i++) {
                    const code = txt.charCodeAt(i);
                    if (code === 13) continue; // skip CR
                    chars++;
                    if (code === 10) lines++;
                }
            } else {
                const buf = fs.readFileSync(fullPath);
                for (let i = 0; i < buf.length; i++) {
                    if (buf[i] === 13) continue; // skip CR
                    chars++;
                    if (buf[i] === 10) lines++;
                }
            }

            const res = { lines, chars };
            this.fileStatsCache.set(fullPath, { ...res, mtimeMs: st.mtimeMs, size: st.size });
            return res;
        } catch {
            return { lines: 0, chars: 0 };
        }
    }

    public getFileStatsWithPartial(fullPath: string): { lines: number; chars: number } {
        const ranges = this.partialIncludes.get(fullPath);
        if (!ranges || ranges.length === 0) return this.getFileStats(fullPath);
        try {
            if (this.cfg.checkFileSize && fs.statSync(fullPath).size > this.cfg.maxFileSize) {
                const pLines = ranges.reduce((acc, r) => acc + (r.end - r.start + 1), 0);
                return { lines: pLines, chars: pLines * 40 };
            }
            const content = fs.readFileSync(fullPath, 'utf8').replace(/\r\n?/g, '\n');
            const lines = content.split('\n');
            let pLines = 0, pChars = 0;
            for (const r of this.mergeRanges(ranges)) {
                const start = Math.max(0, r.start - 1);
                const end = Math.min(r.end, lines.length);
                for (let i = start; i < end; i++) {
                    pLines++;
                    pChars += lines[i].length + 1;
                }
            }
            return { lines: pLines, chars: pChars };
        } catch {
            return { lines: 0, chars: 0 };
        }
    }

    /**
     * Folder stats — derived from per-file cached stats. Cached itself with a
     * version counter that's bumped on refresh.
     */
    public getFolderStats(folderPath: string): { lines: number; chars: number; files: number } {
        const cached = this.folderStatsCache.get(folderPath);
        if (cached && cached.version === this.cacheVersion) {
            return { lines: cached.lines, chars: cached.chars, files: cached.files };
        }

        let totalLines = 0, totalChars = 0, filesCount = 0;
        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (!this.isPathVisuallyExcluded(full)) walk(full);
                } else {
                    if (this.isPathEffectivelyExcluded(full)) continue;
                    const stats = this.partialIncludes.has(full)
                        ? this.getFileStatsWithPartial(full)
                        : this.getFileStats(full);
                    totalLines += stats.lines;
                    totalChars += stats.chars;
                    filesCount++;
                }
            }
        };
        walk(folderPath);

        const res = { lines: totalLines, chars: totalChars, files: filesCount };
        this.folderStatsCache.set(folderPath, { ...res, version: this.cacheVersion });
        return res;
    }

    public getSelectionStats(): { lines: number; chars: number; files: number } {
        if (!this.workspaceRoot) return { lines: 0, chars: 0, files: 0 };
        // Activation is asynchronous. Do not start a whole-workspace scan before
        // .gitignore and auto-exclude rules are ready, otherwise the first pass
        // can descend into build/, .git/ and generated trees that should have
        // been pruned.
        if (!this.workspaceReady) return { lines: 0, chars: 0, files: 0 };
        if (this.selectionStatsCache && this.selectionStatsCache.version === this.cacheVersion) {
            return {
                lines: this.selectionStatsCache.lines,
                chars: this.selectionStatsCache.chars,
                files: this.selectionStatsCache.files,
            };
        }

        // Cache miss: kick off an accurate (async) recompute that mirrors the
        // real report, and fire onDidChange when it lands so the status bar
        // refreshes. Meanwhile return the best value we have (last cache or a
        // quick raw estimate) so the UI never blocks.
        this.scheduleSelectionStatsRecompute();

        if (this.selectionStatsCache) {
            return {
                lines: this.selectionStatsCache.lines,
                chars: this.selectionStatsCache.chars,
                files: this.selectionStatsCache.files,
            };
        }
        // Never synchronously walk the entire workspace from a status-bar read.
        // On a large repository that blocks the shared Extension Host and can
        // make every extension appear frozen. The async recompute above will
        // publish the real values when ready.
        return { lines: 0, chars: 0, files: 0 };
    }

    private selectionStatsComputeToken = 0;
    private selectionStatsDebounce: NodeJS.Timeout | undefined;
    private scheduleSelectionStatsRecompute() {
        const token = ++this.selectionStatsComputeToken;
        // Debounce: a burst of refreshes (e.g. toggling several files) should
        // trigger exactly one full recompute, not one per refresh.
        if (this.selectionStatsDebounce) clearTimeout(this.selectionStatsDebounce);
        this.selectionStatsDebounce = setTimeout(() => {
            void this.runSelectionStatsRecompute(token);
        }, 120);
    }

    private async runSelectionStatsRecompute(token: number): Promise<void> {
        if (token !== this.selectionStatsComputeToken) return;

        // Do not allow multiple whole-workspace scans to overlap. During a
        // watcher storm the old implementation could start a second expensive
        // recompute while the first one was still running.
        if (this.selectionStatsComputeRunning) {
            this.selectionStatsRecomputePending = true;
            this.log('[stats] recompute already running; queued one follow-up pass');
            return;
        }

        this.selectionStatsComputeRunning = true;
        this.selectionStatsRecomputePending = false;
        const versionAtStart = this.cacheVersion;
        const startedAt = Date.now();
        this.log(`[stats] recompute start version=${versionAtStart}`);

        try {
            const stats = await this.computeReportStats(() =>
                token !== this.selectionStatsComputeToken || versionAtStart !== this.cacheVersion
            );

            if (!stats) {
                this.log(`[stats] recompute cancelled after ${Date.now() - startedAt}ms`);
                return;
            }
            if (token !== this.selectionStatsComputeToken || versionAtStart !== this.cacheVersion) {
                this.log(`[stats] recompute discarded after ${Date.now() - startedAt}ms (workspace changed)`);
                return;
            }

            this.selectionStatsCache = { ...stats, version: this.cacheVersion };
            this.log(
                `[stats] recompute done in ${Date.now() - startedAt}ms ` +
                `files=${stats.files} lines=${stats.lines} chars=${stats.chars}`
            );
            this._onDidChange.fire();
        } catch (error) {
            this.logError('[stats] recompute failed', error);
        } finally {
            this.selectionStatsComputeRunning = false;
            if (this.selectionStatsRecomputePending) {
                this.selectionStatsRecomputePending = false;
                this.scheduleSelectionStatsRecompute();
            }
        }
    }

    public getStatsForPath(p: string): any {
        const startedAt = Date.now();
        try {
            const st = fs.statSync(p);
            if (st.isDirectory()) {
                const f = this.getFolderStats(p);
                const elapsed = Date.now() - startedAt;
                if (elapsed >= 100) {
                    const rel = this.workspaceRoot ? path.relative(this.workspaceRoot, p) || '.' : p;
                    this.log(`[folder-stats] path=${rel} duration=${elapsed}ms files=${f.files}`);
                }
                return { type: 'dir', lines: f.lines, chars: f.chars, files: f.files };
            }
        } catch { /* fallthrough */ }
        const s = this.hasPartialIncludes(p)
            ? this.getFileStatsWithPartial(p)
            : this.getFileStats(p);
        return { type: 'file', lines: s.lines, chars: s.chars };
    }

    // ---------- Range helpers ----------

    private mergeRanges(ranges: Range[]): Range[] {
        if (ranges.length === 0) return [];
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        const merged: Range[] = [{ ...sorted[0] }];
        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            if (sorted[i].start <= last.end + 1) {
                last.end = Math.max(last.end, sorted[i].end);
            } else {
                merged.push({ ...sorted[i] });
            }
        }
        return merged;
    }

    private subtractRange(r: Range, s: Range): Range[] {
        if (s.end < r.start || s.start > r.end) return [r];
        if (s.start <= r.start && s.end >= r.end) return [];
        if (s.start > r.start && s.end < r.end) {
            return [
                { start: r.start, end: s.start - 1 },
                { start: s.end + 1, end: r.end },
            ];
        }
        if (s.start <= r.start) return [{ start: s.end + 1, end: r.end }];
        return [{ start: r.start, end: s.start - 1 }];
    }

    // ---------- Report generation ----------

    private async getFlatStructure(dirPath: string, structureList: string[]): Promise<void> {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const sorted = entries.sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
        });

        for (const entry of sorted) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                const dirExcluded = this.isPathVisuallyExcluded(fullPath);
                const hasIncludes = this.folderContainsManualIncludes(fullPath);
                const hasPartials = this.folderContainsPartialIncludes(fullPath);

                if (!dirExcluded) {
                    const relDir = path.relative(this.workspaceRoot!, fullPath)
                        .split(path.sep).join(path.posix.sep) + '/';
                    structureList.push(relDir);
                }
                if (!dirExcluded || hasIncludes || hasPartials) {
                    await this.getFlatStructure(fullPath, structureList);
                }
            } else {
                if (this.isPathVisuallyExcluded(fullPath)) continue;
                const relFile = path.relative(this.workspaceRoot!, fullPath)
                    .split(path.sep).join(path.posix.sep);
                structureList.push(relFile);
            }
        }
    }

    private async generateFileContentBlocks(dirPath: string, maxReportSize: number): Promise<string[]> {
        if (this.reportLimitHit) return [];
        const results: string[] = [];
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of sorted) {
            if (this.currentReportSize >= maxReportSize) {
                if (!this.reportLimitHit) {
                    results.push(`\n\n--- REPORT LIMIT REACHED (${(maxReportSize / 1024 / 1024).toFixed(1)} MB) ---\nExecution stopped to prevent VS Code crash.\n`);
                    this.reportLimitHit = true;
                }
                return results;
            }
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                const dirExcluded = this.isPathEffectivelyExcluded(fullPath);
                const hasIncludes = this.folderContainsManualIncludes(fullPath);
                const hasPartials = this.folderContainsPartialIncludes(fullPath);
                if (!dirExcluded || hasIncludes || hasPartials) {
                    const sub = await this.generateFileContentBlocks(fullPath, maxReportSize);
                    results.push(...sub);
                }
            } else {
                if (this.isPathEffectivelyExcluded(fullPath)) continue;
                const contentStr = await this.buildFileReportBlock(fullPath);
                this.currentReportSize += contentStr.length;
                results.push(contentStr);
            }
        }
        return results;
    }

    /**
     * Char/newline contribution of one file's report block, cached by mtime so
     * repeated status-bar recomputes don't re-read unchanged files. Mirrors
     * buildFileReportBlock's output exactly (same wrappers, same trim setting),
     * but only measures it.
     */
    private blockMetricsCache = new Map<string, {
        mtimeMs: number; size: number; sig: string; chars: number; newlines: number;
    }>();

    private async measureFileReportBlock(fullPath: string): Promise<{ chars: number; newlines: number }> {
        const relativePath = path.relative(this.workspaceRoot!, fullPath)
            .split(path.sep).join(path.posix.sep);
        const ranges = this.partialIncludes.get(fullPath);
        // Signature captures everything that affects the block besides content.
        const rangeSig = ranges && ranges.length
            ? ranges.map(r => `${r.start}-${r.end}`).join(',')
            : '';
        const sig = `${relativePath}|${rangeSig}|${this.cfg.trimTrailingWhitespace ? 1 : 0}`;

        let st: fs.Stats;
        try { st = fs.statSync(fullPath); } catch { return { chars: 0, newlines: 0 }; }

        const cached = this.blockMetricsCache.get(fullPath);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.sig === sig) {
            return { chars: cached.chars, newlines: cached.newlines };
        }

        const block = await this.buildFileReportBlock(fullPath);
        const chars = block.length;
        const newlines = this.countNewlines(block);
        this.blockMetricsCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, sig, chars, newlines });
        return { chars, newlines };
    }

    /**
     * Build the exact text block the report emits for one file:
     *   `File: <rel>[ (lines a-b, c-d)]\nContent: <content>\n`
     * Kept in one place so the status-bar size prediction can reuse it and stay
     * byte-for-byte consistent with the generated report.
     */
    private async buildFileReportBlock(fullPath: string): Promise<string> {
        const relativePath = path.relative(this.workspaceRoot!, fullPath)
            .split(path.sep).join(path.posix.sep);
        const ranges = this.partialIncludes.get(fullPath);
        if (ranges && ranges.length > 0) {
            const content = await this.readFileContentWithRanges(fullPath, ranges);
            const rangeDescriptions = ranges.map(r => `${r.start}-${r.end}`).join(', ');
            return `File: ${relativePath} (lines ${rangeDescriptions})\nContent: ${content}\n`;
        }
        const content = await this.readFileContent(fullPath);
        return `File: ${relativePath}\nContent: ${content}\n`;
    }

    private async readFileContentWithRanges(filePath: string, ranges: Range[]): Promise<string> {
        try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            // Normalize first so range math and the output match the LF report.
            const content = raw.replace(/\r\n?/g, '\n');
            const lines = content.split('\n');
            const selected: string[] = [];
            for (const r of this.mergeRanges(ranges)) {
                const start = Math.max(0, r.start - 1);
                const end = Math.min(r.end, lines.length);
                for (let i = start; i < end; i++) selected.push(lines[i]);
            }
            return this.normalizeContent(selected.join('\n'));
        } catch {
            return '[Unable to read file content]';
        }
    }

    /**
     * Normalize line endings to LF and optionally strip trailing whitespace.
     *
     * Normalizing matters because source files on Windows are usually checked
     * out with CRLF, but the report document is saved with LF — so counting the
     * raw `\r` bytes made the status-bar total larger than the saved file. It
     * also broke trailing-whitespace trimming (a `\r` sat between the spaces and
     * the `\n`, so the trim never matched). Converting to LF first fixes both
     * and makes the report identical regardless of the platform it ran on.
     */
    private normalizeContent(text: string): string {
        // CRLF and lone CR → LF.
        const lf = text.replace(/\r\n?/g, '\n');
        if (!this.cfg.trimTrailingWhitespace) return lf;
        return lf.replace(/[ \t]+(?=\n)/g, '').replace(/[ \t]+$/, '');
    }

    /** @deprecated kept as a thin alias; use normalizeContent. */
    private maybeTrim(text: string): string {
        return this.normalizeContent(text);
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            if (this.cfg.excludeBinaryFiles) {
                const ext = path.extname(filePath).toLowerCase();
                if (this.cfg.binaryExtensions.has(ext)) {
                    return '[Binary file, content not displayed]';
                }
            }
            if (this.cfg.checkFileSize) {
                const st = await fs.promises.stat(filePath);
                if (st.size > this.cfg.maxFileSize) {
                    return `[File skipped: Size ${(st.size / 1024).toFixed(1)}KB exceeds limit of ${(this.cfg.maxFileSize / 1024).toFixed(1)}KB]`;
                }
            }
            return this.normalizeContent(await fs.promises.readFile(filePath, 'utf8'));
        } catch {
            return '[Unable to read file content]';
        }
    }

    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) return 'No workspace folder opened';
        this.currentReportSize = 0;
        this.reportLimitHit = false;

        const config = vscode.workspace.getConfiguration('repotxt');
        const maxReportSize = config.get<number>('maxReportSize', 10485760);

        let report = '';
        const useAiStyle = config.get<boolean>('aiStyle', false);
        const workspaceName = path.basename(this.workspaceRoot);
        if (useAiStyle) {
            report += config.get<string>('aiPrompt', '').replace('${workspaceName}', workspaceName) + '\n\n';
        }

        const structureList: string[] = [];
        await this.getFlatStructure(this.workspaceRoot, structureList);
        report += `Folder Structure: ${workspaceName}\n${structureList.join('\n')}\n\n`;
        this.currentReportSize = report.length;

        const fileContents = await this.generateFileContentBlocks(this.workspaceRoot, maxReportSize);
        report += fileContents.join('\n');
        return report;
    }

    /**
     * ZIP report variant. It contains:
     *  - repotxt-report.txt: the same text report generated by generateReport();
     *  - files/: included source files, preserving repository-relative paths.
     *
     * For partial selections we write only the selected text into the archived
     * file. For oversized files that the text report would skip, the ZIP keeps a
     * small placeholder instead of silently packing huge content into memory.
     */
    async generateZipReport(): Promise<Uint8Array> {
        if (!this.workspaceRoot) {
            return this.createZipArchive([{
                name: 'repotxt-report.txt',
                data: Buffer.from('No workspace folder opened', 'utf8'),
            }]);
        }

        const files: Array<{ name: string; data: Uint8Array }> = [];
        const report = await this.generateReport();
        files.push({
            name: 'repotxt-report.txt',
            data: Buffer.from(report, 'utf8'),
        });

        const reportFiles: string[] = [];
        await this.collectReportFiles(this.workspaceRoot, reportFiles);

        for (const fullPath of reportFiles) {
            const relPath = path.relative(this.workspaceRoot, fullPath)
                .split(path.sep).join(path.posix.sep);
            const archivePath = `files/${relPath}`;
            files.push({
                name: archivePath,
                data: await this.readFileForZip(fullPath),
            });
        }

        return this.createZipArchive(files);
    }

    private async readFileForZip(fullPath: string): Promise<Uint8Array> {
        const ranges = this.partialIncludes.get(fullPath);
        if (ranges && ranges.length > 0) {
            const selected = await this.readFileContentWithRanges(fullPath, ranges);
            return Buffer.from(selected, 'utf8');
        }

        try {
            const st = await fs.promises.stat(fullPath);
            if (this.cfg.checkFileSize && st.size > this.cfg.maxFileSize) {
                const message = `[File skipped: Size ${(st.size / 1024).toFixed(1)}KB exceeds limit of ${(this.cfg.maxFileSize / 1024).toFixed(1)}KB]\n`;
                return Buffer.from(message, 'utf8');
            }
            return await fs.promises.readFile(fullPath);
        } catch {
            return Buffer.from('[Unable to read file content]\n', 'utf8');
        }
    }

    /** Minimal ZIP writer (stored entries, no compression, ZIP64 not required). */
    private createZipArchive(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
        const localParts: Buffer[] = [];
        const centralParts: Buffer[] = [];
        let offset = 0;

        for (const entry of entries) {
            const safeName = this.toSafeZipPath(entry.name);
            const nameBytes = Buffer.from(safeName, 'utf8');
            const data = Buffer.from(entry.data);
            const crc = this.crc32(data);
            const { dosTime, dosDate } = this.getDosDateTime(new Date());

            const localHeader = Buffer.alloc(30);
            localHeader.writeUInt32LE(0x04034b50, 0);
            localHeader.writeUInt16LE(20, 4);
            localHeader.writeUInt16LE(0x0800, 6); // UTF-8 file names
            localHeader.writeUInt16LE(0, 8); // store
            localHeader.writeUInt16LE(dosTime, 10);
            localHeader.writeUInt16LE(dosDate, 12);
            localHeader.writeUInt32LE(crc, 14);
            localHeader.writeUInt32LE(data.length, 18);
            localHeader.writeUInt32LE(data.length, 22);
            localHeader.writeUInt16LE(nameBytes.length, 26);
            localHeader.writeUInt16LE(0, 28);

            localParts.push(localHeader, nameBytes, data);

            const centralHeader = Buffer.alloc(46);
            centralHeader.writeUInt32LE(0x02014b50, 0);
            centralHeader.writeUInt16LE(20, 4);
            centralHeader.writeUInt16LE(20, 6);
            centralHeader.writeUInt16LE(0x0800, 8);
            centralHeader.writeUInt16LE(0, 10);
            centralHeader.writeUInt16LE(dosTime, 12);
            centralHeader.writeUInt16LE(dosDate, 14);
            centralHeader.writeUInt32LE(crc, 16);
            centralHeader.writeUInt32LE(data.length, 20);
            centralHeader.writeUInt32LE(data.length, 24);
            centralHeader.writeUInt16LE(nameBytes.length, 28);
            centralHeader.writeUInt16LE(0, 30);
            centralHeader.writeUInt16LE(0, 32);
            centralHeader.writeUInt16LE(0, 34);
            centralHeader.writeUInt16LE(0, 36);
            centralHeader.writeUInt32LE(0, 38);
            centralHeader.writeUInt32LE(offset, 42);
            centralParts.push(centralHeader, nameBytes);

            offset += localHeader.length + nameBytes.length + data.length;
        }

        const centralDirectory = Buffer.concat(centralParts);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(entries.length, 8);
        end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(centralDirectory.length, 12);
        end.writeUInt32LE(offset, 16);
        end.writeUInt16LE(0, 20);

        return Buffer.concat([...localParts, centralDirectory, end]);
    }

    private toSafeZipPath(name: string): string {
        return name
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .split('/')
            .filter(part => part && part !== '.' && part !== '..')
            .join('/');
    }

    private getDosDateTime(date: Date): { dosTime: number; dosDate: number } {
        const year = Math.max(1980, date.getFullYear());
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
        const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        return { dosTime, dosDate };
    }

    private crcTable: Uint32Array | undefined;

    private crc32(data: Uint8Array): number {
        if (!this.crcTable) {
            this.crcTable = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) {
                    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                }
                this.crcTable[i] = c >>> 0;
            }
        }

        let crc = 0xffffffff;
        for (const byte of data) {
            crc = this.crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    // ---------- Report size prediction (for the status bar) ----------

    /**
     * Predict the EXACT dimensions of the report `generateReport` would produce,
     * counted the same way an editor would: `chars` = total string length,
     * `lines` = number of lines (i.e. newlines + 1).
     *
     * This deliberately mirrors `generateReport`'s assembly — the structure
     * header, the per-file `File:/Content:` wrappers, the `\n` join between file
     * blocks, and the AI prompt with `${workspaceName}` substituted — because the
     * old approach (summing raw per-file line/char counts) ignored all of that
     * wrapper text and so never matched the real report.
     */
    private async computeReportStats(
        isCancelled: () => boolean = () => false,
    ): Promise<{ lines: number; chars: number; files: number } | null> {
        if (!this.workspaceRoot) return { lines: 0, chars: 0, files: 0 };

        const config = vscode.workspace.getConfiguration('repotxt');
        const workspaceName = path.basename(this.workspaceRoot);

        let header = '';
        if (config.get<boolean>('aiStyle', false)) {
            header += config.get<string>('aiPrompt', '')
                .replace('${workspaceName}', workspaceName) + '\n\n';
        }
        const structureList: string[] = [];
        const structureStartedAt = Date.now();
        await this.getFlatStructure(this.workspaceRoot, structureList);
        this.log(`[stats] structure scan ${Date.now() - structureStartedAt}ms entries=${structureList.length}`);
        if (isCancelled()) return null;
        header += `Folder Structure: ${workspaceName}\n${structureList.join('\n')}\n\n`;

        // Collect the per-file blocks exactly as the report does, then account
        // for the `\n` that join(...) inserts between them. Per-file metrics are
        // cached by mtime, so repeated recomputes only re-read changed files.
        const fileList: string[] = [];
        const collectStartedAt = Date.now();
        await this.collectReportFiles(this.workspaceRoot, fileList, isCancelled);
        this.log(`[stats] file collection ${Date.now() - collectStartedAt}ms files=${fileList.length}`);
        if (isCancelled()) return null;

        let chars = header.length;
        let newlines = this.countNewlines(header);
        let files = 0;
        const measureStartedAt = Date.now();
        for (let i = 0; i < fileList.length; i++) {
            if (isCancelled()) return null;
            // Even cached files can resolve synchronously. Yield periodically so
            // timers, UI messages and other extensions can keep running.
            if (i > 0 && i % 250 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            const f = fileList[i];
            const m = await this.measureFileReportBlock(f);
            chars += m.chars;
            newlines += m.newlines;
            files++;
        }
        this.log(`[stats] block measurement ${Date.now() - measureStartedAt}ms files=${files}`);
        if (fileList.length > 1) {
            // join('\n') adds (n-1) separators between blocks.
            const seps = fileList.length - 1;
            chars += seps;
            newlines += seps;
        }

        return { lines: newlines + 1, chars, files };
    }

    /** Mirror of generateFileContentBlocks' traversal, collecting file paths only. */
    private async collectReportFiles(
        dirPath: string,
        out: string[],
        isCancelled: () => boolean = () => false,
    ): Promise<void> {
        if (isCancelled()) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dirPath, { withFileTypes: true }); }
        catch { return; }
        const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
            if (isCancelled()) return;
            const fullPath = path.join(dirPath, entry.name);
            // Never traverse or measure symlink targets during background stats.
            // Flutter and generated build trees often contain symlink farms.
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                const dirExcluded = this.isPathEffectivelyExcluded(fullPath);
                const hasIncludes = this.folderContainsManualIncludes(fullPath);
                const hasPartials = this.folderContainsPartialIncludes(fullPath);
                if (!dirExcluded || hasIncludes || hasPartials) {
                    await this.collectReportFiles(fullPath, out, isCancelled);
                }
            } else {
                if (this.isPathEffectivelyExcluded(fullPath)) continue;
                out.push(fullPath);
            }
        }
    }

    private countNewlines(s: string): number {
        let n = 0;
        for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
        return n;
    }

    // ---------- Search (for webview UI) ----------

    /**
     * Recursive name search. Returns up to `limit` paths (relative to root)
     * matching the query. Walks the tree once, skipping excluded folders.
     */
    public async searchFiles(query: string, limit = 200): Promise<{
        relPath: string;
        fullPath: string;
        isDirectory: boolean;
        excluded: boolean;
        partial: boolean;
    }[]> {
        if (!this.workspaceRoot || !query) return [];
        const q = query.toLowerCase();
        const results: any[] = [];
        const root = this.workspaceRoot;

        const walk = async (dir: string) => {
            if (results.length >= limit) return;
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
            catch { return; }
            for (const entry of entries) {
                if (results.length >= limit) return;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // Don't recurse into auto-excluded folders for performance,
                    // unless they contain manual includes.
                    if (this.isPathVisuallyExcluded(full) &&
                        !this.folderContainsManualIncludes(full) &&
                        !this.folderContainsPartialIncludes(full)) {
                        continue;
                    }
                    if (entry.name.toLowerCase().includes(q)) {
                        results.push({
                            relPath: path.relative(root, full).split(path.sep).join('/'),
                            fullPath: full,
                            isDirectory: true,
                            excluded: this.isPathVisuallyExcluded(full),
                            partial: this.folderContainsPartialIncludes(full),
                        });
                    }
                    await walk(full);
                } else {
                    if (entry.name.toLowerCase().includes(q)) {
                        results.push({
                            relPath: path.relative(root, full).split(path.sep).join('/'),
                            fullPath: full,
                            isDirectory: false,
                            excluded: this.isPathVisuallyExcluded(full),
                            partial: this.hasPartialIncludes(full),
                        });
                    }
                }
            }
        };
        await walk(root);
        return results;
    }

    dispose() {
        if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
        if (this.rebuildIgnoreTimeout) clearTimeout(this.rebuildIgnoreTimeout);
        if (this.fileWatcher) this.fileWatcher.dispose();
    }
}
