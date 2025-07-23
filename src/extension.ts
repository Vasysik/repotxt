import * as vscode from 'vscode';
import { RepoAnalyzerCore } from './repoAnalyzerCore';
import { TreeViewProvider } from './treeViewProvider';
import { RepoAnalyzerWebviewProvider } from './webviewProvider';

let treeView: vscode.TreeView<any> | undefined;
let treeViewProvider: TreeViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    const core = new RepoAnalyzerCore(context);
    
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
            vscode.window.showInformationMessage(`Added ${nonEmptySelections.length} selection(s) to report`);
        }),
        vscode.commands.registerCommand('repotxt.clearSelections', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor');
                return;
            }
            core.clearRanges(editor.document.uri.fsPath);
            vscode.window.showInformationMessage('Cleared selections for current file');
        }),
        vscode.commands.registerCommand('repotxt.clearAllSelections', () => {
            core.clearAllRanges();
            vscode.window.showInformationMessage('Cleared all selections in workspace');
        })
    );
    
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
}
