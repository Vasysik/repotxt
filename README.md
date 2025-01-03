# Repository Content Analyzer (RepoTxt)

A VS Code extension that helps you analyze and generate comprehensive reports of your repository content.

## Features

- **Interactive File Tree**: Browse your repository structure with an interactive tree view
- **Selective Analysis**: Include or exclude specific files and folders from analysis
- **AI-Enhanced Analysis**: Toggle between regular and AI-enhanced analysis modes
- **Report Generation**: Generate detailed reports of your repository content
- **Real-Time Updates**: Automatically updates when files change in your workspace

### File Tree and Exclusion
The extension provides a tree view of your repository where you can:
- View all files and folders in your workspace
- Toggle files/folders to include/exclude from analysis
- See excluded items marked with a closed eye icon

### Analysis Modes
Choose between two analysis modes:
- **Regular Mode**: Basic file structure and content analysis
- **AI Style**: Enhanced analysis with intelligent structure interpretation and recommendations

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

- **Toggle Exclude** (eye icon): Include/exclude files from analysis
- **Generate Report** (notebook icon): Create a new analysis report
- **Toggle AI Style** (zap/settings icon): Switch between analysis modes
- **Refresh** (refresh icon): Update the file tree view

## Settings

The extension can be configured through VS Code settings:

### Auto-Exclude Settings
- `repotxt.autoExcludeEnabled`: Enable/disable automatic file exclusion
  - Default: `true`
  - When enabled, automatically excludes common development files and folders

- `repotxt.autoExcludePatterns`: Patterns of files and folders to automatically exclude
  - Default patterns:
    ```
    node_modules
    .git
    dist
    build
    out
    coverage
    .env
    *.log
    package-lock.json
    yarn.lock
    ```
  - Supports glob patterns like `*.log`

### Git Integration
- `repotxt.respectGitignore`: Automatically exclude files listed in .gitignore
  - Default: `true`
  - When enabled, reads and respects your repository's .gitignore file

You can modify these settings in VS Code:
1. Open Settings (Ctrl/Cmd + ,)
2. Search for "Repository Analyzer"
3. Adjust settings as needed

## Requirements

- Visual Studio Code version 1.96.0 or higher
- A workspace/folder opened in VS Code

## Contributing

Feel free to submit issues and enhancement requests on the GitHub repository.

## License

This extension is licensed under the MIT License.
