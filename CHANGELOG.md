# Change Log

All notable changes to the "repotxt" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2025-06-29

### Added

- **Project-Specific Sessions**: The extension now saves manually included/excluded files for each project (workspace). Your choices are restored when you reopen VS Code.
- **Reset Exclusions Button**: A new "Reset" button (`clear-all` icon) has been added to the view title, allowing you to discard all manual changes and revert to the default exclusions from settings.

### Fixed

- **Core Exclusion Logic**: Completely refactored the exclusion logic to correctly prioritize manual overrides over automatic rules, fixing the bug where session choices were ignored after a restart.
- **`.gitignore` Folder Exclusion**: Fixed a critical bug where folders listed in `.gitignore` (like `dist`, `node_modules`) were not being excluded correctly.

## [0.1.3] - 2025-07-02

### Fixed
- **Critical:** Fixed a bug where files/folders inside a manually included directory could not be excluded. Rule hierarchy is now correctly respected.

## [0.2.0] - 2025-07-02

### Fixed

- **CRITICAL: Partial Exclusion Logic Overhaul.** The partial exclusion feature has been completely rewritten to work correctly and intuitively.
  - **Expandable Excluded Folders:** Excluded folders now correctly remain expandable, allowing users to browse their contents.
  - **Child Item Toggling:** Users can now reliably re-include specific files or sub-folders within an excluded directory.
  - **Correct Parent State:** A parent folder's icon now correctly updates to a normal "included" state if any of its children are manually included, providing proper visual feedback.
  - **Consistent Report Generation:** The report generator's logic is now perfectly synchronized with the visual tree. What you see is what you get in the final report.
  - **Toggling Parent Behavior:** Toggling a parent folder's exclusion state now correctly clears any conflicting manual rules on its children.

## [Unreleased]

- Initial release
