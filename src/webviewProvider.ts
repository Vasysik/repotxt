import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RepoAnalyzerCore } from './repoAnalyzerCore';

export class RepoAnalyzerWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'repotxt.webview';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private _core: RepoAnalyzerCore
    ) {
        this._core.onDidChange(() => this.updateWebview());
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        setTimeout(async () => {
            const tree = await this._core.getWebviewData();
            webviewView.webview.postMessage({ type: 'fileTree', data: tree });
        }, 100);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'getFileTree':
                    const tree = await this._core.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: tree });
                    break;
                case 'getChildren':
                    const children = await this._core.getWebviewChildren(data.path);
                    webviewView.webview.postMessage({ type: 'children', path: data.path, data: children });
                    break;
                case 'getNodeStates':
                    const states = data.paths.map((path: string) => ({
                        path: path,
                        excluded: this._core.isPathVisuallyExcluded(path)
                    }));
                    webviewView.webview.postMessage({ type: 'nodeStates', states: states });
                    break;
                case 'toggleExclude':
                    this._core.toggleExclude(data.path);
                    break;
                case 'toggleExcludeMultiple':
                    this._core.toggleExcludeMultiple(data.paths);
                    const affectedPaths = this.collectAllAffectedPaths(data.paths);
                    const updatedStates = affectedPaths.map(path => ({
                        path: path,
                        excluded: this._core.isPathVisuallyExcluded(path)
                    }));
                    webviewView.webview.postMessage({ type: 'nodeStates', states: updatedStates });
                    break;
                case 'clearSelections':
                    this._core.clearRanges(data.path);
                    break;
                case 'generateReport':
                    vscode.commands.executeCommand('repotxt.generateReport');
                    break;
                case 'refresh':
                    vscode.commands.executeCommand('repotxt.refresh');
                    break;
                case 'resetExclusions':
                    vscode.commands.executeCommand('repotxt.resetExclusions');
                    break;
                case 'openFile':
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(data.path));
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:TUBIK-corp.repotxt');
                    break;
            }
        });
    }

    private collectAllAffectedPaths(paths: string[]): string[] {
        const affectedPaths = new Set<string>();
        const workspaceRoot = this._core.getWorkspaceRoot();
        if (!workspaceRoot) return [];
        
        for (const targetPath of paths) {
            affectedPaths.add(targetPath);
            
            try {
                if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
                    this.collectDescendantPaths(targetPath, affectedPaths);
                }
            } catch (e) {}
            
            let parentPath = path.dirname(targetPath);
            while (parentPath && parentPath !== workspaceRoot && parentPath !== path.dirname(parentPath)) {
                affectedPaths.add(parentPath);
                parentPath = path.dirname(parentPath);
            }
        }
        
        return Array.from(affectedPaths);
    }

    private collectDescendantPaths(dirPath: string, result: Set<string>): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                result.add(fullPath);
                if (entry.isDirectory()) {
                    this.collectDescendantPaths(fullPath, result);
                }
            }
        } catch (e) {}
    }

    public async updateWebview() {
        if (this._view) {
            const tree = await this._core.getWebviewData();
            this._view.webview.postMessage({ type: 'fileTree', data: tree });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'script.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Repository Analyzer</title>
</head>
<body>
    <div class="app-container">
        <div class="toolbar">
            <div class="toolbar-title">Explorer</div>
            <div class="toolbar-actions">
                <button class="btn-icon" id="refreshBtn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5.56253 2.51577C3.46348 3.4501 2 5.55414 2 7.99999C2 11.3137 4.68629 14 8 14C11.3137 14 14 11.3137 14 7.99999C14 5.32519 12.2497 3.05919 9.83199 2.28482L9.52968 3.23832C11.5429 3.88454 13 5.7721 13 7.99999C13 10.7614 10.7614 13 8 13C5.23858 13 3 10.7614 3 7.99999C3 6.31104 3.83742 4.81767 5.11969 3.91245L5.56253 2.51577Z" fill="currentColor"/>
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3H2V2H5.5L6 2.5V6H5V3Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Refresh</span>
                </button>
                <button class="btn-icon primary" id="generateBtn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 1H1.5L1 1.5V4.5L1.5 5H2V13.5L2.5 14H13.5L14 13.5V5H14.5L15 4.5V1.5L14.5 1ZM13.5 4H2.5H2V2H14V4H13.5ZM3 13V5H13V13H3ZM11 7H5V8H11V7Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Generate Report</span>
                </button>
                <button class="btn-icon" id="resetBtn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M10.0001 12.6L10.7001 13.3L12.3001 11.7L13.9001 13.3L14.7001 12.6L13.0001 11L14.7001 9.40005L13.9001 8.60005L12.3001 10.3L10.7001 8.60005L10.0001 9.40005L11.6001 11L10.0001 12.6Z" fill="currentColor"/>
                        <path d="M1.00006 4L15.0001 4L15.0001 3L1.00006 3L1.00006 4Z" fill="currentColor"/>
                        <path d="M1.00006 7L15.0001 7L15.0001 6L1.00006 6L1.00006 7Z" fill="currentColor"/>
                        <path d="M9.00006 9.5L9.00006 9L1.00006 9L1.00006 10L9.00006 10L9.00006 9.5Z" fill="currentColor"/>
                        <path d="M9.00006 13L9.00006 12.5L9.00006 12L1.00006 12L1.00006 13L9.00006 13Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Reset Exclusions</span>
                </button>
                <button class="btn-icon" id="settingsBtn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M9.09976 4.4L8.59976 2H7.39976L6.89976 4.4L6.19976 4.7L4.19976 3.4L3.29976 4.2L4.59976 6.2L4.39976 6.9L1.99976 7.4V8.6L4.39976 9.1L4.69976 9.9L3.39976 11.9L4.19976 12.7L6.19976 11.4L6.99976 11.7L7.39976 14H8.59976L9.09976 11.6L9.89976 11.3L11.8998 12.6L12.6998 11.8L11.3998 9.8L11.6998 9L13.9998 8.6V7.4L11.5998 6.9L11.2998 6.1L12.5998 4.1L11.7998 3.3L9.79976 4.6L9.09976 4.4ZM9.39976 1L9.89976 3.4L11.9998 2.1L13.9998 4.1L12.5998 6.2L14.9998 6.6V9.4L12.5998 9.9L13.9998 12L11.9998 14L9.89976 12.6L9.39976 15H6.59976L6.09976 12.6L3.99976 13.9L1.99976 11.9L3.39976 9.8L0.999756 9.4V6.6L3.39976 6.1L2.09976 4L4.09976 2L6.19976 3.4L6.59976 1H9.39976ZM9.99976 8C9.99976 9.1 9.09976 10 7.99976 10C6.89976 10 5.99976 9.1 5.99976 8C5.99976 6.9 6.89976 6 7.99976 6C9.09976 6 9.99976 6.9 9.99976 8ZM7.99976 9C8.59976 9 8.99976 8.6 8.99976 8C8.99976 7.4 8.59976 7 7.99976 7C7.39976 7 6.99976 7.4 6.99976 8C6.99976 8.6 7.39976 9 7.99976 9Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Settings</span>
                </button>
                <button class="btn-icon" id="collapseBtn">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M9 9H4V10H9V9Z" fill="currentColor"/>
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3L6 2H13L14 3V10L13 11H11V13L10 14H3L2 13V6L3 5H5V3ZM6 5H10L11 6V10H13V3H6V5ZM10 6H3V13H10V6Z" fill="currentColor"/>
                    </svg>
                    <span class="tooltip">Collapse All</span>
                </button>
            </div>
        </div>
        <div class="file-tree" id="fileTree">
            <div class="loading-container">
                <div class="spinner"></div>
                <div class="loading-text">Loading repository...</div>
            </div>
        </div>
    </div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
