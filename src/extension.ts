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
    respectGitignore: boolean;
    autoExcludeEnabled: boolean;
}

class RepoAnalyzerProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private excludedPaths: Set<string> = new Set();
    private workspaceRoot: string | undefined;
    private _useAIStyle: boolean = false;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private gitignorePatterns: string[] = [];

    constructor(context: vscode.ExtensionContext) {
        if (vscode.workspace.workspaceFolders) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            this.setupFileWatcher();
            this.initializeExclusions().then(() => { this.refresh(); });
        }
        
        this._useAIStyle = context.globalState.get('repotxt.useAIStyle', false);
        
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (vscode.workspace.workspaceFolders) {
                this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                this.setupFileWatcher();
                this.initializeExclusions().then(() => { this.refresh(); });
            }
        });

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt')) {
                this.initializeExclusions().then(() => { this.refresh(); });
            }
        });
    }

    private async checkForAutoExclusion(filePath: string) {
        const config = vscode.workspace.getConfiguration('repotxt');
        const autoExcludeEnabled = config.get('autoExcludeEnabled', true);
        
        if (!autoExcludeEnabled) {
            return;
        }

        const patterns = config.get<string[]>('autoExcludePatterns', []);
        const fileName = path.basename(filePath);
        const relativePath = path.relative(this.workspaceRoot!, filePath);

        const shouldExclude = patterns.some(pattern => {
            if (pattern === fileName || pattern === relativePath) {
                return true;
            }
            
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
        }
    }

    private async initializeExclusions() {
        if (!this.workspaceRoot) return;

        const config = vscode.workspace.getConfiguration('repotxt');
        const settings: ExclusionSettings = {
            autoExcludeEnabled: config.get('autoExcludeEnabled', true),
            autoExcludePatterns: config.get('autoExcludePatterns', [
                'node_modules',
                '.git',
                'dist',
                'build',
                'out',
                'coverage',
                '.env',
                '*.log',
                'package-lock.json',
                'yarn.lock'
            ]),
            respectGitignore: config.get('respectGitignore', true)
        };

        this.excludedPaths.clear();

        if (!settings.autoExcludeEnabled) {
            return;
        }

        if (settings.autoExcludePatterns.length > 0) {
            await this.processExcludePatterns(settings.autoExcludePatterns);
        }

        if (settings.respectGitignore) {
            await this.processGitignore();
        }
    }

    private async processGitignore() {
        if (!this.workspaceRoot) return;

        const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
        if (!fs.existsSync(gitignorePath)) return;

        try {
            const fileStream = fs.createReadStream(gitignorePath);
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            this.gitignorePatterns = [];
            for await (const line of rl) {
                if (line && !line.startsWith('#') && line.trim()) {
                    this.gitignorePatterns.push(line.trim());
                }
            }

            await this.processExcludePatterns(this.gitignorePatterns);
        } catch (error) {
            console.error('Error processing .gitignore:', error);
        }
    }

    private async processExcludePatterns(patterns: string[]) {
        if (!this.workspaceRoot) return;

        for (const pattern of patterns) {
            const fullPattern = path.join(this.workspaceRoot, pattern);
            
            try {
                // Handle glob patterns
                const matches = await vscode.workspace.findFiles(pattern);
                matches.forEach(uri => {
                    this.excludedPaths.add(uri.fsPath);
                });
                
                // Handle direct paths
                if (fs.existsSync(fullPattern)) {
                    this.excludedPaths.add(fullPattern);
                    if (fs.statSync(fullPattern).isDirectory()) {
                        this.excludeDirectory(fullPattern);
                    }
                }
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
            this.fileWatcher.onDidChange(() => this.refresh());
        }
    }

	private isPathExcluded(fullPath: string): boolean {
        if (this.excludedPaths.has(fullPath)) {
            return true;
        }

        for (const excludedPath of this.excludedPaths) {
            if (fullPath.startsWith(excludedPath + path.sep)) {
                return true;
            }
        }

        return false;
    }

	private excludeDirectory(dirPath: string): void {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                this.excludeDirectory(fullPath);
            }
            this.excludedPaths.add(fullPath);
        }
    }

	private includeDirectory(dirPath: string): void {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (entry.isDirectory()) {
                this.includeDirectory(fullPath);
            }
            this.excludedPaths.delete(fullPath);
        }
    }

    get useAIStyle(): boolean {
        return this._useAIStyle;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label as string,
            element.collapsibleState
        );
        
        const isExcluded = this.isPathExcluded(element.fullPath);
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
                
        return treeItem;
    }

    getChildren(element?: FileTreeItem): Thenable<FileTreeItem[]> {
        if (!this.workspaceRoot) {
            return Promise.resolve([]);
        }

        const directoryPath = element ? element.fullPath : this.workspaceRoot;
        return Promise.resolve(this.getFileTree(directoryPath));
    }

    private getFileTree(directoryPath: string): FileTreeItem[] {
        const items: FileTreeItem[] = [];
        const directories: FileTreeItem[] = [];
        const files: FileTreeItem[] = [];

        try {
            const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                const excluded = this.isPathExcluded(fullPath);
                
                const item: FileTreeItem = {
                    label: entry.name,
                    fullPath: fullPath,
                    excluded: excluded,
                    collapsibleState: entry.isDirectory() 
                        ? vscode.TreeItemCollapsibleState.Collapsed 
                        : vscode.TreeItemCollapsibleState.None
                };
                
                if (entry.isDirectory()) {
                    directories.push(item);
                } else {
                    files.push(item);
                }
            }

            directories.sort((a, b) => (a.label as string).localeCompare(b.label as string));
            files.sort((a, b) => (a.label as string).localeCompare(b.label as string));

            items.push(...directories);
            items.push(...files);

        } catch (error) {
            console.error('Error reading directory:', error);
        }

        return items;
    }

    toggleExclude(item: FileTreeItem): void {
        if (this.excludedPaths.has(item.fullPath)) {
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
        this.refresh();
    }

    toggleAIStyle(): void {
        this._useAIStyle = !this._useAIStyle;
        this.refresh();
    }

	getAIIcon(): vscode.ThemeIcon {
        return this._useAIStyle ? 
            new vscode.ThemeIcon('sparkle') : 
            new vscode.ThemeIcon('symbol-boolean');
    }

    private async readFileContent(filePath: string): Promise<string> {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '[Unable to read file content]';
        }
    }

    private async analyzeFiles(dirPath: string, level: number = 0): Promise<string[]> {
        const results: string[] = [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            if (!this.excludedPaths.has(fullPath)) {
                if (entry.isFile()) {
                    const content = await this.readFileContent(fullPath);
                    const relativePath = path.relative(this.workspaceRoot!, fullPath);
                    results.push(`File: ${relativePath}\nContent: ${content}\n`);
                }
                
                if (entry.isDirectory()) {
                    results.push(...await this.analyzeFiles(fullPath, level + 1));
                }
            }
        }
        
        return results;
    }

    async generateReport(): Promise<string> {
        if (!this.workspaceRoot) {
            return 'No workspace folder opened';
        }

		let report = '';

        if (this._useAIStyle) {
            report += `Prompt: Analyze the ${path.basename(this.workspaceRoot)} folder to understand its structure, purpose, and functionality.
Follow these steps to study the codebase:

1. Read the README file to gain an overview of the project, its goals, and any setup instructions.

2. Examine the folder structure to understand how the files and directories are organized.

3. Identify the main entry point of the application and start analyzing the code flow from there.

4. Study the dependencies and libraries used in the project.

5. Analyze the core functionality of the project.

6. Look for any configuration files to understand project settings.

7. Investigate any tests or test directories.

8. Review documentation and inline comments.

9. Identify potential areas for improvement.

10. Provide a summary of findings.

`;
        }

        report += `Folder Structure: ${path.basename(this.workspaceRoot)}\n`;
        report += await this.generateFolderStructure(this.workspaceRoot);
        report += '\n';

        const files = await this.analyzeFiles(this.workspaceRoot);
        report += files.join('\n');

        return report;
    }

    private async generateFolderStructure(dirPath: string, prefix: string = ''): Promise<string> {
        let result = '';
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (!this.excludedPaths.has(fullPath)) {
                const relativePath = path.relative(this.workspaceRoot!, fullPath);
                if (entry.isDirectory()) {
                    result += `${prefix}${relativePath}/\n`;
                    result += await this.generateFolderStructure(fullPath, prefix);
                } else {
                    result += `${prefix}${relativePath}\n`;
                }
            }
        }
        
        return result;
    }
}

let aiStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    const repoAnalyzerProvider = new RepoAnalyzerProvider(context);
    
    const view = vscode.window.createTreeView('repotxt', {
        treeDataProvider: repoAnalyzerProvider,
        showCollapseAll: true
    });

    aiStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    aiStatusBarItem.command = 'repotxt.toggleAIStyle';
    context.subscriptions.push(aiStatusBarItem);

    function updateAIStatusBarItem(useAIStyle: boolean) {
        aiStatusBarItem.text = useAIStyle ? '$(sparkle) AI Style' : '$(symbol-boolean) Regular Style';
        aiStatusBarItem.tooltip = useAIStyle ? 'Click to disable AI Style' : 'Click to enable AI Style';
    }

    updateAIStatusBarItem(repoAnalyzerProvider.useAIStyle);
    aiStatusBarItem.show();

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
    
    let aiCommand = vscode.commands.registerCommand('repotxt.toggleAIStyle', () => {
        repoAnalyzerProvider.toggleAIStyle();
        context.globalState.update('repotxt.useAIStyle', repoAnalyzerProvider.useAIStyle);
        updateAIStatusBarItem(repoAnalyzerProvider.useAIStyle);
    });
    
    context.subscriptions.push(aiCommand);

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.generateReport', async () => {
            const report = await repoAnalyzerProvider.generateReport();
            
            const document = await vscode.workspace.openTextDocument({
                content: report,
                language: 'markdown'
            });
            
            await vscode.window.showTextDocument(document, {
                preview: false,
                viewColumn: vscode.ViewColumn.Beside
            });
        })
    );
}

export function deactivate() {}
