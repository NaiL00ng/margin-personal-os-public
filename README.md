# MARGIN 余白 · Personal OS

English | [简体中文](README.zh-CN.md)

> In today's world, how much time do you leave for yourself?

MARGIN is an evolving web project for personal organization and bookkeeping. It aims to help people direct limited time, money, and attention toward what matters to them, connecting plans, actions, spending, and reflection.

The current development version, **0.3.0-dev.2**, provides a four-quadrant sticky-note board, a local Python + SQLite backend, legacy-record import, backup and restore, and an optional macOS launcher. The monthly life calendar, scheduling, and links to bookkeeping remain design proposals. The interface and most detailed documentation are currently in Chinese.

## Start with the local database

Download the repository source and open a terminal in the project folder. With **Python 3.9+ already available**, run:

```sh
python3 server.py
```

Open `http://127.0.0.1:4317`. The server listens only on the local machine and uses the Python standard library, including `http.server` and `sqlite3`; no third-party packages are required. A new database starts with an empty board. Records are stored in `.local/margin.sqlite3`, and backups in `.local/backups/`. Press Ctrl+C to stop the server; confirmed records remain available the next time it starts.

The **Data & Backups** dialog (`数据与备份`) previews legacy JSON before import and provides backup creation and restoration. **JSON import merges records; restoring a database backup replaces the current records**, after automatically creating a safety backup. See the [backend guide](docs/backend-guide.md).

### Optional macOS launcher

**The source download does not include `Margin.app`.** Start with the Python command above. If your Mac already has a Swift compiler, review [build_launcher.py](build_launcher.py), then build the launcher locally:

```sh
python3 build_launcher.py
```

The script installs nothing. It generates `Margin.app` in the project folder and uses `.local/launcher-build/` for build files. Then double-click the generated app to start the local server and open the board in your default browser. Keep the app in the project folder; add it to the Dock or create a Finder alias for a shortcut.

