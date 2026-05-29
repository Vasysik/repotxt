import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RepoAnalyzerCore } from './repoAnalyzerCore';

export class RepoAnalyzerWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'repotxt.webview';
    private _view?: vscode.WebviewView;

    // Throttle for full-tree refresh broadcasts — coalesces bursts of file events.
    private pendingTreeUpdate: NodeJS.Timeout | undefined;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private _core: RepoAnalyzerCore,
    ) {
        this._core.onDidChange(() => this.scheduleTreeUpdate());

        this._core.onDidUpdateNodes((nodes) => {
            if (!this._view) return;
            this._view.webview.postMessage({ type: 'nodeStates', states: nodes });
            // Only push stats here for the explicit nodes the change touches.
            const statsPayload = nodes.map(n => ({
                path: n.path,
                stats: this._core.getStatsForPath(n.path),
            }));
            this._view.webview.postMessage({ type: 'statsUpdate', list: statsPayload });
        });

        this._core.onDidUpdatePartial((filePath) => {
            if (!this._view) return;
            const payload: any[] = [{ path: filePath, stats: this._core.getStatsForPath(filePath) }];
            let cur = path.dirname(filePath);
            const root = this._core.getWorkspaceRoot() ?? '';
            while (cur && cur.startsWith(root) && cur !== path.dirname(cur)) {
                payload.push({ path: cur, stats: this._core.getStatsForPath(cur) });
                cur = path.dirname(cur);
            }
            this._view.webview.postMessage({ type: 'statsUpdate', list: payload });
        });
    }

    private scheduleTreeUpdate() {
        if (this.pendingTreeUpdate) clearTimeout(this.pendingTreeUpdate);
        this.pendingTreeUpdate = setTimeout(() => this.updateWebview(), 80);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this.updateWebview();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                // Avoid the global cache flush on every show — the core already
                // keeps content stats valid; just resend the current tree.
                this.updateWebview();
                this._view?.webview.postMessage({ type: 'fullRefresh' });
            }
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'getFileTree': {
                    const tree = await this.getWebviewData();
                    const config = vscode.workspace.getConfiguration('repotxt');
                    webviewView.webview.postMessage({
                        type: 'fileTree',
                        data: tree,
                        config: {
                            showTooltipLineCount: config.get('showTooltipLineCount', true),
                            showTooltipCharCount: config.get('showTooltipCharCount', true),
                        },
                    });
                    break;
                }
                case 'getChildren': {
                    const children = await this.getWebviewChildren(data.path);
                    webviewView.webview.postMessage({ type: 'children', path: data.path, data: children });
                    break;
                }
                case 'getFolderStats': {
                    // Lazy folder-stat computation requested by the UI (tooltip etc.)
                    const stats = this._core.getStatsForPath(data.path);
                    webviewView.webview.postMessage({ type: 'statsUpdate', list: [{ path: data.path, stats }] });
                    break;
                }
                case 'getNodeStates': {
                    const states = (data.paths as string[]).map(p => ({
                        path: p,
                        excluded: this._core.isPathVisuallyExcluded(p),
                        partial: this._core.hasPartialIncludes(p),
                    }));
                    webviewView.webview.postMessage({ type: 'nodeStates', states });
                    break;
                }
                case 'toggleExclude':
                    this._core.toggleExclude(data.path);
                    break;
                case 'toggleExcludeMultiple': {
                    this._core.toggleExcludeMultiple(data.paths);
                    const affected = this.collectAllAffectedPaths(data.paths);
                    const updated = affected.map(p => ({
                        path: p,
                        excluded: this._core.isPathVisuallyExcluded(p),
                        partial: this._core.hasPartialIncludes(p),
                    }));
                    webviewView.webview.postMessage({ type: 'nodeStates', states: updated });
                    break;
                }
                case 'clearSelections': {
                    if (data.useEditor) {
                        const editor = vscode.window.activeTextEditor;
                        if (editor && editor.document.uri.fsPath === data.path
                            && editor.selections.some(s => !s.isEmpty)) {
                            this._core.removeRanges(data.path, editor.selections.filter(s => !s.isEmpty));
                        } else {
                            this._core.clearRanges(data.path);
                        }
                    } else {
                        this._core.clearRanges(data.path);
                    }
                    this.updateWebview();
                    break;
                }
                case 'generateReport':
                    vscode.commands.executeCommand('repotxt.generateReport');
                    break;
                case 'refresh':
                    vscode.commands.executeCommand('repotxt.refresh');
                    break;
                case 'resetExclusions':
                    vscode.commands.executeCommand('repotxt.resetExclusions');
                    break;
                case 'toggleAll':
                    this._core.toggleAll();
                    break;
                case 'openFile':
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(data.path));
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:TUBIK-corp.repotxt');
                    break;
                case 'searchFiles': {
                    const matches = await this._core.searchFiles(data.query, 250);
                    webviewView.webview.postMessage({
                        type: 'searchResults',
                        query: data.query,
                        results: matches,
                    });
                    break;
                }
            }
        });
    }

    private collectAllAffectedPaths(paths: string[]): string[] {
        const affected = new Set<string>();
        const root = this._core.getWorkspaceRoot();
        if (!root) return [];
        for (const target of paths) {
            affected.add(target);
            try {
                if (fs.statSync(target).isDirectory()) {
                    this.collectDescendantPaths(target, affected);
                }
            } catch { /* ignore */ }
            let parent = path.dirname(target);
            while (parent && parent !== root && parent !== path.dirname(parent)) {
                affected.add(parent);
                parent = path.dirname(parent);
            }
        }
        return Array.from(affected);
    }

    private collectDescendantPaths(dirPath: string, result: Set<string>): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(dirPath, entry.name);
                result.add(full);
                if (entry.isDirectory()) this.collectDescendantPaths(full, result);
            }
        } catch { /* ignore */ }
    }

    public async updateWebview() {
        if (!this._view) return;
        const tree = await this.getWebviewData();
        const config = vscode.workspace.getConfiguration('repotxt');
        this._view.webview.postMessage({
            type: 'fileTree',
            data: tree,
            config: {
                showTooltipLineCount: config.get('showTooltipLineCount', true),
                showTooltipCharCount: config.get('showTooltipCharCount', true),
            },
        });
    }

    private async getWebviewData(): Promise<any[]> {
        const root = this._core.getWorkspaceRoot();
        if (!root) return [];
        return this.getWebviewFileTree(root);
    }

    private async getWebviewChildren(directoryPath: string): Promise<any[]> {
        return this.getWebviewFileTree(directoryPath);
    }

    /**
     * Build one tree level. Critically: folder stats are NOT computed here —
     * the previous version walked the entire subtree per directory which is
     * the main source of lag for large repos. The UI requests folder stats
     * on demand (`getFolderStats`).
     */
    private async getWebviewFileTree(directoryPath: string): Promise<any[]> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
        } catch {
            return [];
        }
        entries.sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            return aIsDir !== bIsDir ? aIsDir - bIsDir : a.name.localeCompare(b.name);
        });

        const result: any[] = [];
        for (const entry of entries) {
            const fullPath = path.join(directoryPath, entry.name);
            const isExcluded = this._core.isPathVisuallyExcluded(fullPath);
            const item: any = {
                name: entry.name,
                fullPath,
                isDirectory: entry.isDirectory(),
                excluded: isExcluded,
                partial: this._core.hasPartialIncludes(fullPath),
                children: entry.isDirectory() ? null : [],
            };

            if (!entry.isDirectory()) {
                // File stats are cached cheaply (mtime-keyed) — safe to compute here.
                const stats = this._core.hasPartialIncludes(fullPath)
                    ? this._core.getFileStatsWithPartial(fullPath)
                    : this._core.getFileStats(fullPath);
                item.lines = stats.lines;
                item.chars = stats.chars;
            }
            // No folder stats here. UI fetches them lazily.
            result.push(item);
        }
        return result;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'script.js'));
        const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'icons.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));

        const nonce = getNonce();
        const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Repository Analyzer</title>
