import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Range = { start: number; end: number };

interface SessionState {
    includes: string[];
    excludes: string[];
    partialIncludes?: { [key: string]: Range[] };
}

export class RepoAnalyzerCore {
    private workspaceRoot: string | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    private autoExcludes: Set<string> = new Set();
    private manualIncludes: Set<string> = new Set();
    private manualExcludes: Set<string> = new Set();
    private partialIncludes: Map<string, Range[]> = new Map();
    private hasIncludesCache: Map<string, boolean> = new Map();

    private readonly sessionStateKey = 'repotxt.sessionState';
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    
    private refreshTimeout: NodeJS.Timeout | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.initialize();
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.initialize());
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt')) {
                this.recalculateAutoExclusions().then(() => this.refresh());
            }
        });
    }

    private async initialize() {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.workspaceRoot = folders[0].uri.fsPath;
            this.loadState();
            await this.recalculateAutoExclusions();
            this.setupFileWatcher();
            this.refresh();
        } else {
            this.workspaceRoot = undefined;
            this.fileWatcher?.dispose();
        }
    }

    private saveState(): void {
        if (this.workspaceRoot) {
            const partialIncludesObj: { [key: string]: Range[] } = {};
            this.partialIncludes.forEach((ranges, path) => {
                partialIncludesObj[path] = ranges;
            });
            this.context.workspaceState.update(this.sessionStateKey, {
                includes: Array.from(this.manualIncludes),
                excludes: Array.from(this.manualExcludes),
                partialIncludes: partialIncludesObj
            });
        }
    }

    private loadState(): void {
        if (this.workspaceRoot) {
            const state = this.context.workspaceState.get<SessionState>(this.sessionStateKey);
            this.manualIncludes = new Set(state?.includes || []);
            this.manualExcludes = new Set(state?.excludes || []);
            this.partialIncludes.clear();
            if (state?.partialIncludes) {
                Object.entries(state.partialIncludes).forEach(([path, ranges]) => {
                    this.partialIncludes.set(path, ranges);
                });
            }
        }
    }

    public async resetExclusions() {
        if (!this.workspaceRoot) return;
        this.manualIncludes.clear();
        this.manualExcludes.clear();
        this.saveState();
        this.refresh();
        vscode.window.showInformationMessage('Manual exclusions have been reset.');
    }

    private async recalculateAutoExclusions() {
        if (!this.workspaceRoot) return;
        this.autoExcludes.clear();
        const config = vscode.workspace.getConfiguration('repotxt');
        const patternsToProcess = new Set<string>();

        if (config.get('autoExcludeEnabled', true)) {
            config.get<string[]>('autoExcludePatterns', []).forEach(p => patternsToProcess.add(p));
        }
        if (config.get('respectIgnoreFiles', true)) {
            const ignoreFileNames = config.get<string[]>('ignoreFileNames', ['.gitignore']);
            for (const fileName of ignoreFileNames) {
                const ignoreFilePath = path.join(this.workspaceRoot, fileName);
                if (fs.existsSync(ignoreFilePath)) {
                    try {
                        fs.readFileSync(ignoreFilePath, 'utf8').split(/\r?\n/).forEach(p => {
                            const trimmed = p.trim();
                            if (trimmed && !trimmed.startsWith('#')) patternsToProcess.add(trimmed);
                        });
                    } catch (e) { console.error(`Error reading ${fileName}`, e); }
                }
            }
        }
        await this.processPatterns(Array.from(patternsToProcess));
        if (config.get('excludeBinaryFiles', true)) {
            const binaryExtensions = config.get<string[]>('binaryFileExtensions', []);
            const globPattern = `**/*.{${binaryExtensions.map(ext => ext.replace(/^\./, '')).join(',')}}`;
            const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
            files.forEach(file => this.addPathToSet(file.fsPath, this.autoExcludes));
        }
    }

    private async processPatterns(patterns: string[]) {
        if (!this.workspaceRoot) return;
        for (const pattern of patterns) {
            try {
                const globPattern = pattern.endsWith('/') ? `${pattern}**` : pattern;
                const matches = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
                matches.forEach(uri => this.addPathToSet(uri.fsPath, this.autoExcludes));
            } catch (error) {/* Ignore */}
            try {
                const directPath = path.join(this.workspaceRoot, pattern.replace(/\/$/, ''));
                if (fs.existsSync(directPath)) this.addPathToSet(directPath, this.autoExcludes);
            } catch (error) {/* Ignore */}
        }
    }

    private setupFileWatcher() {
        if (this.fileWatcher) this.fileWatcher.dispose();
        if (this.workspaceRoot) {
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.workspaceRoot, '**/*'));
            const handleFileChange = (uri: vscode.Uri) => {
                this.validateRanges(uri.fsPath);
                this.debouncedRefresh();
            };
            this.fileWatcher.onDidCreate(() => this.debouncedRefresh());
            this.fileWatcher.onDidDelete(() => this.debouncedRefresh());
            this.fileWatcher.onDidChange(handleFileChange);
        }
    }

    private validateRanges(filePath: string) {
        const ranges = this.partialIncludes.get(filePath);
        if (!ranges || ranges.length === 0) return;
        
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lineCount = content.split('\n').length;
            const validRanges = ranges.filter(r => r.start <= lineCount);
            if (validRanges.length !== ranges.length) {
                this.partialIncludes.set(filePath, validRanges.map(r => ({
                    start: r.start,
                    end: Math.min(r.end, lineCount)
                })));
                this.saveState();
            }
        } catch (e) {}
    }

    private debouncedRefresh() {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        this.refreshTimeout = setTimeout(async () => {
            await this.recalculateAutoExclusions();
            this.refresh();
        }, 300);
    }

    public isPathEffectivelyExcluded(fullPath: string): boolean {
        const check = (p: string): boolean | null => {
            const pWithSep = p + path.sep;
            if (this.manualIncludes.has(p) || this.manualIncludes.has(pWithSep)) return false;
            if (this.manualExcludes.has(p) || this.manualExcludes.has(pWithSep)) return true;
            const parent = path.dirname(p);
            return parent === p ? null : check(parent);
        };
        const manualRule = check(fullPath);
        if (manualRule !== null) return manualRule;

        const autoCheck = (p: string): boolean | null => {
             const pWithSep = p + path.sep;
             if(this.autoExcludes.has(p) || this.autoExcludes.has(pWithSep)) return true;
             const parent = path.dirname(p);
             return parent === p ? null : autoCheck(parent);
        };
        return autoCheck(fullPath) ?? false;
    }

    private addPathToSet(fullPath: string, set: Set<string>) {
        try {
            if (fs.statSync(fullPath).isDirectory()) set.add(fullPath + path.sep);
            else set.add(fullPath);
        } catch (e) {
            set.add(fullPath);
        }
    }

    private removePathFromSet(fullPath: string, set: Set<string>) {
        set.delete(fullPath);
        set.delete(fullPath + path.sep);
    }

    refresh(): void {
        this.hasIncludesCache.clear();
        this._onDidChange.fire();
    }

    toggleExclude(fullPath: string): void {
        const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
        const fullPathWithSep = isDir ? fullPath + path.sep : fullPath;
        const isCurrentlyExcluded = this.isPathEffectivelyExcluded(fullPath);

        this.removePathFromSet(fullPath, this.manualIncludes);
        this.removePathFromSet(fullPath, this.manualExcludes);

        if (isCurrentlyExcluded) {
            this.addPathToSet(fullPath, this.manualIncludes);
            if (isDir) this.manualExcludes.forEach(p => { if (p.startsWith(fullPathWithSep)) this.manualExcludes.delete(p); });
        } else {
            this.addPathToSet(fullPath, this.manualExcludes);
            if (isDir) this.manualIncludes.forEach(p => { if (p.startsWith(fullPathWithSep)) this.manualIncludes.delete(p); });
        }
        this.saveState();
        this.refresh();
    }

    toggleExcludeMultiple(fullPaths: string[]): void {
        fullPaths.forEach(fullPath => {
            const isDir = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
            const fullPathWithSep = isDir ? fullPath + path.sep : fullPath;
            const isCurrentlyExcluded = this.isPathEffectivelyExcluded(fullPath);

            this.removePathFromSet(fullPath, this.manualIncludes);
            this.removePathFromSet(fullPath, this.manualExcludes);

            if (isCurrentlyExcluded) {
                this.addPathToSet(fullPath, this.manualIncludes);
                if (isDir) this.manualExcludes.forEach(p => { if (p.startsWith(fullPathWithSep)) this.manualExcludes.delete(p); });
            } else {
                this.addPathToSet(fullPath, this.manualExcludes);
                if (isDir) this.manualIncludes.forEach(p => { if (p.startsWith(fullPathWithSep)) this.manualIncludes.delete(p); });
            }
        });
        this.saveState();
        this.refresh();
    }

    private folderContainsManualIncludes(dirPath: string): boolean {
        if (this.hasIncludesCache.has(dirPath)) return this.hasIncludesCache.get(dirPath)!;
        const dirPathWithSep = dirPath + path.sep;
        for (const p of this.manualIncludes) {
            if (p.startsWith(dirPathWithSep)) {
                this.hasIncludesCache.set(dirPath, true);
                return true;
            }
        }
        this.hasIncludesCache.set(dirPath, false);
        return false;
    }

    public isPathVisuallyExcluded(fullPath: string): boolean {
        if (this.partialIncludes.has(fullPath)) return false;
        const isEffectivelyExcluded = this.isPathEffectivelyExcluded(fullPath);
        if (!isEffectivelyExcluded) return false;
        try {
            if (fs.statSync(fullPath).isDirectory() && this.folderContainsManualIncludes(fullPath)) {
                return false;
            }
        } catch (e) { /* ignore */ }
        return true;
    }

    private async getFlatStructure(dirPath: string, structureList: string[]): Promise<void> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (this.isPathVisuallyExcluded(fullPath)) continue;

            const relativePath = path.relative(this.workspaceRoot!, fullPath).split(path.sep).join(path.posix.sep);
            structureList.push(relativePath + (entry.isDirectory() ? '/' : ''));

            if (entry.isDirectory()) {
                await this.getFlatStructure(fullPath, structureList);
            }
        }
    }

    private async generateFileContentBlocks(dirPath: string): Promise<string[]> {
        const results: string[] = [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (this.isPathEffectivelyExcluded(fullPath)) continue;

            if (entry.isDirectory()) {
                const subResults = await this.generateFileContentBlocks(fullPath);
                results.push(...subResults);
            } else {
                const relativePath = path.relative(this.workspaceRoot!, fullPath).split(path.sep).join(path.posix.sep);
                const ranges = this.partialIncludes.get(fullPath);
                
                if (ranges && ranges.length > 0) {
                    const content = await this.readFileContentWithRanges(fullPath, ranges);
                    const rangeDescriptions = ranges.map(r => `${r.start}-${r.end}`).join(', ');
                    results.push(`File: ${relativePath} (lines ${rangeDescriptions})\nContent: ${content}\n`);
                } else {
                    const content = await this.readFileContent(fullPath);
                    results.push(`File: ${relativePath}\nContent: ${content}\n`);
                }
            }
        }
        return results;
    }

    private async readFileContentWithRanges(filePath: string, ranges: Range[]): Promise<string> {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const selectedLines: string[] = [];
            
            const mergedRanges = this.mergeRanges(ranges);
            for (const range of mergedRanges) {
                for (let i = range.start - 1; i < Math.min(range.end, lines.length); i++) {
                    if (i >= 0) selectedLines.push(lines[i]);
                }
            }
            
            return selectedLines.join('\n');
        } catch {
            return '[Unable to read file content]';
        }
    }

    private mergeRanges(ranges: Range[]): Range[] {
        if (ranges.length === 0) return [];
        const sorted = [...ranges].sort((a, b) => a.start - b.start);
        const merged: Range[] = [sorted[0]];
        
        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            if (sorted[i].start <= last.end + 1) {
                last.end = Math.max(last.end, sorted[i].end);
            } else {
                merged.push(sorted[i]);
            }
        }
        return merged;
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            const config = vscode.workspace.getConfiguration('repotxt');
            if (config.get<string[]>('binaryFileExtensions', []).includes(path.extname(filePath))) return '[Binary file, content not displayed]';
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '[Unable to read file content]';
        }
    }

    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) return 'No workspace folder opened';
        let report = '';
        const config = vscode.workspace.getConfiguration('repotxt');
        const useAiStyle = config.get('aiStyle', false);
        const workspaceName = path.basename(this.workspaceRoot);
        if (useAiStyle) report += config.get('aiPrompt', '').replace('${workspaceName}', workspaceName) + '\n\n';

        this.hasIncludesCache.clear();

        const structureList: string[] = [];
        await this.getFlatStructure(this.workspaceRoot, structureList);
        const folderStructure = structureList.join('\n');
        report += `Folder Structure: ${workspaceName}\n${folderStructure}\n\n`;

        const fileContents = await this.generateFileContentBlocks(this.workspaceRoot);
        report += fileContents.join('\n');

        return report;
    }

    addRanges(filePath: string, selections: readonly vscode.Selection[]): void {
        const ranges: Range[] = selections.map(sel => ({
            start: sel.start.line + 1,
            end: sel.end.line + 1
        }));
        
        const existingRanges = this.partialIncludes.get(filePath) || [];
        const allRanges = [...existingRanges, ...ranges];
        const mergedRanges = this.mergeRanges(allRanges);
        
        this.partialIncludes.set(filePath, mergedRanges);
        this.saveState();
        this.refresh();
    }

    removeRanges(filePath: string, selections: readonly vscode.Selection[]): void {
        const existingRanges = this.partialIncludes.get(filePath);
        if (!existingRanges || existingRanges.length === 0) return;
        
        const selectionsAsRanges: Range[] = selections.map(sel => ({
            start: sel.start.line + 1,
            end: sel.end.line + 1
        }));
        
        const remainingRanges = existingRanges.filter(existingRange => {
            return !selectionsAsRanges.some(selRange => 
                (existingRange.start >= selRange.start && existingRange.start <= selRange.end) ||
                (existingRange.end >= selRange.start && existingRange.end <= selRange.end) ||
                (existingRange.start <= selRange.start && existingRange.end >= selRange.end)
            );
        });
        
        if (remainingRanges.length === 0) {
            this.partialIncludes.delete(filePath);
        } else {
            this.partialIncludes.set(filePath, remainingRanges);
        }
        
        this.saveState();
        this.refresh();
    }

    clearRanges(filePath: string): void {
        this.partialIncludes.delete(filePath);
        this.saveState();
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

    async getWebviewData(): Promise<any[]> {
        if (!this.workspaceRoot) return [];
        return this.getWebviewFileTree(this.workspaceRoot, 0, 0);
    }

    private async getWebviewFileTree(directoryPath: string, depth: number = 0, maxDepth: number = 0): Promise<any[]> {
        if (depth > maxDepth) return [];
        
        try {
            const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
                .sort((a, b) => {
                    const aIsDir = a.isDirectory() ? 0 : 1;
                    const bIsDir = b.isDirectory() ? 0 : 1;
                    return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
                });

            const result = [];
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                const isExcluded = this.isPathVisuallyExcluded(fullPath);
                const item: any = {
                    name: entry.name,
                    fullPath: fullPath,
                    isDirectory: entry.isDirectory(),
                    excluded: isExcluded,
                    partial: this.hasPartialIncludes(fullPath),
                    children: entry.isDirectory() ? null : []
                };

                result.push(item);
            }
            return result;
        } catch (error) {
            return [];
        }
    }

    async getWebviewChildren(directoryPath: string): Promise<any[]> {
        return this.getWebviewFileTree(directoryPath, 0, 0);
    }

    getWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    dispose() {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
