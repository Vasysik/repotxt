import * as vscode from 'vscode';
import { RepoAnalyzerCore } from './repoAnalyzerCore';
import { TreeViewProvider } from './treeViewProvider';
import { RepoAnalyzerWebviewProvider } from './webviewProvider';

let treeView: vscode.TreeView<any> | undefined;
let treeViewProvider: TreeViewProvider | undefined;
let selectionDecoration: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
    const core = new RepoAnalyzerCore(context);
    
    selectionDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerColor: new vscode.ThemeColor('gitDecoration.stageModifiedResourceForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('gitDecoration.stageModifiedResourceForeground'),
    });
    
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
        const webviewProvider = new RepoAnalyzerWebviewProvider(context.extensionUri, core);
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
        vscode.commands.registerCommand('repotxt.refresh', () => core.refresh()),
        vscode.commands.registerCommand('repotxt.resetExclusions', () => core.resetExclusions()),
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
        vscode.commands.registerCommand('repotxt.clearSelections', (filePath?: string) => {
            if (filePath) {
                const editor = vscode.window.activeTextEditor;
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
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('No active editor');
                    return;
                }
                if (editor.selections.some(s => !s.isEmpty)) {
                    core.removeRanges(editor.document.uri.fsPath, editor.selections.filter(s => !s.isEmpty));
                    updateEditorDecorations(editor);
                    vscode.window.showInformationMessage('Removed selection from report');
                } else {
                    core.clearRanges(editor.document.uri.fsPath);
                    updateEditorDecorations(editor);
                    vscode.window.showInformationMessage('Cleared all selections for file');
                }
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
        })
    );
    
    updateEditorDecorations(vscode.window.activeTextEditor);
    
    core.onDidChange(() => {
        updateEditorDecorations(vscode.window.activeTextEditor);
    });
    
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('repotxt.interfaceType')) {
            vscode.window.showInformationMessage('Please reload VS Code to apply interface type change.', 'Reload')
                .then(action => {
                    if (action === 'Reload') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
        }
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