</head>
<body>
    <div class="app-container">
        <div class="toolbar">
            <div class="toolbar-title">Explorer</div>
            <div class="toolbar-actions">
                <button class="btn-icon" id="refreshBtn" title="Refresh">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5.56253 2.51577C3.46348 3.4501 2 5.55414 2 7.99999C2 11.3137 4.68629 14 8 14C11.3137 14 14 11.3137 14 7.99999C14 5.32519 12.2497 3.05919 9.83199 2.28482L9.52968 3.23832C11.5429 3.88454 13 5.7721 13 7.99999C13 10.7614 10.7614 13 8 13C5.23858 13 3 10.7614 3 7.99999C3 6.31104 3.83742 4.81767 5.11969 3.91245L5.56253 2.51577Z" fill="currentColor"/>
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3H2V2H5.5L6 2.5V6H5V3Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Refresh</span>
                </button>
                <button class="btn-icon primary" id="generateBtn" title="Generate Report">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 1H1.5L1 1.5V4.5L1.5 5H2V13.5L2.5 14H13.5L14 13.5V5H14.5L15 4.5V1.5L14.5 1ZM13.5 4H2.5H2V2H14V4H13.5ZM3 13V5H13V13H3ZM11 7H5V8H11V7Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Generate Report</span>
                </button>
                <button class="btn-icon" id="resetBtn" title="Reset Exclusions">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M10.0001 12.6L10.7001 13.3L12.3001 11.7L13.9001 13.3L14.7001 12.6L13.0001 11L14.7001 9.40005L13.9001 8.60005L12.3001 10.3L10.7001 8.60005L10.0001 9.40005L11.6001 11L10.0001 12.6Z" fill="currentColor"/>
                        <path d="M1.00006 4L15.0001 4L15.0001 3L1.00006 3L1.00006 4Z" fill="currentColor"/>
                        <path d="M1.00006 7L15.0001 7L15.0001 6L1.00006 6L1.00006 7Z" fill="currentColor"/>
                        <path d="M9.00006 9.5L9.00006 9L1.00006 9L1.00006 10L9.00006 10L9.00006 9.5Z" fill="currentColor"/>
                        <path d="M9.00006 13L9.00006 12.5L9.00006 12L1.00006 12L1.00006 13L9.00006 13Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Reset Exclusions</span>
                </button>
                <button class="btn-icon" id="toggleAllBtn" title="Include/Exclude All">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.5"/>
                        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                    <span class="tooltip">Include/Exclude All</span>
                </button>
                <button class="btn-icon" id="settingsBtn" title="Settings">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M9.1 4.4L8.6 2H7.4L6.9 4.4L6.2 4.7L4.2 3.4L3.3 4.2L4.6 6.2L4.4 6.9L2 7.4V8.6L4.4 9.1L4.7 9.9L3.4 11.9L4.2 12.7L6.2 11.4L7 11.7L7.4 14H8.6L9.1 11.6L9.9 11.3L11.9 12.6L12.7 11.8L11.4 9.8L11.7 9L14 8.6V7.4L11.6 6.9L11.3 6.1L12.6 4.1L11.8 3.3L9.8 4.6L9.1 4.4Z M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Settings</span>
                </button>
                <button class="btn-icon" id="collapseBtn" title="Collapse All">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M9 9H4V10H9V9Z" fill="currentColor"/>
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Collapse All</span>
                </button>
            </div>
        </div>

        <div class="search-bar">
            <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M10.41 11.7a6 6 0 111.3-1.29l3.34 3.33-1.3 1.3-3.34-3.34zM6.5 11a4.5 4.5 0 100-9 4.5 4.5 0 000 9z" fill="currentColor"/>
            </svg>
            <input type="text" id="searchInput" class="search-input" placeholder="Search files (name fragment)" spellcheck="false" autocomplete="off">
            <button class="search-clear" id="searchClearBtn" title="Clear" tabindex="-1" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16"><path d="M8 8.71l3.65 3.65.7-.7L8.71 8l3.64-3.65-.7-.7L8 7.29 4.35 3.65l-.7.7L7.29 8l-3.64 3.65.7.7L8 8.71z" fill="currentColor"/></svg>
            </button>
        </div>

        <div class="file-tree" id="fileTree">
            <div class="loading-container">
                <div class="spinner"></div>
                <div class="loading-text">Loading repository...</div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${iconsUri}"></script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}
