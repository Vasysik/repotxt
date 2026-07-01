import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RepoAnalyzerCore } from './repoAnalyzerCore';
import { TreeViewProvider } from './treeViewProvider';
import { RepoAnalyzerWebviewProvider } from './webviewProvider';

let treeView: vscode.TreeView<any> | undefined;
let treeViewProvider: TreeViewProvider | undefined;
let selectionDecoration: vscode.TextEditorDecorationType;
let webviewProvider: RepoAnalyzerWebviewProvider | undefined;
let lineSbItem: vscode.StatusBarItem;
let charSbItem: vscode.StatusBarItem;
let filesSbItem: vscode.StatusBarItem;

type ClipboardMode = 'copy' | 'cut';
interface FileManagerClipboardState { mode: ClipboardMode; paths: string[] }
let fileManagerClipboard: FileManagerClipboardState | undefined;

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

    function createStatusBarItems() {
        lineSbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        lineSbItem.command = 'repotxt.focusView';
        charSbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        charSbItem.command = 'repotxt.focusView';
        filesSbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        filesSbItem.command = 'repotxt.focusView';
        context.subscriptions.push(lineSbItem, charSbItem, filesSbItem);
    }

    function updateStatusBar() {
        const cfg = vscode.workspace.getConfiguration('repotxt');
        const stats = core.getSelectionStats();

        if (cfg.get('showStatusBarLineCount', true) && stats.lines > 0) {
            lineSbItem.text = `$(file-text) ${stats.lines.toLocaleString()} lines`;
            lineSbItem.tooltip = 'Total lines in selected files';
            lineSbItem.show();
        } else {
            lineSbItem.hide();
        }

        if (cfg.get('showStatusBarCharCount', true) && stats.chars > 0) {
            charSbItem.text = `$(symbol-string) ${stats.chars.toLocaleString()} chars`;
            charSbItem.tooltip = 'Total characters in selected files';
            charSbItem.show();
        } else {
            charSbItem.hide();
        }

        if (cfg.get('showStatusBarFileCount', true) && stats.files > 0) {
            filesSbItem.text = `$(files) ${stats.files.toLocaleString()} files`;
            filesSbItem.tooltip = 'Total files selected';
            filesSbItem.show();
        } else {
            filesSbItem.hide();
        }
    }

    selectionDecoration = createSelectionDecoration();

    createStatusBarItems();
    updateStatusBar();

    const config = vscode.workspace.getConfiguration('repotxt');
    const interfaceType = config.get<string>('interfaceType', 'treeview');

    vscode.commands.executeCommand('setContext', 'repotxt.interfaceType', interfaceType);
    vscode.commands.executeCommand('setContext', 'repotxt.hasFileClipboard', false);

    if (interfaceType === 'treeview') {
        treeViewProvider = new TreeViewProvider(core);
        treeView = vscode.window.createTreeView('repotxt', {
            treeDataProvider: treeViewProvider,
            showCollapseAll: true,
            canSelectMany: true
        });

        treeViewProvider.setTreeView(treeView);

        treeView.onDidChangeVisibility(e => {
            if (e.visible) {
                core.refresh();
            }
        });

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

    function getWorkspaceRoot(): string | undefined {
        return core.getWorkspaceRoot();
    }

    function getFullPathFromArg(arg?: any): string | undefined {
        if (!arg) return undefined;
        if (typeof arg === 'string') return arg;
        if (arg instanceof vscode.Uri) return arg.fsPath;
        if (Array.isArray(arg)) return typeof arg[0] === 'string' ? arg[0] : arg[0]?.fullPath;
        return arg.fullPath;
    }

    function getPathsFromArg(arg?: any): string[] {
        if (Array.isArray(arg)) {
            return arg
                .map(item => typeof item === 'string' ? item : item?.fullPath)
                .filter((p): p is string => typeof p === 'string' && p.length > 0);
        }

        const argPath = getFullPathFromArg(arg);
        if (treeView && argPath && treeView.selection.some(item => item.fullPath === argPath)) {
            return treeView.selection.map(item => item.fullPath);
        }
        if (treeView && !argPath && treeView.selection.length > 0) {
            return treeView.selection.map(item => item.fullPath);
        }
        return argPath ? [argPath] : [];
    }

    function isInsideWorkspace(candidate: string): boolean {
        const root = getWorkspaceRoot();
        if (!root) return false;
        const relative = path.relative(root, candidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    async function pathExists(p: string): Promise<boolean> {
        try {
            await fs.promises.access(p);
            return true;
        } catch {
            return false;
        }
    }

    async function getTargetDirectory(arg?: any): Promise<string | undefined> {
        const root = getWorkspaceRoot();
        if (!root) {
            vscode.window.showWarningMessage('No workspace folder opened');
            return undefined;
        }

        const targetPath = getFullPathFromArg(arg);
        if (!targetPath) return root;

        try {
            const stat = await fs.promises.stat(targetPath);
            return stat.isDirectory() ? targetPath : path.dirname(targetPath);
        } catch {
            return path.dirname(targetPath);
        }
    }

    function sanitizeNewChildPath(baseDir: string, inputName: string): string | undefined {
        const normalizedName = inputName.trim();
        if (!normalizedName) return undefined;
        if (path.isAbsolute(normalizedName)) {
            vscode.window.showErrorMessage('Please enter a relative name inside the workspace.');
            return undefined;
        }
        const resolved = path.resolve(baseDir, normalizedName);
        if (!isInsideWorkspace(resolved)) {
            vscode.window.showErrorMessage('The target path must stay inside the current workspace.');
            return undefined;
        }
        return resolved;
    }

    async function refreshAfterFileOperation(revealPath?: string) {
        core.refresh();
        if (treeViewProvider) treeViewProvider.refresh();
        if (revealPath) {
            try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(revealPath));
            } catch {
                // Directories cannot be opened as text documents; refresh is enough.
            }
        }
    }

    function updateFileClipboardVisuals() {
        const cutPaths = fileManagerClipboard?.mode === 'cut' ? fileManagerClipboard.paths : [];
        treeViewProvider?.setCutPaths(cutPaths);
        webviewProvider?.setFileClipboardState(fileManagerClipboard);
        vscode.commands.executeCommand('setContext', 'repotxt.hasFileClipboard', !!fileManagerClipboard);
    }

    async function getAvailableDestination(baseDestination: string): Promise<string> {
        if (!(await pathExists(baseDestination))) return baseDestination;

        const dir = path.dirname(baseDestination);
        const ext = path.extname(baseDestination);
        const base = path.basename(baseDestination, ext);
        let i = 1;
        while (true) {
            const suffix = i === 1 ? ' copy' : ` copy ${i}`;
            const candidate = path.join(dir, `${base}${suffix}${ext}`);
            if (!(await pathExists(candidate))) return candidate;
            i++;
        }
    }

    function assertCanMove(source: string, destinationDirectory: string): boolean {
        const sourceWithSep = source.endsWith(path.sep) ? source : source + path.sep;
        const destWithSep = destinationDirectory.endsWith(path.sep) ? destinationDirectory : destinationDirectory + path.sep;
        if (destWithSep.startsWith(sourceWithSep)) {
            vscode.window.showErrorMessage('Cannot move a folder into itself or one of its children.');
            return false;
        }
        return true;
    }

    async function createFile(arg?: any) {
        const baseDir = await getTargetDirectory(arg);
        if (!baseDir) return;

        const name = await vscode.window.showInputBox({
            prompt: 'New file name',
            placeHolder: 'src/example.ts',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'File name is required'
        });
        if (name === undefined) return;

        const target = sanitizeNewChildPath(baseDir, name);
        if (!target) return;
        if (await pathExists(target)) {
            vscode.window.showErrorMessage('A file or folder with this name already exists.');
            return;
        }

        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, '');
        await refreshAfterFileOperation(target);
        vscode.window.showInformationMessage(`Created file ${path.basename(target)}`);
    }

    async function createFolder(arg?: any) {
        const baseDir = await getTargetDirectory(arg);
        if (!baseDir) return;

        const name = await vscode.window.showInputBox({
            prompt: 'New folder name',
            placeHolder: 'src/components',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'Folder name is required'
        });
        if (name === undefined) return;

        const target = sanitizeNewChildPath(baseDir, name);
        if (!target) return;
        if (await pathExists(target)) {
            vscode.window.showErrorMessage('A file or folder with this name already exists.');
            return;
        }

        await fs.promises.mkdir(target, { recursive: true });
        await refreshAfterFileOperation();
        vscode.window.showInformationMessage(`Created folder ${path.basename(target)}`);
    }

    async function revealInExplorer(arg?: any) {
        const target = getFullPathFromArg(arg) ?? getWorkspaceRoot();
        if (!target) return;
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    }

    async function copyPath(arg?: any) {
        const paths = getPathsFromArg(arg);
        if (paths.length === 0) return;
        await vscode.env.clipboard.writeText(paths.join('\n'));
        vscode.window.showInformationMessage(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`);
    }

    function setFileClipboard(mode: ClipboardMode, arg?: any) {
        const paths = getPathsFromArg(arg);
        if (paths.length === 0) return;
        fileManagerClipboard = { mode, paths };
        updateFileClipboardVisuals();
        vscode.window.showInformationMessage(`${mode === 'cut' ? 'Cut' : 'Copied'} ${paths.length} item(s)`);
    }

    async function paste(arg?: any) {
        if (!fileManagerClipboard || fileManagerClipboard.paths.length === 0) {
            vscode.window.showWarningMessage('Nothing to paste');
            return;
        }

        const targetDir = await getTargetDirectory(arg);
        if (!targetDir) return;

        for (const source of fileManagerClipboard.paths) {
            if (!(await pathExists(source))) continue;
            if (fileManagerClipboard.mode === 'cut' && !assertCanMove(source, targetDir)) continue;

            const destination = await getAvailableDestination(path.join(targetDir, path.basename(source)));
            if (!isInsideWorkspace(destination)) {
                vscode.window.showErrorMessage('Paste target must stay inside the current workspace.');
                continue;
            }

            if (fileManagerClipboard.mode === 'copy') {
                await fs.promises.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
            } else {
                await fs.promises.rename(source, destination);
            }
        }

        if (fileManagerClipboard.mode === 'cut') {
            fileManagerClipboard = undefined;
            updateFileClipboardVisuals();
        }
        await refreshAfterFileOperation();
        vscode.window.showInformationMessage('Paste complete');
    }

    async function renameItem(arg?: any) {
        const target = getFullPathFromArg(arg);
        if (!target) return;

        const oldName = path.basename(target);
        const newName = await vscode.window.showInputBox({
            prompt: 'Rename',
            value: oldName,
            ignoreFocusOut: true,
            validateInput: value => {
                const trimmed = value.trim();
                if (!trimmed) return 'Name is required';
                if (trimmed.includes('/') || trimmed.includes('\\')) return 'Rename cannot move the item to another folder';
                return undefined;
            }
        });
        if (newName === undefined || newName.trim() === oldName) return;

        const destination = path.join(path.dirname(target), newName.trim());
        if (!isInsideWorkspace(destination)) {
            vscode.window.showErrorMessage('The target path must stay inside the current workspace.');
            return;
        }
        if (await pathExists(destination)) {
            vscode.window.showErrorMessage('A file or folder with this name already exists.');
            return;
        }

        await fs.promises.rename(target, destination);
        await refreshAfterFileOperation(destination);
        vscode.window.showInformationMessage(`Renamed to ${path.basename(destination)}`);
    }

    async function deleteItems(arg?: any) {
        const paths = getPathsFromArg(arg);
        if (paths.length === 0) return;

        const label = paths.length === 1 ? path.basename(paths[0]) : `${paths.length} items`;
        const answer = await vscode.window.showWarningMessage(
            `Move ${label} to Trash?`,
            { modal: true },
            'Move to Trash'
        );
        if (answer !== 'Move to Trash') return;

        for (const p of paths) {
            await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
        }
        await refreshAfterFileOperation();
        vscode.window.showInformationMessage(`Deleted ${label}`);
    }

    async function runSafely(title: string, task: () => Promise<void>) {
        try {
            await task();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`${title} failed: ${message}`);
        }
    }

    function defaultReportUri(extension: 'txt' | 'zip'): vscode.Uri | undefined {
        const root = getWorkspaceRoot();
        if (!root) return undefined;
        const workspaceName = path.basename(root);
        return vscode.Uri.file(path.join(root, `${workspaceName}-repotxt-report.${extension}`));
    }

    async function generateTextReport() {
        const targetUri = await vscode.window.showSaveDialog({
            defaultUri: defaultReportUri('txt'),
            filters: { 'Text files': ['txt'], 'Markdown files': ['md'], 'All files': ['*'] },
            saveLabel: 'Save Text Report'
        });
        if (!targetUri) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating text repository report...',
            cancellable: false
        }, async progress => {
            progress.report({ increment: 0 });
            const report = await core.generateReport();
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(report, 'utf8'));
            progress.report({ increment: 100 });
        });

        const action = await vscode.window.showInformationMessage('Text report saved', 'Open');
        if (action === 'Open') await vscode.commands.executeCommand('vscode.open', targetUri);
    }

    async function generateZipReport() {
        const targetUri = await vscode.window.showSaveDialog({
            defaultUri: defaultReportUri('zip'),
            filters: { 'ZIP archives': ['zip'], 'All files': ['*'] },
            saveLabel: 'Save ZIP Report'
        });
        if (!targetUri) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating ZIP repository report...',
            cancellable: false
        }, async progress => {
            progress.report({ increment: 0 });
            const zip = await core.generateZipReport();
            await vscode.workspace.fs.writeFile(targetUri, zip);
            progress.report({ increment: 100 });
        });

        const action = await vscode.window.showInformationMessage('ZIP report saved', 'Reveal in Explorer');
        if (action === 'Reveal in Explorer') await vscode.commands.executeCommand('revealFileInOS', targetUri);
    }

    async function copyTextReportToClipboard() {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating repository report for clipboard...',
            cancellable: false
        }, async progress => {
            progress.report({ increment: 0 });
            const report = await core.generateReport();
            await vscode.env.clipboard.writeText(report);
            progress.report({ increment: 100 });
        });

        vscode.window.showInformationMessage('Repository report copied as text');
    }

    async function chooseReportFormat() {
        const pick = await vscode.window.showQuickPick([
            { label: 'Copy', description: 'Copy generated report as text to the clipboard', command: 'copyText' as const },
            { label: 'Text file', description: 'Save repository report as .txt', command: 'text' as const },
            { label: 'ZIP archive', description: 'Save report and included files as .zip', command: 'zip' as const },
        ], { placeHolder: 'Choose report format' });
        if (!pick) return;
        if (pick.command === 'text') await generateTextReport();
        else if (pick.command === 'zip') await generateZipReport();
        else await copyTextReportToClipboard();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('repotxt.focusView', () => {
            const config = vscode.workspace.getConfiguration('repotxt');
            const interfaceType = config.get<string>('interfaceType', 'treeview');
            if (interfaceType === 'treeview') {
                vscode.commands.executeCommand('repotxt.focus');
            } else {
                vscode.commands.executeCommand('repotxt.webview.focus');
            }
        }),
        vscode.commands.registerCommand('repotxt.refresh', () => {
            core.refresh();
        }),
        vscode.commands.registerCommand('repotxt.resetExclusions', () => {
            core.resetExclusions();
        }),
        vscode.commands.registerCommand('repotxt.toggleAll', () => {
            core.toggleAll();
        }),
        vscode.commands.registerCommand('repotxt.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:TUBIK-corp.repotxt');
        }),
        vscode.commands.registerCommand('repotxt.generateReport', () => runSafely('Generate report', chooseReportFormat)),
        vscode.commands.registerCommand('repotxt.generateTextReport', () => runSafely('Generate text report', generateTextReport)),
        vscode.commands.registerCommand('repotxt.generateZipReport', () => runSafely('Generate ZIP report', generateZipReport)),
        vscode.commands.registerCommand('repotxt.copyTextReport', () => runSafely('Copy report as text', copyTextReportToClipboard)),
        vscode.commands.registerCommand('repotxt.createFile', (arg?: any) => runSafely('Create file', () => createFile(arg))),
        vscode.commands.registerCommand('repotxt.createFolder', (arg?: any) => runSafely('Create folder', () => createFolder(arg))),
        vscode.commands.registerCommand('repotxt.revealInExplorer', (arg?: any) => runSafely('Reveal in Explorer', () => revealInExplorer(arg))),
        vscode.commands.registerCommand('repotxt.cut', (arg?: any) => setFileClipboard('cut', arg)),
        vscode.commands.registerCommand('repotxt.copy', (arg?: any) => setFileClipboard('copy', arg)),
        vscode.commands.registerCommand('repotxt.paste', (arg?: any) => runSafely('Paste', () => paste(arg))),
        vscode.commands.registerCommand('repotxt.copyPath', (arg?: any) => runSafely('Copy path', () => copyPath(arg))),
        vscode.commands.registerCommand('repotxt.rename', (arg?: any) => runSafely('Rename', () => renameItem(arg))),
        vscode.commands.registerCommand('repotxt.delete', (arg?: any) => runSafely('Delete', () => deleteItems(arg))),
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
            if (e.affectsConfiguration('repotxt.showStatusBarLineCount') ||
                e.affectsConfiguration('repotxt.showStatusBarCharCount') ||
                e.affectsConfiguration('repotxt.showStatusBarFileCount')) {
                updateStatusBar();
            }
        })
    );

    updateEditorDecorations(vscode.window.activeTextEditor);

    core.onDidChange(() => {
        updateEditorDecorations(vscode.window.activeTextEditor);
        updateStatusBar();
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
