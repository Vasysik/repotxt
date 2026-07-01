# Change Log

All notable changes to the "repotxt" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.5.2] - 2026-07-02

### Added

* Added Material Icon Theme support for the webview file tree.
* Added local vendoring of Material Icon Theme SVG assets under `media/material-icons/`.
* Added `npm run sync:icons` to sync icon assets from the `material-icon-theme` npm package.
* Added source metadata, license, and attribution files for the vendored icon pack.

### Changed

* Reworked webview file icons to use real SVG icons from Material Icon Theme instead of custom-generated placeholder-style icons.
* Improved file and folder icon matching for common extensions, filenames, and folder names.
* Updated README with icon sync, development, packaging, and attribution instructions.

### Notes

* The webview now ships with local icon assets and does not depend on CDN access, internet access, or the user having Material Icon Theme installed in VS Code.
* Legacy TreeView behavior was not updated as part of this release.

## [0.5.0] - 2026-05-27

### Added
- **File search bar**
  - New search input above the tree finds files by name fragment across the entire workspace.
  - Excluded files are still shown in results (greyed out) so they can be re-included without scrolling.
  - Matching part of each name is highlighted; the parent directory is shown as a subtitle.
  - `Ctrl/Cmd+F` focuses search, `Esc` clears it.
- **Rich file-type icons**
  - File icons now reflect file type (JS/TS, Python, Rust, Go, HTML, CSS, JSON, Markdown, images, audio/video, archives, fonts, etc. — 150+ extensions).
  - Special names (`package.json`, `Dockerfile`, `.gitignore`, `README`, `LICENSE`, `.env`, …) get distinct glyphs.
  - Folders are tinted by purpose (`.git`, `node_modules`, `src`, `test`, `docs`, `dist`/`build`, `.vscode`, …) and switch between open/closed variants on expand.

### Fixed
- **Report line endings are normalized to LF, fixing inflated counts on Windows.** Source files checked out on Windows usually have CRLF endings. The report counted those `\r` characters, but the report document is saved with LF — so the status-bar total came out a few hundred characters larger than the saved file. The report now converts CRLF (and lone CR) to LF, so the generated text, the saved file, and the status-bar count all agree regardless of platform. This also fixes trailing-whitespace trimming, which previously did almost nothing on CRLF files (the `\r` sat between the trailing spaces and the newline, so the trim never matched). Per-file tooltips no longer count CR either.
- **Status-bar line/char totals now match the generated report exactly.** The prediction used to sum the raw line/char counts of each file and ignored everything the report actually wraps around them — the `Folder Structure:` header and its file list, the per-file `File: …` / `Content: …` prefixes, the trailing newlines, the `\n` inserted between file blocks, and the AI prompt (with `${workspaceName}` substituted). The total is now computed by mirroring the report assembly byte-for-byte, so the number shown equals the report's real length and line count. Per-file hover tooltips still show each file's own natural size.
  - If your editor trims trailing whitespace on save, the report you measure after saving could still be a few characters shorter than generated. The new `repotxt.trimTrailingWhitespace` setting (default off) makes the report itself drop trailing whitespace, so the generated output, the saved file, and the status-bar count all agree.
- **No more flicker / jumping when toggling the eye (exclude) on a file.** A state change used to trigger a full DOM teardown-and-rebuild of the tree. The webview now reconciles a refreshed tree in place: if the set of visible nodes is unchanged (the usual case for exclude/reset/toggle-all), only CSS state is patched and no element is recreated.
- **Reset now actually clears exclusions, including inside already-expanded folders.** Two causes: the webview's state cache was shadowing fresh data from the backend, and the backend only resends the top level on refresh, so deep expanded nodes kept stale flags. The tree is now authoritative, and after every refresh the webview pulls fresh state for every visible node and patches it — so nothing stays frozen and there is no need to restart VS Code.
- **Loaded subtrees no longer get dropped on refresh.** The routine that grafts previously-loaded children back onto a refreshed tree was reading the already-overwritten tree; it now reads the previous one.
- **Extension no longer hangs while loading large repositories.** Discovery of nested `.gitignore` files walked the entire tree at activation. It now reads the root ignore file first and prunes any directory that is already ignored (a big `.venv`, `vendor/`, `build/`, `target/`, etc. is skipped instead of descended), with hard caps on directory count and depth as a backstop.
- **`.gitignore` handling rewritten on top of the `ignore` npm package** (proper gitignore semantics).
  - Negation (`!pattern`), directory-only (`foo/`), root-anchored (`/dist`), and globstar (`**/foo`) patterns now work correctly.
  - Comments and trailing-whitespace edge cases handled.
  - **Nested `.gitignore` files are now discovered and applied**, with patterns re-based relative to their containing directory just like git itself does.
  - Auto-exclude patterns from settings are merged into the same engine so behaviour is consistent.
- File-stat cache was being flushed on every refresh, defeating its purpose — it is now keyed by `(path, mtime, size)` and survives refreshes, only re-reading files that actually changed on disk.

### Performance
- **Folder stats are now computed lazily** in the webview (one message per visible folder, batched on idle) instead of eagerly walking every subtree on every render. Opening the panel on a large repo is no longer blocking.
- **Selection stats no longer re-walk the workspace** on every status-bar update — they reuse the cached root-folder stats.
- **Report-size prediction is cached per file by mtime and debounced.** Computing the exact report size requires reading file contents, so results are cached per file (keyed by modification time, size, partial ranges, and the trim setting) and only changed files are re-read. A burst of refreshes (e.g. toggling several files at once) coalesces into a single recompute. After the first pass, repeated status-bar updates re-read zero files.
- **Exclusion lookups are now O(log N)** via a sorted-prefix array with binary search, replacing the previous O(N·M) scan when many manual includes/partials are present.
- **Effective-exclusion checks are memoised per refresh pass**, so a single tree render no longer re-walks ancestor chains for every node.
- **Tree updates are throttled** (80 ms coalescing window) so bursts of file-watcher events produce one refresh, not dozens.
- **Webview no longer flushes its DOM** on refresh — only changed nodes are patched, and already-expanded subtrees survive backend updates that only resend the top level.
- **Binary detection no longer reads whole large files** — files over 256 KB are scanned as a buffer for the first non-text byte instead of being loaded as UTF-8 strings.
- **`.gitignore` re-build is debounced** (200 ms) when the user is editing an ignore file, so each keystroke no longer triggers a full re-scan.
- Ancestor folder-stats caches are invalidated surgically when a single file changes, instead of clearing the entire cache.

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