The launcher and the terminal command use the same database, so no re-import is needed. Quitting the launcher stops only a server it started itself; an existing service for the same project and database is left running. Closing the browser does not delete notes. The generated app contains machine-specific paths, is not a standalone distribution package, and must not be uploaded with the source. It is not signed with a developer distribution certificate. See the [launcher instructions](docs/backend-guide.md#图形启动器macos).

## Try the static version

Open [prototype.html](prototype.html) directly, or open [index.html](index.html) with its source files alongside it. Alternatively, run `node preview.mjs` with an existing Node.js installation. This mode uses browser `localStorage`, isolated by browser and origin, and creates four sample cards on first use. It does not automatically read or write SQLite. The Node preview and Python server use the same default port and cannot run there simultaneously.

Neither mode connects to banks or real billing data. The standalone HTML does not contain the Python backend. See the [prototype guide](docs/prototype-guide.md) for interactions and browser-storage limitations.

Current capabilities:

- Small sticky notes show a title and time value, with category and description in the detail view.
- Freely position notes within each quadrant, remember their positions, or arrange them automatically. The left column is non-urgent, the right urgent; the top row is important, the bottom non-important.
- Track each card's time in each quadrant separately. Editing pauses this time and preserves history; saving or closing the editor returns the card to the preparation area. Cancelling the editor discards only unsaved text changes.
- Archive completion and **Void** cancellation separately, inspect time shares, restore cards, and export records. Past completion and cancellation snapshots remain intact after restoration and later edits.
- Use simulated 3D hover, a held card while editing, a shake-and-shrink completion, and a burned-edge Void effect. Customize quadrant colors and choose full, reduced, or no animation, with support for the system's reduced-motion preference. Animation does not decide the business result.

**Quadrant residence time is elapsed wall-clock time, not focus or actual work time.** Several cards can accrue it simultaneously. Closing the page or server does not pause it; editing and the preparation area do, and completion or cancellation freezes it. The database mode uses server action timestamps. Whether MARGIN improves sustained habits or personal well-being remains untested.

## Documentation

Most linked documents are in Chinese.

| Topic | Document |
| --- | --- |
| Purpose, principles, and boundaries | [Product vision](docs/product/vision.md) |
| Pages, workflows, and proposed bookkeeping links | [Requirements](docs/product/requirements.md) |
| Current capabilities and possible next stages | [Roadmap](docs/product/roadmap.md) |
| Research support and untested hypotheses | [Evidence register](docs/research/evidence-register.md) |
| Existing products and opportunities for differentiation | [Product landscape](docs/research/landscape.md) |
| Cards, timing, completion, cancellation, editing, and effects | [Interaction specification](docs/design/interaction-spec.md) |
| Local operation, legacy import, backup, and restore | [Backend guide](docs/backend-guide.md) |
| Current architecture and later domain modules | [Architecture overview](docs/architecture/overview.md), [ADR 0002](docs/architecture/decisions/0002-local-sqlite-backend.md), [earlier ADR 0001](docs/architecture/decisions/0001-prototype-and-future-backend.md) |
| Completed checks and untested areas | [Validation record](docs/quality/validation.md) |
| Development, review, releases, and version preservation | [Contributing](CONTRIBUTING.md) |
| Development history and stage notes | [Changelog](CHANGELOG.md), [0.3.0 development](docs/releases/v0.3.0.md), [earlier 0.2.0 stage](docs/releases/v0.2.0.md), [earlier 0.1.0 stage](docs/releases/v0.1.0.md) |
| Personal data and credentials | [Security](SECURITY.md) |

Philosophical concepts express design values. Psychology and management research provide evidence with specific limits. Product mechanisms remain hypotheses to test. A related paper does not prove that this product works, and a non-exhaustive market review does not establish that an idea has never been tried.

## Repository layout

```text
.
├── index.html / style.css        # Page and styles
├── model.js / model.test.cjs     # State, positions, residence model, tests
├── effects.js / app.js           # Visual effects and interactions
├── storage.js / storage.test.cjs # Backend requests, retries, tests
├── server.py / backend/          # Python HTTP, SQLite store, tests
├── launcher.py / launcher/       # Service lifecycle helper, macOS UI source
├── build_launcher.py             # Builds a local app with existing Swift tools
├── build.mjs / preview.mjs       # Single-file build, local static preview
├── prototype.html / preview.jpg  # Standalone HTML, synthetic-data preview
├── .local/                       # Runtime data and backups, excluded from source
├── docs/
│   ├── product/                  # Vision, requirements, scope
│   ├── research/                 # Evidence and product landscape
│   ├── design/                   # Interaction specification
│   ├── architecture/decisions/   # Architecture and ADRs
│   ├── quality/                  # Validation records
│   └── releases/                 # Milestone notes
├── .github/                      # CI, PR/issue templates, code owners
├── VERSION / CHANGELOG.md
└── CONTRIBUTING.md / SECURITY.md
```

Frontend files retain their original paths; Python HTTP and storage modules live in `backend/`. The static build inlines six frontend source files, not Python or personal data. `.local/`, generated `Margin.app`, database files, backups, and personal exports are local artifacts and do not belong in a source upload.

## Local checks and current limits

Backend checks use Python 3.9+. Frontend checks require Node.js with the built-in `node:test` module; version 22 or newer is recommended. No npm or third-party Python packages are needed. Review the scripts before running them from the project root:

```sh
python3 -m unittest discover -s backend -p 'test_*.py' -v
python3 -m unittest launcher_test -v
node --test model.test.cjs storage.test.cjs
node build.mjs
```

The build updates `prototype.html`. Actual test runs, browser checks, and remaining gaps are recorded in the [validation record](docs/quality/validation.md). CI results apply to their specific commits; local checks do not replace a CI run for the corresponding public-repository commit.

Only database schema 1 is supported. Unknown versions are rejected; migrations for future versions are not implemented. There is no offline write queue, cross-device sync, persistent form drafts, scheduled backups, data encryption, or public account system. The server is intended for local use, not public hosting.

## Project history and license

Public repository: [NaiL00ng/margin-personal-os-public](https://github.com/NaiL00ng/margin-personal-os-public). It starts from a reviewed **0.3.0-dev.2 source snapshot**, with a new Git history. Earlier development history remains in a separate private repository and is not imported here. Public source availability does not host the application or publish personal records.

The included changelog and earlier stage notes provide development context; they do not imply that old commits, tags, pull requests, or Releases exist in this public repository. Future public changes will retain their own commit history, with tags and Releases added when actually published. Source version history is separate from user-data backups: GitHub does not automatically back up browser or SQLite records.

No open-source license has been selected. Any future licensing or permission to reuse the project will be decided separately by the owner.
