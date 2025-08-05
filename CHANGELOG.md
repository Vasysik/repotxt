# Change Log

All notable changes to the "repotxt" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.4.2] - 2025-08-05

### Fixed
- **Auto-exclude patterns**: Fixed a critical bug where patterns like `*.vsix` would only exclude files in the workspace root, but not in subdirectories. Patterns now correctly match throughout the entire repository structure.

## [0.4.0] – 2025-07-30

### Added

- **Partial File Selection for Reports**  
  You can now include only specific parts of files in the report, not just whole files.
  - Select any lines in the editor and use the "Add Selection to Report" command (or right-click context menu).
  - Files with partial selections are marked with a special badge in the tree; you can clear selections for a file with one click.
  - The generated report now shows the selected line ranges for such files.

- **Line and Character Counters**  
  - The status bar now displays the total number of lines, characters, and files that will be included in the report (taking exclusions and partial selections into account).
  - Tooltips for files and folders show line, character, and file counts (all stats respect exclusions and partial selections).
  - For partially included files and folders, stats are calculated only for the selected ranges.

## [0.3.9] – 2025-07-27

### Changed
- `media/script.js`
  - Switched from full tree re-render to targeted DOM updates.
  - Separated caches for structure vs. state; smoother UI with large repos.
  - Refactored `updateExpandedStates()` and `toggleNode()` to use the new helper and avoid duplicate code.

### Performance
- Removed global `innerHTML = ''`; only affected nodes are touched, eliminating blink and reducing GC pressure.

## [0.3.0] - 2025-07-23

### Added

-   **Webview Interface**: Introduced a modern, web-based user interface for a more interactive file browsing experience, featuring multi-select capabilities.
-   **Interface Switcher**: Added a new setting (`repotxt.interfaceType`) to allow users to choose between the modern `webview` and the traditional `treeview` interface.
-   **Advanced Selection**: The webview interface supports multi-selection of files and folders using `Ctrl/Cmd+Click` and range selection with `Shift+Click`.
-   **Dedicated Settings Command**: Added a new button in the webview toolbar to directly open the extension's settings page.

### Changed

-   **Architectural Overhaul**: The extension's codebase has been completely refactored for better modularity and maintainability.
    -   Core logic for file analysis, exclusion handling, and report generation is now centralized in `RepoAnalyzerCore`.
    -   UI components are split into a `TreeViewProvider` for the standard VS Code view and a `WebviewProvider` for the new web-based interface.


## [0.2.2] - 2025-07-20

### Fixed

- **Report Format:** Restored the original, clean report format (`File: ... Content: ...`) and fixed the folder structure generation to produce a flat list of paths instead of an indented tree.

## [0.2.0] - 2025-07-02

### Fixed

- **CRITICAL: Partial Exclusion Logic Overhaul.** The partial exclusion feature has been completely rewritten to work correctly and intuitively.
  - **Expandable Excluded Folders:** Excluded folders now correctly remain expandable, allowing users to browse their contents.
  - **Child Item Toggling:** Users can now reliably re-include specific files or sub-folders within an excluded directory.
  - **Correct Parent State:** A parent folder's icon now correctly updates to a normal "included" state if any of its children are manually included, providing proper visual feedback.
  - **Consistent Report Generation:** The report generator's logic is now perfectly synchronized with the visual tree. What you see is what you get in the final report.
  - **Toggling Parent Behavior:** Toggling a parent folder's exclusion state now correctly clears any conflicting manual rules on its children.

## [0.1.3] - 2025-07-02

### Fixed
- **Critical:** Fixed a bug where files/folders inside a manually included directory could not be excluded. Rule hierarchy is now correctly respected.

## [0.1.0] - 2025-06-29

### Added

- **Project-Specific Sessions**: The extension now saves manually included/excluded files for each project (workspace). Your choices are restored when you reopen VS Code.
- **Reset Exclusions Button**: A new "Reset" button (`clear-all` icon) has been added to the view title, allowing you to discard all manual changes and revert to the default exclusions from settings.

### Fixed

- **Core Exclusion Logic**: Completely refactored the exclusion logic to correctly prioritize manual overrides over automatic rules, fixing the bug where session choices were ignored after a restart.
- **`.gitignore` Folder Exclusion**: Fixed a critical bug where folders listed in `.gitignore` (like `dist`, `node_modules`) were not being excluded correctly.

## [Unreleased]

- Initial release
