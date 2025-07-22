import * as vscode from 'vscode';
import * as path from 'path';

export class RepoAnalyzerWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'repotxt.webview';
    private _view?: vscode.WebviewView;
    private _repoAnalyzerProvider: any;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        repoAnalyzerProvider: any
    ) {
        this._repoAnalyzerProvider = repoAnalyzerProvider;
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

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'getFileTree':
                    const tree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: tree });
                    break;
                case 'toggleExclude':
                    await this._repoAnalyzerProvider.toggleExcludeByPath(data.path);
                    const updatedTree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: updatedTree });
                    break;
                case 'generateReport':
                    vscode.commands.executeCommand('repotxt.generateReport');
                    break;
                case 'refresh':
                    vscode.commands.executeCommand('repotxt.refresh');
                    const refreshedTree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: refreshedTree });
                    break;
                case 'resetExclusions':
                    vscode.commands.executeCommand('repotxt.resetExclusions');
                    const resetTree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: resetTree });
                    break;
                case 'excludeAll':
                    vscode.commands.executeCommand('repotxt.excludeAll');
                    const excludedTree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: excludedTree });
                    break;
                case 'includeAll':
                    vscode.commands.executeCommand('repotxt.includeAll');
                    const includedTree = await this._repoAnalyzerProvider.getWebviewData();
                    webviewView.webview.postMessage({ type: 'fileTree', data: includedTree });
                    break;
                case 'openFile':
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(data.path));
                    break;
            }
        });

        this._repoAnalyzerProvider.onDidChangeTreeData(() => {
            this.updateWebview();
        });
    }

    public async updateWebview() {
        if (this._view) {
            const tree = await this._repoAnalyzerProvider.getWebviewData();
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
                    <svg viewBox="0 0 16 16" fill="none">
                        <path d="M13.5 2.5A7 7 0 112.5 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M13.5 2.5v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="tooltip">Refresh</span>
                </button>
                <button class="btn-icon" id="excludeAllBtn">
                    <svg viewBox="0 0 16 16" fill="none">
                        <path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.5"/>
                        <path d="M1 1l14 14" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                    <span class="tooltip">Exclude All</span>
                </button>
                <button class="btn-icon" id="includeAllBtn">
                    <svg viewBox="0 0 16 16" fill="none">
                        <path d="M8 2C4.5 2 1.5 5 0 8c1.5 3 4.5 6 8 6s6.5-3 8-6c-1.5-3-4.5-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.5"/>
                        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                    <span class="tooltip">Include All</span>
                </button>
                <button class="btn-icon primary" id="generateBtn">
                    <svg viewBox="0 0 16 16" fill="none">
                        <path d="M4 2v12h8V6l-2-2-2-2H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="currentColor" fill-opacity="0.2"/>
                        <path d="M8 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                    </svg>
                    <span class="tooltip">Generate Report</span>
                </button>
                <button class="btn-icon" id="resetBtn">
                    <svg viewBox="0 0 16 16" fill="none">
                        <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
                        <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                    <span class="tooltip">Reset Exclusions</span>
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
