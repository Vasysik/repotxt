import * as vscode from 'vscode';
import { RepoAnalyzerCore } from './repoAnalyzerCore';
import { TreeViewProvider } from './treeViewProvider';
import { RepoAnalyzerWebviewProvider } from './webviewProvider';

let treeView: vscode.TreeView<any> | undefined;
let treeViewProvider: TreeViewProvider | undefined;
let selectionDecoration: vscode.TextEditorDecorationType;
let webviewProvider: RepoAnalyzerWebviewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    const core = new RepoAnalyzerCore(context);
    
    function createSelectionDecoration(): vscode.TextEditorDecorationType {
        const config = vscode.workspace.getConfiguration('repotxt');
        const color = config.get<string>('selectionHighlightColor', '#00AFFF');
        
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="18" viewBox="0 0 14 18">
            <rect x="3" y="3" width="8" height="12" rx="2" fill="${color}" opacity="0.8"/>
        </svg>`;
        
        return vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.parse(
                'data:image/svg+xml;base64,' + 
                Buffer.from(svg).toString('base64')
            ),
            gutterIconSize: 'contain',
            overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
            overviewRulerLane: vscode.OverviewRulerLane.Left
        });
    }
    
    selectionDecoration = createSelectionDecoration();
    
    const config = vscode.workspace.getConfiguration('repotxt');
    const interfaceType = config.get<string>('interfaceType', 'treeview');
    
    vscode.commands.executeCommand('setContext', 'repotxt.interfaceType', interfaceType);
    
    if (interfaceType === 'treeview') {
        treeViewProvider = new TreeViewProvider(core);
        treeView = vscode.window.createTreeView('repotxt', {
            treeDataProvider: treeViewProvider,
            showCollapseAll: true,
            canSelectMany: true
        });
        
        treeViewProvider.setTreeView(treeView);
        
        context.subscriptions.push(
            vscode.commands.registerCommand('repotxt.toggleExclude', (item: any) => {
                if (treeViewProvider) {
                    treeViewProvider.toggleExclude(item);
                }
            }),
            vscode.commands.registerCommand('repotxt.toggleExcludeMultiple', () => {
                if (treeView && treeViewProvider && treeView.selection.length > 0) {
                    treeViewProvider.toggleExcludeMultiple([...treeView.selection]);
                }
            })
        );
    } else {
        webviewProvider = new RepoAnalyzerWebviewProvider(context.extensionUri, core);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(RepoAnalyzerWebviewProvider.viewType, webviewProvider, {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            })
        );
    }

    function updateEditorDecorations(editor: vscode.TextEditor | undefined) {
        if (!editor) return;
        
        const ranges = core.getPartialRanges(editor.document.uri.fsPath);
        if (!ranges || ranges.length === 0) {
            editor.setDecorations(selectionDecoration, []);
            return;
        }
        
        const decorations: vscode.DecorationOptions[] = ranges.map(range => ({
            range: new vscode.Range(
                new vscode.Position(range.start - 1, 0),
                new vscode.Position(range.end - 1, Number.MAX_SAFE_INTEGER)
            )
        }));
        
        editor.setDecorations(selectionDecoration, decorations);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.refresh', () => {
            core.refresh();
        }),
        vscode.commands.registerCommand('repotxt.resetExclusions', () => {
            core.resetExclusions();
        }),
        vscode.commands.registerCommand('repotxt.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:TUBIK-corp.repotxt');
        }),
        vscode.commands.registerCommand('repotxt.generateReport', async () => {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Generating Repository Report...",
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0 });
                const report = await core.generateReport();
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
        }),
        vscode.commands.registerCommand('repotxt.addSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.selections.length === 0) {
                vscode.window.showWarningMessage('No selection in active editor');
                return;
            }
            const nonEmptySelections = editor.selections.filter(sel => !sel.isEmpty);
            if (nonEmptySelections.length === 0) {
                vscode.window.showWarningMessage('Please select some text first');
                return;
            }
            core.addRanges(editor.document.uri.fsPath, nonEmptySelections);
            updateEditorDecorations(editor);
            vscode.window.showInformationMessage(`Added ${nonEmptySelections.length} selection(s) to report`);
        }),
        vscode.commands.registerCommand('repotxt.clearSelections', (arg?: any) => {
            const filePath = typeof arg === 'string' 
                ? arg 
                : arg?.fullPath ?? undefined;
            
            const editor = vscode.window.activeTextEditor;
            
            if (filePath) {
                if (editor && editor.document.uri.fsPath === filePath && editor.selections.some(s => !s.isEmpty)) {
                    core.removeRanges(filePath, editor.selections.filter(s => !s.isEmpty));
                    updateEditorDecorations(editor);
                    vscode.window.showInformationMessage('Removed selection from report');
                } else {
                    core.clearRanges(filePath);
                    if (editor && editor.document.uri.fsPath === filePath) {
                        updateEditorDecorations(editor);
                    }
                    vscode.window.showInformationMessage('Cleared all selections for file');
                }
            } else if (editor) {
                if (editor.selections.some(s => !s.isEmpty)) {
                    core.removeRanges(editor.document.uri.fsPath, editor.selections.filter(s => !s.isEmpty));
                    updateEditorDecorations(editor);
                    vscode.window.showInformationMessage('Removed selection from report');
                } else {
                    core.clearRanges(editor.document.uri.fsPath);
                    updateEditorDecorations(editor);
                    vscode.window.showInformationMessage('Cleared all selections for file');
                }
            } else {
                vscode.window.showWarningMessage('No active editor');
            }
        }),
        vscode.commands.registerCommand('repotxt.clearAllSelections', () => {
            core.clearAllRanges();
            updateEditorDecorations(vscode.window.activeTextEditor);
            vscode.window.showInformationMessage('Cleared all selections in workspace');
        }),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            updateEditorDecorations(editor);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                updateEditorDecorations(editor);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('repotxt.selectionHighlightColor')) {
                selectionDecoration.dispose();
                selectionDecoration = createSelectionDecoration();
                updateEditorDecorations(vscode.window.activeTextEditor);
            }
            if (e.affectsConfiguration('repotxt.interfaceType')) {
                vscode.window.showInformationMessage('Please reload VS Code to apply interface type change.', 'Reload')
                    .then(action => {
                        if (action === 'Reload') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
            }
        })
    );
    
    updateEditorDecorations(vscode.window.activeTextEditor);
    
    core.onDidChange(() => {
        updateEditorDecorations(vscode.window.activeTextEditor);
    });
}

export function deactivate() {
    if (treeView) {
        treeView.dispose();
    }
    if (selectionDecoration) {
        selectionDecoration.dispose();
    }
}
