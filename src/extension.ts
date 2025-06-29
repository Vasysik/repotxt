import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

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

    private readonly sessionStateKey = 'repotxt.sessionState';

    constructor(private context: vscode.ExtensionContext) {
        this.updateWorkspaceRoot();
        
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateWorkspaceRoot());
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt')) {
                this.recalculateAutoExclusions().then(() => this.refresh());
            }
        });
    }

    private async updateWorkspaceRoot() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
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
            const state: SessionState = {
                includes: Array.from(this.manualIncludes),
                excludes: Array.from(this.manualExcludes),
            };
            this.context.workspaceState.update(this.sessionStateKey, state);
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
        this.saveState(); // Save the cleared state
        this.refresh();
        vscode.window.showInformationMessage('Manual exclusions have been reset.');
    }

    private async recalculateAutoExclusions() {
        this.autoExcludes.clear();
        if (!this.workspaceRoot) return;

        const config = vscode.workspace.getConfiguration('repotxt');
        
        const autoExcludePatterns = config.get<string[]>('autoExcludePatterns', []);
        if (config.get('autoExcludeEnabled', true) && autoExcludePatterns.length > 0) {
            await this.processPatterns(autoExcludePatterns, this.autoExcludes);
        }

        const ignoreFileNames = config.get<string[]>('ignoreFileNames', ['.gitignore']);
        if (config.get('respectIgnoreFiles', true)) {
            await this.processIgnoreFiles(ignoreFileNames);
        }

        const binaryExtensions = config.get<string[]>('binaryFileExtensions', []);
        if (config.get('excludeBinaryFiles', true) && binaryExtensions.length > 0) {
            await this.processBinaryExclusions(binaryExtensions);
        }
    }
    
    private async processBinaryExclusions(extensions: string[]) {
        if (!this.workspaceRoot) return;
        const globExtensions = extensions.map(ext => ext.startsWith('.') ? ext.substring(1) : ext);
        const globPattern = `**/*.{${globExtensions.join(',')}}`;
        const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
        files.forEach(file => this.autoExcludes.add(file.fsPath));
    }

    private async processIgnoreFiles(fileNames: string[]) {
        if (!this.workspaceRoot) return;
        for (const fileName of fileNames) {
            const ignoreFilePath = path.join(this.workspaceRoot, fileName);
            if (!fs.existsSync(ignoreFilePath)) continue;
            try {
                const fileStream = fs.createReadStream(ignoreFilePath);
                const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
                const patterns: string[] = [];
                for await (const line of rl) {
                    const trimmedLine = line.trim();
                    if (trimmedLine && !trimmedLine.startsWith('#')) patterns.push(trimmedLine);
                }
                await this.processPatterns(patterns, this.autoExcludes);
            } catch (error) { console.error(`Error processing ${fileName}:`, error); }
        }
    }
    
    private async processPatterns(patterns: string[], targetSet: Set<string>) {
        if (!this.workspaceRoot) return;
        for (const pattern of patterns) {
            if (!pattern) continue;
            try {
                let globPattern = pattern;
                if (globPattern.endsWith('/')) globPattern += '**';
                const matches = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
                matches.forEach(uri => targetSet.add(uri.fsPath));
            } catch (error) {/* Ignore invalid glob */}
            try {
                const directPath = path.join(this.workspaceRoot, pattern.replace(/\/$/, ''));
                if (fs.existsSync(directPath)) targetSet.add(directPath);
            } catch (error) { console.error(`Error checking direct path ${pattern}:`, error); }
        }
    }

	private setupFileWatcher() {
        if (this.fileWatcher) this.fileWatcher.dispose();
        if (this.workspaceRoot) {
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.workspaceRoot, '**/*'));
            this.fileWatcher.onDidCreate(() => this.refresh());
            this.fileWatcher.onDidDelete(() => this.refresh());
        }
    }

    private isPathExcluded(fullPath: string): boolean {
        if (this.isPathInSet(fullPath, this.manualIncludes)) return false;
        if (this.isPathInSet(fullPath, this.manualExcludes)) return true;
        if (this.isPathInSet(fullPath, this.autoExcludes)) return true;
        return false;
    }

    private isPathInSet(fullPath: string, set: Set<string>): boolean {
        if (set.has(fullPath)) return true;
        for (const item of set) {
            if (fs.existsSync(item) && fs.statSync(item).isDirectory()) {
                if (fullPath.startsWith(item + path.sep)) return true;
            }
        }
        return false;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    toggleExclude(item: FileTreeItem): void {
        const isCurrentlyExcluded = this.isPathExcluded(item.fullPath);

        this.manualIncludes.delete(item.fullPath);
        this.manualExcludes.delete(item.fullPath);

        if (isCurrentlyExcluded) {
            this.manualIncludes.add(item.fullPath);
        } else {
            this.manualExcludes.add(item.fullPath);
        }

        this.saveState();
        this.refresh();
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const isExcluded = this.isPathExcluded(element.fullPath);
        const isDirectory = fs.existsSync(element.fullPath) && fs.statSync(element.fullPath).isDirectory();

        const collapsibleState = (isDirectory && !isExcluded)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const treeItem = new vscode.TreeItem(element.label as string, collapsibleState);
        treeItem.contextValue = isExcluded ? 'excluded' : 'included';
        
        if (isExcluded) {
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
        if (element && this.isPathExcluded(element.fullPath)) return Promise.resolve([]);
        
        const directoryPath = element ? element.fullPath : this.workspaceRoot;
        return Promise.resolve(this.getFileTree(directoryPath));
    }

    private getFileTree(directoryPath: string): FileTreeItem[] {
        const items: FileTreeItem[] = [];
        try {
            const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
            entries.sort((a, b) => {
                const aIsDir = a.isDirectory() ? 0 : 1;
                const bIsDir = b.isDirectory() ? 0 : 1;
                if (aIsDir !== bIsDir) return aIsDir - bIsDir;
                return a.name.localeCompare(b.name);
            });
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                items.push({
                    label: entry.name,
                    fullPath: fullPath,
                    excluded: this.isPathExcluded(fullPath),
                    collapsibleState: entry.isDirectory() 
                        ? vscode.TreeItemCollapsibleState.Collapsed 
                        : vscode.TreeItemCollapsibleState.None
                });
            }
        } catch (error) { console.error('Error reading directory:', error); }
        return items;
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            const config = vscode.workspace.getConfiguration('repotxt');
            const binaryExtensions = config.get<string[]>('binaryFileExtensions', []);
            if (binaryExtensions.includes(path.extname(filePath))) return '[Binary file, content not displayed]';
            return fs.readFileSync(filePath, 'utf8');
        } catch { return '[Unable to read file content]'; }
    }

    private async buildReportStructure(dirPath: string, structure: string[] = []): Promise<string[]> {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (this.isPathExcluded(fullPath)) continue;
            const relativePath = path.relative(this.workspaceRoot!, fullPath);
            if (entry.isDirectory()) {
                await this.buildReportStructure(fullPath, structure);
            } else {
                const content = await this.readFileContent(fullPath);
                const posixPath = relativePath.split(path.sep).join(path.posix.sep);
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
            if (aIsDir !== bIsDir) return aIsDir - bIsDir;
            return a.name.localeCompare(b.name);
        });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (!this.isPathExcluded(fullPath)) {
                const posixName = entry.name.split(path.sep).join(path.posix.sep);
                result += `${prefix}${posixName}${entry.isDirectory() ? '/' : ''}\n`;
                if (entry.isDirectory()) result += await this.generateFolderStructure(fullPath, prefix + '  ');
            }
        }
        return result;
    }

    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) return 'No workspace folder opened';
        let report = '';
        const config = vscode.workspace.getConfiguration('repotxt');
        const useAiStyle = config.get('aiStyle', false);
        const workspaceName = path.basename(this.workspaceRoot);
        if (useAiStyle) {
            const aiPrompt = config.get('aiPrompt', '');
            report += aiPrompt.replace('${workspaceName}', workspaceName) + '\n\n';
        }
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
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Generating Repository Report...",
                cancellable: false
            }, async (progress) => {
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
