# Repository Content Analyzer (RepoTxt)

A VS Code extension that helps you analyze and generate comprehensive reports of your repository content.

## Features

- **Project-Specific Sessions**: Your excluded files are saved per project and restored when you reopen VS Code.
- **Interactive File Tree**: Browse your repository structure with an interactive tree view, click to open files.
- **Selective Analysis**: Include or exclude specific files and folders from analysis.
- **AI-Enhanced Analysis**: Generate AI-powered analysis reports.
- **Report Generation**: Generate detailed reports of your repository content.
- **Real-Time Updates**: Automatically updates when files change in your workspace.

### File Tree and Exclusion
The extension provides a tree view of your repository where you can:
- View all files and folders in your workspace
- Click files to open them in the editor
- Toggle files/folders to include/exclude from analysis
- See excluded items marked with a closed eye icon
- Your exclusion choices are saved for each project.

### Analysis Types
- **Regular Analysis**: Basic file structure and content analysis
- **AI Analysis**: Enhanced analysis with intelligent structure interpretation and recommendations (configurable via settings)

### Report Generation
Generate comprehensive reports that include:
- Complete folder structure
- File contents
- Analysis based on selected mode
- Excluded items are automatically omitted from reports

## Getting Started

1. Install the extension
2. Open your repository in VS Code
3. Access the Repo Analyzer view from the activity bar
4. Use the tree view to manage which files to analyze
5. Click the "Generate Report" button to create a report

## Extension Controls

- **Toggle Exclude** (eye icon): Include/exclude files from analysis. Your choice is saved for the project.
- **Generate Report** (notebook icon): Create a new analysis report
- **Refresh** (refresh icon): Update the file tree view
- **Reset Exclusions** (clear-all icon): Reverts all manual inclusions/exclusions to the defaults defined in your settings.

## Settings

The extension can be configured through VS Code settings:

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
