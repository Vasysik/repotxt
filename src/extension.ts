import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface FileTreeItem extends vscode.TreeItem {
    children?: FileTreeItem[];
    fullPath: string;
    excluded: boolean;
}

interface ExclusionSettings {
    autoExcludePatterns: string[];
    respectIgnoreFiles: boolean;
    ignoreFileNames: string[];
    autoExcludeEnabled: boolean;
    excludeBinaryFiles: boolean;
    binaryFileExtensions: string[];
}

class RepoAnalyzerProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private excludedPaths: Set<string> = new Set();
    private workspaceRoot: string | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private readonly exclusionStateKey = 'repotxt.excludedPaths';

    constructor(private context: vscode.ExtensionContext) {
        this.updateWorkspaceRoot().then(() => {
            this.refresh();
        });
        
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.updateWorkspaceRoot().then(() => {
                this.refresh();
            });
        });

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt')) {
                this.initializeExclusions().then(() => { 
                    this.refresh();
                });
            }
        });
    }

    private async updateWorkspaceRoot() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            this.setupFileWatcher();
            await this.initializeExclusions();
        } else {
            this.workspaceRoot = undefined;
            this.fileWatcher?.dispose();
        }
    }

    private saveState(): void {
        if (this.workspaceRoot) {
            const excludedPathsArray = Array.from(this.excludedPaths);
            this.context.workspaceState.update(this.exclusionStateKey, excludedPathsArray);
        }
    }

    private loadState(): void {
        if (this.workspaceRoot) {
            const excludedPathsArray = this.context.workspaceState.get<string[]>(this.exclusionStateKey, []);
            this.excludedPaths = new Set(excludedPathsArray);
        }
    }

    private async checkForAutoExclusion(filePath: string) {
        // This function is now mainly for on-the-fly creation, 
        // the main logic is in initializeExclusions
        const config = vscode.workspace.getConfiguration('repotxt');
        const autoExcludeEnabled = config.get('autoExcludeEnabled', true);
        if (!autoExcludeEnabled) return;

        const patterns = config.get<string[]>('autoExcludePatterns', []);
        const fileName = path.basename(filePath);
        const relativePath = this.workspaceRoot ? path.relative(this.workspaceRoot, filePath) : '';

        const shouldExclude = patterns.some(pattern => {
            if (pattern === fileName || pattern === relativePath) return true;
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                return regex.test(fileName) || regex.test(relativePath);
            }
            return false;
        });

        if (shouldExclude) {
            this.excludedPaths.add(filePath);
            if (fs.statSync(filePath).isDirectory()) {
                this.excludeDirectory(filePath);
            }
            this.saveState();
        }
    }

    private async initializeExclusions() {
        if (!this.workspaceRoot) return;

        this.loadState(); // Load saved user exclusions first

        const config = vscode.workspace.getConfiguration('repotxt');
        const settings: ExclusionSettings = {
            autoExcludeEnabled: config.get('autoExcludeEnabled', true),
            autoExcludePatterns: config.get('autoExcludePatterns', []),
            respectIgnoreFiles: config.get('respectIgnoreFiles', true),
            ignoreFileNames: config.get('ignoreFileNames', ['.gitignore']),
            excludeBinaryFiles: config.get('excludeBinaryFiles', true),
            binaryFileExtensions: config.get('binaryFileExtensions', [])
        };

        if (settings.autoExcludeEnabled && settings.autoExcludePatterns.length > 0) {
            await this.processExcludePatterns(settings.autoExcludePatterns);
        }

        if (settings.respectIgnoreFiles) {
            await this.processIgnoreFiles(settings.ignoreFileNames);
        }

        if (settings.excludeBinaryFiles) {
            await this.processBinaryExclusions(settings.binaryFileExtensions);
        }

        this.saveState(); // Save the combined state of automatic and manual exclusions
    }
    
    private async processBinaryExclusions(extensions: string[]) {
        if (!this.workspaceRoot || extensions.length === 0) return;

        const globExtensions = extensions.map(ext => ext.startsWith('.') ? ext.substring(1) : ext);
        const globPattern = `**/*.{${globExtensions.join(',')}}`;

        const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
        for (const file of files) {
            this.excludedPaths.add(file.fsPath);
        }
    }

    private async processIgnoreFiles(fileNames: string[]) {
        if (!this.workspaceRoot) return;

        for (const fileName of fileNames) {
            const ignoreFilePath = path.join(this.workspaceRoot, fileName);
            if (!fs.existsSync(ignoreFilePath)) continue;

            try {
                const fileStream = fs.createReadStream(ignoreFilePath);
                const rl = readline.createInterface({
                    input: fileStream,
                    crlfDelay: Infinity
                });

                const patterns: string[] = [];
                for await (const line of rl) {
                    if (line && !line.startsWith('#') && line.trim()) {
                        patterns.push(line.trim());
                    }
                }
                await this.processExcludePatterns(patterns);
            } catch (error) {
                console.error(`Error processing ${fileName}:`, error);
            }
        }
    }

    private async processExcludePatterns(patterns: string[]) {
        if (!this.workspaceRoot) return;

        for (const pattern of patterns) {
            if (!pattern) continue;
            try {
                const matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
                matches.forEach(uri => {
                    this.excludedPaths.add(uri.fsPath);
                });
            } catch (error) {
                console.error(`Error processing pattern ${pattern}:`, error);
            }
        }
    }

	private setupFileWatcher() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }

        if (this.workspaceRoot) {
            this.fileWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceRoot, '**/*')
            );

            this.fileWatcher.onDidCreate(async (uri) => {
                await this.checkForAutoExclusion(uri.fsPath);
                this.refresh();
            });
            this.fileWatcher.onDidDelete(() => this.refresh());
        }
    }

	private isPathExcluded(fullPath: string): boolean {
        if (this.excludedPaths.has(fullPath)) {
            return true;
        }
        for (const excludedPath of this.excludedPaths) {
            if (fs.existsSync(excludedPath) && fs.statSync(excludedPath).isDirectory()) {
                if (fullPath.startsWith(excludedPath + path.sep)) {
                    return true;
                }
            }
        }
        return false;
    }

	private excludeDirectory(dirPath: string): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                this.excludedPaths.add(fullPath);
                if (entry.isDirectory()) {
                    this.excludeDirectory(fullPath);
                }
            }
        } catch (error) {
            // Ignore errors for directories that might not exist or are inaccessible
        }
    }

	private includeDirectory(dirPath: string): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                this.excludedPaths.delete(fullPath);
                if (entry.isDirectory()) {
                    this.includeDirectory(fullPath);
                }
            }
        } catch (error) {
            // Ignore errors
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const isExcluded = this.isPathExcluded(element.fullPath);
        element.collapsibleState = (element.collapsibleState === vscode.TreeItemCollapsibleState.None || isExcluded)
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed;

        const treeItem = new vscode.TreeItem(element.label as string, element.collapsibleState);
        treeItem.contextValue = isExcluded ? 'excluded' : 'included';
        
        if (isExcluded) {
            treeItem.iconPath = new vscode.ThemeIcon('eye-closed');
            treeItem.description = '(excluded)';
            treeItem.tooltip = 'Excluded from report';
        } else {
            treeItem.iconPath = element.collapsibleState === vscode.TreeItemCollapsibleState.None ?
                new vscode.ThemeIcon('file') :
                new vscode.ThemeIcon('folder');
        }

        if (element.collapsibleState === vscode.TreeItemCollapsibleState.None && !isExcluded) {
            treeItem.command = {
                command: 'vscode.open',
                arguments: [vscode.Uri.file(element.fullPath)],
                title: 'Open File'
            };
        }
        return treeItem;
    }

    getChildren(element?: FileTreeItem): Thenable<FileTreeItem[]> {
        if (!this.workspaceRoot) {
            vscode.window.showInformationMessage('Open a folder or workspace to analyze.');
            return Promise.resolve([]);
        }

        const directoryPath = element ? element.fullPath : this.workspaceRoot;
        if (element && this.isPathExcluded(element.fullPath)) {
            return Promise.resolve([]);
        }
        return Promise.resolve(this.getFileTree(directoryPath));
    }

    private getFileTree(directoryPath: string): FileTreeItem[] {
        const items: FileTreeItem[] = [];
        try {
            const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
                .map(entry => {
                    const fullPath = path.join(directoryPath, entry.name);
                    return { entry, fullPath, isExcluded: this.isPathExcluded(fullPath) };
                })
                .filter(({ isExcluded }) => !isExcluded) // Initially filter out excluded items
                .sort((a, b) => {
                    // Sort folders before files, then alphabetically
                    const aIsDir = a.entry.isDirectory() ? 0 : 1;
                    const bIsDir = b.entry.isDirectory() ? 0 : 1;
                    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
                    return a.entry.name.localeCompare(b.entry.name);
                });
            
            for (const { entry, fullPath, isExcluded } of entries) {
                items.push({
                    label: entry.name,
                    fullPath: fullPath,
                    excluded: isExcluded,
                    collapsibleState: entry.isDirectory() 
                        ? vscode.TreeItemCollapsibleState.Collapsed 
                        : vscode.TreeItemCollapsibleState.None
                });
            }
        } catch (error) {
            console.error('Error reading directory:', error);
        }
        return items;
    }

    toggleExclude(item: FileTreeItem): void {
        const isCurrentlyExcluded = this.isPathExcluded(item.fullPath);
    
        if (isCurrentlyExcluded) {
            this.excludedPaths.delete(item.fullPath);
            if (fs.statSync(item.fullPath).isDirectory()) {
                this.includeDirectory(item.fullPath);
            }
        } else {
            this.excludedPaths.add(item.fullPath);
            if (fs.statSync(item.fullPath).isDirectory()) {
                this.excludeDirectory(item.fullPath);
            }
        }
        this.saveState();
        this.refresh();
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            const config = vscode.workspace.getConfiguration('repotxt');
            const binaryExtensions = config.get<string[]>('binaryFileExtensions', []);
            const fileExt = path.extname(filePath);

            if (binaryExtensions.includes(fileExt)) {
                return '[Binary file, content not displayed]';
            }
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '[Unable to read file content]';
        }
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
                const posixPath = relativePath.split(path.sep).join(path.posix.sep); // Ensure posix paths in report
                structure.push(`--- START OF FILE ${posixPath} ---\n\n${content}\n\n--- END OF FILE ${posixPath} ---`);
            }
        }
        return structure;
    }

    private async generateFolderStructure(dirPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .sort((a, b) => {
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
                if (entry.isDirectory()) {
                    result += await this.generateFolderStructure(fullPath, prefix + '  ');
                }
            }
        }
        return result;
    }

    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) {
            return 'No workspace folder opened';
        }
    
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
    
    vscode.window.createTreeView('repotxt', {
        treeDataProvider: repoAnalyzerProvider,
        showCollapseAll: true
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.refresh', () => {
            repoAnalyzerProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.toggleExclude', (item: FileTreeItem) => {
            repoAnalyzerProvider.toggleExclude(item);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.generateReport', async () => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Generating Repository Report...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0 });
                const report = await repoAnalyzerProvider.generateReport();
                
                const document = await vscode.workspace.openTextDocument({
                    content: report,
                    language: 'markdown'
                });
                
                await vscode.window.showTextDocument(document, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.Beside
                });
                progress.report({ increment: 100 });
            });
        })
    );
}

export function deactivate() {}
