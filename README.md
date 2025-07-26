# Repository Content Analyzer (RepoTxt)

A VS Code extension that helps you analyze and generate comprehensive reports of your repository content.

## Features

- **Project-Specific Sessions**: Your excluded files are saved per project and restored when you reopen VS Code.
- **Interactive File Tree**: Browse your repository structure with an interactive tree view, click to open files.
- **Modern Webview Interface**: Use a fast, modern web-based interface with advanced selection and multi-select support.
- **Classic Treeview Interface**: Switch to the traditional VS Code tree view if you prefer native look and feel.
- **Selective Analysis**: Include or exclude specific files and folders from analysis.
- **Partial File Selection**: Add only specific lines or code fragments from files to your report.
- **Live Line & Character Counters**: See up-to-date line, character, and file counts for any selection, file, or folder.
- **AI-Enhanced Analysis**: Generate AI-powered analysis reports.
- **Report Generation**: Generate detailed reports of your repository content.
- **Real-Time Updates**: Automatically updates when files change in your workspace.

### Interface Modes: Webview & Treeview

RepoTxt supports two interface modes:

- **Webview** (default):  
  A modern, web-based UI with advanced features:
  - Multi-select files and folders (Ctrl/Cmd+Click, Shift+Click)
  - Fast navigation and smooth performance, even for large repositories
  - Live counters and tooltips for lines, characters, and files
  - Partial selection badges and quick actions

- **Treeview**:  
  The classic VS Code tree view:
  - Native look and feel
  - Supports all core features (exclusion, partial selection, report generation)
  - Can be enabled via the `repotxt.interfaceType` setting

You can switch between these modes in the extension settings (`repotxt.interfaceType`).

### File Tree and Exclusion
The extension provides a tree view of your repository where you can:
- View all files and folders in your workspace
- Click files to open them in the editor
- Toggle files/folders to include/exclude from analysis
- See excluded items marked with a closed eye icon
- See files with partial selections marked with a special badge
- Your exclusion and selection choices are saved for each project

### Partial File Selection
- Select any lines in the editor and use the "Add Selection to Report" command (or right-click context menu)
- Files with partial selections are marked in the tree and can be reset with one click
- The report will include only the selected line ranges for such files

### Live Counters
- The status bar shows the total number of lines, characters, and files that will be included in the report (taking exclusions and partial selections into account)
- Tooltips for files and folders show line, character, and file counts (all stats respect exclusions and partial selections)
- For partially included files and folders, stats are calculated only for the selected ranges

### Analysis Types
- **Regular Analysis**: Basic file structure and content analysis
- **AI Analysis**: Enhanced analysis with intelligent structure interpretation and recommendations (configurable via settings)

### Report Generation
Generate comprehensive reports that include:
- Complete folder structure
- File contents (or only selected fragments, if partial selection is used)
- Analysis based on selected mode
- Excluded items are automatically omitted from reports

## Getting Started

1. Install the extension
2. Open your repository in VS Code
3. Access the Repo Analyzer view from the activity bar
4. Use the tree view or webview to manage which files or code fragments to analyze
5. Click the "Generate Report" button to create a report

## Extension Controls

- **Toggle Exclude** (eye icon): Include/exclude files from analysis. Your choice is saved for the project.
- **Generate Report** (notebook icon): Create a new analysis report
- **Refresh** (refresh icon): Update the file tree view
- **Reset Exclusions** (clear-all icon): Reverts all manual inclusions/exclusions to the defaults defined in your settings.
- **Add Selection to Report**: Add the currently selected lines in the editor to the report (right-click or command palette)
- **Clear Selections**: Remove all partial selections for the current file

## Settings

The extension can be configured through VS Code settings:

### Interface Settings
- `repotxt.interfaceType`: Choose between `"webview"` (default) and `"treeview"` interface modes.

### Analysis Settings
- `repotxt.aiStyle`: Enable/disable AI-enhanced analysis
  - Default: `false`
- `repotxt.aiPrompt`: Customize the AI analysis prompt.

### Auto-Exclude Settings
- `repotxt.autoExcludeEnabled`: Enable/disable automatic file exclusion based on patterns.
  - Default: `true`
- `repotxt.autoExcludePatterns`: Patterns of files and folders to automatically exclude.
  - Default patterns: `node_modules`, `.git`, `dist`, `build`, etc.
  - Supports glob patterns like `*.log`.

### Ignore File Integration
- `repotxt.respectIgnoreFiles`: Automatically exclude files listed in ignore files.
  - Default: `true`
- `repotxt.ignoreFileNames`: A list of filenames to treat as ignore files.
  - Default: `[".gitignore"]`
  - You can add other files like `.dockerignore`, `.eslintignore`, etc.

### Binary File Handling
- `repotxt.excludeBinaryFiles`: Automatically exclude binary files from analysis.
  - Default: `true`
- `repotxt.binaryFileExtensions`: A list of file extensions to be considered binary.
  - Default: A comprehensive list of image, archive, and executable extensions.

### Counters & UI
- `repotxt.showStatusBarLineCount`: Show total line count in the status bar (default: `true`)
- `repotxt.showStatusBarCharCount`: Show total character count in the status bar (default: `true`)
- `repotxt.showStatusBarFileCount`: Show total file count in the status bar (default: `true`)
- `repotxt.showTooltipLineCount`: Show line count in file/folder tooltips (default: `true`)
- `repotxt.showTooltipCharCount`: Show character count in file/folder tooltips (default: `true`)
- `repotxt.selectionHighlightColor`: Color for partial selection highlights in the gutter (hex format)

You can modify these settings in VS Code:
1. Open Settings (Ctrl/Cmd + ,)
2. Search for "Repository Analyzer"
3. Adjust settings as needed

## Requirements

- Visual Studio Code version 1.90.0 or higher
- A workspace/folder opened in VS Code

## Contributing

Feel free to submit issues and enhancement requests on the GitHub repository.

## License

This extension is licensed under the MIT License.
