import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface SessionState {
    includes: string[];
    excludes: string[];
}

export class RepoAnalyzerCore {
    private workspaceRoot: string | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    private autoExcludes: Set<string> = new Set();
    private manualIncludes: Set<string> = new Set();
    private manualExcludes: Set<string> = new Set();
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
            this.context.workspaceState.update(this.sessionStateKey, {
                includes: Array.from(this.manualIncludes),
                excludes: Array.from(this.manualExcludes),
            });
        }
    }

    private loadState(): void {
        if (this.workspaceRoot) {
            const state = this.context.workspaceState.get<SessionState>(this.sessionStateKey);
            this.manualIncludes = new Set(state?.includes || []);
            this.manualExcludes = new Set(state?.excludes || []);
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
            const handleFileChange = () => {
                this.debouncedRefresh();
            };
            this.fileWatcher.onDidCreate(handleFileChange);
            this.fileWatcher.onDidDelete(handleFileChange);
            this.fileWatcher.onDidChange(handleFileChange);
        }
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
            if (this.isPathVisuallyExcluded(fullPath)) continue;

            if (entry.isDirectory()) {
                const subResults = await this.generateFileContentBlocks(fullPath);
                results.push(...subResults);
            } else {
                const relativePath = path.relative(this.workspaceRoot!, fullPath).split(path.sep).join(path.posix.sep);
                const content = await this.readFileContent(fullPath);
                results.push(`File: ${relativePath}\nContent: ${content}\n`);
            }
        }
        return results;
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
