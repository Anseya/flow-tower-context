# Changelog

All notable changes to Flow Tower Context are documented here. The format follows Keep a Changelog and the project
uses SemVer.

## [0.66.3] — 2026-11-15

First public-release candidate (`flow-tower-context`, MIT).

### Added

- Publishable build pipeline (`npm run build:publish`) producing `dist/flow-tower-context/` with a public manifest,
  MIT license, locale metadata, detail documents and a format-1 plugin-market index.
- Portable compaction takeover as an agent preset: the bundle registers **Flow Tower (compaction memory)**, which
  mirrors the shipped `cordis` preset and replaces only the compaction provider, instead of patching the user's
  profile with absolute paths.
- Pre-release checklist (`npm run publish:check`) covering package name, license, `engines.dsh`, bundle patch,
  locale/detail files, market index and absolute-path leaks.
- Install, compatibility and publishing documents (`docs/INSTALL.md`, `docs/COMPATIBILITY.md`,
  `docs/PUBLISHING.md`) and localized detail pages (`docs/DETAIL*.md`).

### Changed

- Injection budget is reset per compaction cycle, so long sessions no longer stop injecting silently after 40
  injections.
- `/flow-tower/api/status` exposes the engine-debug summary and `sessionEngineVerified`; reference list trimmed to
  research papers plus the DSH software citation.
- READMEs rewritten as a bilingual project overview and package documentation.

### Fixed

- Checkpoint detection scans the head and tail of retained messages (long tool tails no longer hide a checkpoint).
- `/api/smart-search` missing imports (hard 500) fixed and cached.
- Hybrid retrieval is lexical-first with sparse-semantic fill, avoiding the recall regression of pure rank fusion.
