import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface FileTreeItem extends vscode.TreeItem {
    children?: FileTreeItem[];
    fullPath: string;
    excluded: boolean;
}

interface SessionState {
    includes: string[];
    excludes: string[];
}

class RepoAnalyzerProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private workspaceRoot: string | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;

    private autoExcludes: Set<string> = new Set();
    private manualIncludes: Set<string> = new Set();
    private manualExcludes: Set<string> = new Set();
    private hasIncludesCache: Map<string, boolean> = new Map();

    private readonly sessionStateKey = 'repotxt.sessionState';

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
            const handleFileChange = async () => {
                await this.recalculateAutoExclusions();
                this.refresh();
            };
            this.fileWatcher.onDidCreate(handleFileChange);
            this.fileWatcher.onDidDelete(handleFileChange);
            this.fileWatcher.onDidChange(handleFileChange);
        }
    }

    private isPathEffectivelyExcluded(fullPath: string): boolean {
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
        } catch (e) { set.add(fullPath); }
    }

    private removePathFromSet(fullPath: string, set: Set<string>) {
        set.delete(fullPath);
        set.delete(fullPath + path.sep);
    }
    
    refresh(): void {
        this.hasIncludesCache.clear();
        this._onDidChangeTreeData.fire();
    }

    toggleExclude(item: FileTreeItem): void {
        const { fullPath } = item;
        const isDir = fs.statSync(fullPath).isDirectory();
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
    
    private isPathVisuallyExcluded(fullPath: string): boolean {
        const isEffectivelyExcluded = this.isPathEffectivelyExcluded(fullPath);
        if (!isEffectivelyExcluded) return false;

        try {
            if (fs.statSync(fullPath).isDirectory()) {
                if (this.folderContainsManualIncludes(fullPath)) return false;
            }
        } catch (e) { /* ignore */ }
        
        return true;
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const isVisuallyExcluded = this.isPathVisuallyExcluded(element.fullPath);
        const isDirectory = fs.existsSync(element.fullPath) && fs.statSync(element.fullPath).isDirectory();
        const collapsibleState = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;

        const treeItem = new vscode.TreeItem(element.label as string, collapsibleState);
        treeItem.contextValue = this.isPathEffectivelyExcluded(element.fullPath) ? 'excluded' : 'included';

        if (isVisuallyExcluded) {
            treeItem.iconPath = new vscode.ThemeIcon('eye-closed');
            treeItem.description = '(excluded)';
            treeItem.tooltip = 'Excluded from report';
        } else {
            treeItem.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
            treeItem.command = isDirectory ? undefined : {
                command: 'vscode.open',
                arguments: [vscode.Uri.file(element.fullPath)],
                title: 'Open File'
            };
        }
        return treeItem;
    }

    getChildren(element?: FileTreeItem): Thenable<FileTreeItem[]> {
        if (!this.workspaceRoot) return Promise.resolve([]);
        const directoryPath = element ? element.fullPath : this.workspaceRoot;
        return Promise.resolve(this.getFileTree(directoryPath));
    }

    private getFileTree(directoryPath: string): FileTreeItem[] {
        try {
            return fs.readdirSync(directoryPath, { withFileTypes: true })
                .sort((a, b) => {
                    const aIsDir = a.isDirectory() ? 0 : 1;
                    const bIsDir = b.isDirectory() ? 0 : 1;
                    return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
                })
                .map(entry => ({
                    label: entry.name,
                    fullPath: path.join(directoryPath, entry.name),
                    excluded: false,
                    collapsibleState: entry.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                }));
        } catch (error) { return []; }
    }

    private async buildReportStructure(dirPath: string, structure: string[] = []): Promise<string[]> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                await this.buildReportStructure(fullPath, structure);
            } else if (!this.isPathEffectivelyExcluded(fullPath)) {
                const content = await this.readFileContent(fullPath);
                const posixPath = path.relative(this.workspaceRoot!, fullPath).split(path.sep).join(path.posix.sep);
                structure.push(`--- START OF FILE ${posixPath} ---\n\n${content}\n\n--- END OF FILE ${posixPath} ---`);
            }
        }
        return structure;
    }

    private async generateFolderStructure(dirPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
        });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (!this.isPathVisuallyExcluded(fullPath)) {
                const posixName = entry.name.split(path.sep).join(path.posix.sep);
                result += `${prefix}${posixName}${entry.isDirectory() ? '/' : ''}\n`;
                if (entry.isDirectory()) {
                    result += await this.generateFolderStructure(fullPath, prefix + '  ');
                }
            }
        }
        return result;
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            const config = vscode.workspace.getConfiguration('repotxt');
            if (config.get<string[]>('binaryFileExtensions', []).includes(path.extname(filePath))) return '[Binary file, content not displayed]';
            return fs.readFileSync(filePath, 'utf8');
        } catch { return '[Unable to read file content]'; }
    }
    
    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) return 'No workspace folder opened';
        let report = '';
        const config = vscode.workspace.getConfiguration('repotxt');
        const useAiStyle = config.get('aiStyle', false);
        const workspaceName = path.basename(this.workspaceRoot);
        if (useAiStyle) report += config.get('aiPrompt', '').replace('${workspaceName}', workspaceName) + '\n\n';
        
        this.hasIncludesCache.clear();
        
        const folderStructure = await this.generateFolderStructure(this.workspaceRoot);
        report += `Folder Structure: ${workspaceName}\n${folderStructure}\n`;
        const fileContents = await this.buildReportStructure(this.workspaceRoot);
        report += fileContents.join('\n\n');
        return report;
    }
}

export function activate(context: vscode.ExtensionContext) {
    const repoAnalyzerProvider = new RepoAnalyzerProvider(context);
    vscode.window.createTreeView('repotxt', { treeDataProvider: repoAnalyzerProvider, showCollapseAll: true });
    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.refresh', () => repoAnalyzerProvider.refresh()),
        vscode.commands.registerCommand('repotxt.toggleExclude', (item: FileTreeItem) => repoAnalyzerProvider.toggleExclude(item)),
        vscode.commands.registerCommand('repotxt.resetExclusions', () => repoAnalyzerProvider.resetExclusions()),
        vscode.commands.registerCommand('repotxt.generateReport', async () => {
            vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Generating Repository Report...", cancellable: false }, async (progress) => {
                progress.report({ increment: 0 });
                const report = await repoAnalyzerProvider.generateReport();
                const document = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
                await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                progress.report({ increment: 100 });
            });
        })
    );
}

export function deactivate() {}
