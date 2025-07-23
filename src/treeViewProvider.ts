import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RepoAnalyzerCore } from './repoAnalyzerCore';

interface FileTreeItem extends vscode.TreeItem {
    children?: FileTreeItem[];
    fullPath: string;
    excluded: boolean;
}

export class TreeViewProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private treeView: vscode.TreeView<FileTreeItem> | undefined;

    constructor(private core: RepoAnalyzerCore) {
        this.core.onDidChange(() => this.refresh());
    }

    setTreeView(treeView: vscode.TreeView<FileTreeItem>) {
        this.treeView = treeView;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const isVisuallyExcluded = this.core.isPathVisuallyExcluded(element.fullPath);
        const isDirectory = fs.existsSync(element.fullPath) && fs.statSync(element.fullPath).isDirectory();
        const collapsibleState = isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        const hasPartial = this.core.hasPartialIncludes(element.fullPath);

        const treeItem = new vscode.TreeItem(element.label as string, collapsibleState);
        
        if (hasPartial && !isDirectory) {
            treeItem.contextValue = 'partial';
            treeItem.iconPath = new vscode.ThemeIcon('symbol-text');
            treeItem.description = '(partial)';
            treeItem.tooltip = 'Partial content included';
        } else {
            treeItem.contextValue = this.core.isPathEffectivelyExcluded(element.fullPath) ? 'excluded' : 'included';
            
            if (isVisuallyExcluded) {
                treeItem.iconPath = new vscode.ThemeIcon('eye-closed');
                treeItem.description = '(excluded)';
                treeItem.tooltip = 'Excluded from report';
            } else {
                treeItem.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
            }
        }
        
        if (!isDirectory) {
            treeItem.command = {
                command: 'vscode.open',
                arguments: [vscode.Uri.file(element.fullPath)],
                title: 'Open File'
            };
        }
        
        return treeItem;
    }

    getChildren(element?: FileTreeItem): Thenable<FileTreeItem[]> {
        const workspaceRoot = this.core.getWorkspaceRoot();
        if (!workspaceRoot) return Promise.resolve([]);
        const directoryPath = element ? element.fullPath : workspaceRoot;
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
        } catch (error) {
            return [];
        }
    }

    toggleExclude(item: FileTreeItem): void {
        if (this.treeView && this.treeView.selection.length > 1) {
            const paths = this.treeView.selection.map(i => i.fullPath);
            this.core.toggleExcludeMultiple(paths);
        } else {
            this.core.toggleExclude(item.fullPath);
        }
    }

    toggleExcludeMultiple(items: FileTreeItem[]): void {
        const paths = items.map(item => item.fullPath);
        this.core.toggleExcludeMultiple(paths);
    }
}
