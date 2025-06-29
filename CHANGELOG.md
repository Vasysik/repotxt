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

## [Unreleased]

- Initial release
