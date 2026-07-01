import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RepoAnalyzerCore } from './repoAnalyzerCore';

export interface FileTreeItem extends vscode.TreeItem {
    fullPath: string;
    excluded: boolean;
    isDirectory: boolean;
}

export class TreeViewProvider implements vscode.TreeDataProvider<FileTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FileTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private treeView: vscode.TreeView<FileTreeItem> | undefined;
    private cutPaths = new Set<string>();

    /**
     * Path-keyed cache for tree items.
     *
     * The previous implementation returned fresh item objects on every read. That
     * is safe but makes it harder to patch individual paths and to reason about
     * stale children. We keep only lightweight metadata in a hash map keyed by
     * full path, while every getChildren call still reads the real directory from
     * disk. New files therefore appear on refresh/file watcher events without
     * relying on an old nested array snapshot.
     */
    private itemByPath = new Map<string, FileTreeItem>();
    private childrenByDirectory = new Map<string, Set<string>>();

    constructor(private core: RepoAnalyzerCore) {
        this.core.onDidChange(() => this.refresh());
    }

    setTreeView(treeView: vscode.TreeView<FileTreeItem>) {
        this.treeView = treeView;
    }

    refresh(item?: FileTreeItem): void {
        if (!item) {
            this.pruneMissingCachedItems();
        }
        this._onDidChangeTreeData.fire(item);
    }

    setCutPaths(paths: string[]): void {
        this.cutPaths = new Set(paths);
        this.refresh();
    }

    getTreeItem(element: FileTreeItem): vscode.TreeItem {
        const isDirectory = this.pathIsDirectory(element.fullPath, element.isDirectory);
        element.isDirectory = isDirectory;
        const isVisuallyExcluded = this.core.isPathVisuallyExcluded(element.fullPath);
        const hasPartial = this.core.hasPartialIncludes(element.fullPath);
        const isCut = this.cutPaths.has(element.fullPath);
        const collapsibleState = isDirectory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const treeItem = new vscode.TreeItem(element.label as string, collapsibleState);
        treeItem.resourceUri = vscode.Uri.file(element.fullPath);
        treeItem.contextValue = this.buildContextValue(element.fullPath, isDirectory, hasPartial);

        if (isCut) {
            treeItem.iconPath = new vscode.ThemeIcon('cut');
            treeItem.description = '(cut)';
            treeItem.tooltip = 'Cut: will be moved on paste';
        } else if (hasPartial && !isDirectory) {
            treeItem.iconPath = new vscode.ThemeIcon('symbol-text');
            treeItem.description = '(partial)';
            treeItem.tooltip = 'Partial content included';
        } else if (isVisuallyExcluded) {
            treeItem.iconPath = new vscode.ThemeIcon('eye-closed');
            treeItem.description = '(excluded)';
            treeItem.tooltip = 'Excluded from report';
        } else {
            treeItem.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
        }

        if (isCut && treeItem.description !== '(cut)') {
            const description = typeof treeItem.description === 'string' ? treeItem.description : '';
            treeItem.description = description ? `${description} (cut)` : '(cut)';
        }

        if (!isDirectory) {
            treeItem.command = {
                command: 'vscode.open',
                arguments: [vscode.Uri.file(element.fullPath)],
                title: 'Open File'
            };
        }

        const cfg = vscode.workspace.getConfiguration('repotxt');

        if (isDirectory) {
            const folderStats = this.core.getFolderStats(element.fullPath);
            if (folderStats.files > 0) {
                const parts: string[] = [];
                if (cfg.get('showTooltipLineCount', true)) parts.push(`${folderStats.lines.toLocaleString()} lines`);
                if (cfg.get('showTooltipCharCount', true)) parts.push(`${folderStats.chars.toLocaleString()} chars`);
                if (parts.length > 0) {
                    parts.push(`${folderStats.files} files`);
                    treeItem.tooltip = parts.join(' | ');
                }
            }
        } else {
            const stats = hasPartial
                ? this.core.getFileStatsWithPartial(element.fullPath)
                : this.core.getFileStats(element.fullPath);
            const parts: string[] = [];
            if (cfg.get('showTooltipLineCount', true)) parts.push(`${stats.lines.toLocaleString()} lines`);
            if (cfg.get('showTooltipCharCount', true)) parts.push(`${stats.chars.toLocaleString()} chars`);
            if (parts.length > 0) {
                treeItem.tooltip = (treeItem.tooltip ? treeItem.tooltip + ' | ' : '') + parts.join(' | ');
            }
        }

        if (isCut) {
            const tooltip = typeof treeItem.tooltip === 'string' ? treeItem.tooltip : '';
            const cutTooltip = 'Cut: will be moved on paste';
            treeItem.tooltip = tooltip && !tooltip.includes(cutTooltip) ? `${tooltip} | ${cutTooltip}` : (tooltip || cutTooltip);
            treeItem.contextValue = `${treeItem.contextValue ?? ''} cut`.trim();
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
            const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
                .sort((a, b) => {
                    const aIsDir = a.isDirectory() ? 0 : 1;
                    const bIsDir = b.isDirectory() ? 0 : 1;
                    return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
                });

            const currentChildren = new Set<string>();
            const items = entries.map(entry => {
                const fullPath = path.join(directoryPath, entry.name);
                currentChildren.add(fullPath);
                return this.upsertItem(fullPath, entry.name, entry.isDirectory());
            });

            this.pruneStaleChildren(directoryPath, currentChildren);
            this.childrenByDirectory.set(directoryPath, currentChildren);
            return items;
        } catch {
            this.childrenByDirectory.delete(directoryPath);
            return [];
        }
    }

    private upsertItem(fullPath: string, label: string, isDirectory: boolean): FileTreeItem {
        const existing = this.itemByPath.get(fullPath);
        if (existing) {
            existing.label = label;
            existing.fullPath = fullPath;
            existing.isDirectory = isDirectory;
            existing.excluded = this.core.isPathEffectivelyExcluded(fullPath);
            existing.collapsibleState = isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
            return existing;
        }

        const item: FileTreeItem = {
            label,
            fullPath,
            isDirectory,
            excluded: this.core.isPathEffectivelyExcluded(fullPath),
            collapsibleState: isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        };
        this.itemByPath.set(fullPath, item);
        return item;
    }

    private buildContextValue(fullPath: string, isDirectory: boolean, hasPartial: boolean): string {
        const parts = [isDirectory ? 'directory' : 'file'];
        parts.push(this.core.isPathEffectivelyExcluded(fullPath) ? 'excluded' : 'included');
        if (hasPartial) parts.push('partial');
        return parts.join(' ');
    }

    private pathIsDirectory(fullPath: string, fallback: boolean): boolean {
        try {
            return fs.statSync(fullPath).isDirectory();
        } catch {
            return fallback;
        }
    }

    private pruneStaleChildren(directoryPath: string, currentChildren: Set<string>): void {
        const previousChildren = this.childrenByDirectory.get(directoryPath);
        if (!previousChildren) return;
        for (const childPath of previousChildren) {
            if (!currentChildren.has(childPath)) {
                this.deleteCachedSubtree(childPath);
            }
        }
    }

    private deleteCachedSubtree(fullPath: string): void {
        const children = this.childrenByDirectory.get(fullPath);
        if (children) {
            for (const child of children) this.deleteCachedSubtree(child);
            this.childrenByDirectory.delete(fullPath);
        }
        this.itemByPath.delete(fullPath);
    }

    private pruneMissingCachedItems(): void {
        for (const fullPath of Array.from(this.itemByPath.keys())) {
            if (!fs.existsSync(fullPath)) this.deleteCachedSubtree(fullPath);
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
