# Trace Tools: Observability and Regression Testing for XMLUI Apps

## Table of Contents

- [Overview](#overview)
- [The XMLUI inspector and xs-diff.html](#the-xmlui-inspector-and-xs-diffhtml)
- [Regression testing](#regression-testing)
  - [Baseline mode: record, replay, compare](#baseline-mode-record-replay-compare)
  - [Spec mode: hand-written Playwright tests](#spec-mode-hand-written-playwright-tests)
- [Setup](#setup)
- [Directory layout](#directory-layout)
- [Server state: the file tree your tests need](#server-state-the-file-tree-your-tests-need)
- [Capturing a trace](#capturing-a-trace)
- [Walkthrough: capturing and testing user journeys](#walkthrough-capturing-and-testing-user-journeys)
- [Commands](#commands)
- [Video recording](#video-recording)
- [Reading the test output](#reading-the-test-output)
- [How semantic comparison works](#how-semantic-comparison-works)
- [How selectors are generated](#how-selectors-are-generated)
- [Auto-update baselines on pass](#auto-update-baselines-on-pass)
- [Opt-in chaos](#opt-in-chaos)
- [Synthetic baselines](#synthetic-baselines)
- [Opt-in app-level timing with xsTrace](#opt-in-app-level-timing-with-xstrace)
- [Standalone vs dev-environment apps](#standalone-vs-dev-environment-apps)
- [Inspector viewer (xs-diff.html)](#inspector-viewer-xs-diffhtml)
- [Fixtures: deterministic server state](#fixtures-deterministic-server-state)
- [Auth configuration](#auth-configuration)
- [Known limitations](#known-limitations)

## Overview

The XMLUI engine can optionally instrument any running app with detailed traces of interactions, API calls, state changes, and component rendering. To enable tracing, set `xsVerbose` in the app's `config.json`:

```json
"appGlobals": {
    "xsVerbose": true,
    "xsVerboseLogMax": 200
}
```

`xsVerbose` turns on the engine-level tracing; `xsVerboseLogMax` caps the number of retained log entries. Without `xsVerbose: true`, there is nothing for trace-tools to capture.

To add an in-app icon that opens the inspector in a modal:

```xml
<Icon name="cog" tooltip="Inspector" width="20px" height="20px"
      onClick="inspectorDialog.open()" />

<ModalDialog id="inspectorDialog" title="XMLUI Inspector"
             minWidth="85vw" minHeight="85vh">
  <IFrame src="xs-diff.html" width="100%" height="80vh"/>
</ModalDialog>
```

Trace-tools makes this observability useful in two ways:

**For humans:** The `xs-diff.html` viewer presents traces as a navigable timeline — click an interaction to see its API calls, state changes, handlers, and timing, with user journeys threaded from a user interaction (e.g. a button click) through to final settling of the UI. HTTP requests are correlated with their responses, and links into the relevant XMLUI sources connect runtime behavior to the code that produced it.

**For AIs:** The same traces are available as raw text and JSON — a structured record of every user journey that AI tools can read, diff, and reason about without needing to parse DOM or screenshots.

This observability is valuable on its own. You can drop `xs-diff.html` into any XMLUI app and immediately see how interactions flow through the engine, which APIs fire, how state changes, and where time is spent. Share traces with agents to turbocharge analysis and debugging.

**Regression testing** builds on this foundation. Since traces capture the semantic behavior of a user journey — which APIs were called, what forms were submitted, what pages were navigated — you can replay a journey, capture a new trace, and compare the two. If the same APIs fire in the same order with the same mutations, the app's behavior is unchanged regardless of how the internals were refactored.

**ARIA improvements** close the loop. The regression test generator produces Playwright selectors from ARIA roles and accessible names. When elements lack proper ARIA semantics, the generator flags them as accessibility gaps — the same gaps a screen reader user would encounter. Fixing these gaps improves accessibility *and* makes the tests more robust, which in turn makes the traces more informative.

## The XMLUI inspector and xs-diff.html

Every XMLUI app exposes `window._xsLogs` (interaction traces) and `window._xsSourceFiles` (component source). The `xs-diff.html` viewer reads these and presents:

- **Pretty view** — a timeline of interactions, expandable to show API calls, state changes, handler timing, and ARIA metadata. Useful for debugging, performance analysis, and understanding how a journey flows through the engine.
- **Raw view** — the full JSON trace, exportable for offline analysis or AI consumption. This is the same format used by the regression test pipeline.

To add the inspector to any XMLUI app:

```bash
cp trace-tools/xs-diff.html public/xs-diff.html
```

Then navigate to `/xs-diff.html` in the running app.

## Regression testing

Trace-tools provides two ways to test XMLUI apps: **baseline mode** (the primary workflow) and **spec mode** (for advanced cases that need hand-written assertions).

### Baseline mode: record, replay, compare

The core idea: nobody writes Playwright. You record a user journey, save its trace as a baseline, and `./test.sh run <name>` auto-generates a fresh Playwright test from it every time. The pipeline captures a new trace during replay and compares it semantically against the baseline — same APIs, same forms, same navigation means the app's behavior is unchanged.

**Who does what:**

- **A human** (or an AI) performs the journey once to create a baseline trace. This can be done by clicking through the app with the XMLUI inspector open, or by describing the journey and letting AI generate a capture script. Either way, the result is a JSON trace file saved to `traces/baselines/`.

- **The pipeline** (`distill-trace.js` → `generate-playwright.js`) reads the baseline and auto-generates a Playwright test. It extracts interaction steps (clicks, form fills, context menus), infers Playwright selectors from ARIA roles and accessible names, and inserts API response waiters to handle async timing. The generated test is ephemeral — created, run, and discarded on each invocation.

- **The comparator** (`compare-traces.js`) diffs the baseline trace against the newly captured trace. It checks that the same API endpoints were called with the same methods, the same forms were submitted, and the same pages were navigated. Cosmetic differences (timing, extra GETs from polling) are ignored.

**How to create a baseline:**

#### 1. Perform the journey in the inspector

Open the app with the XMLUI inspector, click through the journey yourself, export the trace JSON, and save it as a baseline. This is the standard workflow — it requires no tooling beyond the app itself and works for anyone. A human clicking at human speed also provides [opt-in chaos](#opt-in-chaos) — timing-dependent behavior that automated captures miss.

See [Capturing a trace](#capturing-a-trace) for details.

#### 2. Describe the journey

With AI assistance, you can skip the clicking and just describe what the journey should do:

```
Name: paste-conflict-keep-both
Journey: Multi-select two items (Meta+Click) → Copy via context menu → expand tree →
  right-click pastebox → Paste → confirm → paste again → handle conflict dialogs
  (cancel file conflict, keep-both folder conflict) → verify "foo 1" appears
Key APIs: POST /CopyFile, POST /CopyFolder
```

The AI generates a capture script, runs it, and the captured trace becomes the baseline. The capture script is disposable scaffolding — the baseline is what matters. This is useful for rapidly building out a test suite without manually performing each journey. See [Synthetic baselines](#synthetic-baselines) for a worked example.

---

**Why baseline mode is the default:** When auto-generated tests fall short, the fix is usually a small enhancement to the engine's `xsVerbose` tracing — for example, capturing modifier keys on click events or emitting ARIA metadata on table rows. Enriching the trace data fixes it for all apps and all future baselines, rather than requiring per-test Playwright workarounds. **If auto-generation can't handle a journey, please [open an issue](https://github.com/xmlui-org/trace-tools/issues)** — it likely points to a gap in the engine's tracing that should be fixed upstream.

### Spec mode: hand-written Playwright tests

For advanced scenarios where baseline mode isn't yet sufficient, you can write a Playwright spec by hand and place it in `traces/capture-scripts/<name>.spec.ts`. Run it with `./test.sh spec <name>` or run all specs with `./test.sh spec-all`.

Auto-generated tests now include assertions derived from the trace data:

- **Toast messages** — when the engine emits `kind: "toast"` events (requires engine build with toast tracing), the generator asserts toast text is visible: `await expect(page.getByText('Pasted 1 item(s), 1 skipped.')).toBeVisible()`. To add toast assertions to existing baselines: `./test.sh run <journey>` (re-captures with new engine), then `./test.sh update <journey>` (promotes capture to baseline).
- **File list changes** — the generator diffs consecutive `DataSource:fileCatalogData` snapshots. After a mutating API call (paste, delete, rename), it asserts files that appeared (`toBeVisible`) or disappeared (`toHaveCount(0)`). No engine change needed — this data is already in traces. Just `./test.sh update <journey>` to promote existing captures.

Hand-written specs are still needed for:

- **Browser-native interactions** — file uploads via drag-and-drop or OS file picker require `addInitScript` mocking that can't be derived from traces.
- **Tree item presence** — asserting that folders appear/disappear in the tree sidebar (tree structure is not yet in `state:changes`).
- **Complex conditional flows** — branching on dialog content with targeted recovery logic.
- **Targeted waits and retries** — explicit synchronization for flaky async operations.

---

This works across all XMLUI apps. It has been tested on:

- **core-ssh-server-ui** — a standalone app served as static files with its own login
- **myWorkDrive-Client** — a dev-environment app run via `npm run dev` with no login required

## Setup

```bash
git clone https://github.com/xmlui-org/trace-tools.git
cd trace-tools
npm install
npx playwright install chromium
cd ..
cp trace-tools/example-test.sh test.sh    # customize, then source test-base.sh
mkdir -p traces/baselines traces/captures
```

Your app's `test.sh` defines app-specific configuration (like `reset_fixtures()`) and then sources the shared logic from `trace-tools/test-base.sh`. See `example-test.sh` for the minimal template. This means new features (like `--video`) are automatically available to all apps when trace-tools is updated — no need to copy changes into each app's `test.sh`.

**Important:** Before running tests, set up the server's file tree from the app's fixtures. See [Server state](#server-state-the-file-tree-your-tests-need) below.

Make sure the app is running before running tests:

- **Standalone apps**: start the app server (e.g. for core-ssh-server-ui, the app serves at `http://localhost:8123/ui/`)
- **Dev-environment apps**: run `npm run dev` (serves at `http://localhost:5173` by default)

## Directory layout

### App repo: `traces/`

Each app that uses trace-tools maintains a `traces/` directory in its own repo. This is the app's test suite — all checked in except for transient outputs.

```
your-app/
├── test.sh                           # Defines reset_fixtures(), sources test-base.sh
├── app-config.json                   # Base URL + auth config (if needed)
│
└── traces/
    ├── baselines/                    # Baseline mode: reference traces
    │   ├── rename-file.json          #   One JSON per recorded journey. ./test.sh run
    │   ├── copy-paste.json           #   auto-generates a Playwright test from each,
    │   └── ignore-apis.txt           #   replays it, and compares traces semantically.
    │
    ├── capture-scripts/              # Spec mode: hand-written Playwright tests
    │   ├── navigation.spec.ts        #   One .spec.ts per test. ./test.sh spec <name>
    │   ├── file-operations.spec.ts   #   runs it directly — no baseline needed.
    │   └── upload-file.spec.ts       #   Use for assertions the generator can't yet emit.
    │
    ├── captures/                     # Output from baseline test runs (gitignored)
    │   └── rename-file.json          #   Compared against baselines by compare-traces.js
    │
    ├── videos/                       # Recorded videos from --video runs (gitignored)
    │   └── rename-file.webm          #   Playwright screen capture of each test run
    │
    └── fixtures/                     # Server filesystem state (checked in)
        ├── shares/Documents/         #   Copied to the server's data directory before
        │   ├── test.xlsx             #   each test run by reset_fixtures(). Tests expect
        │   ├── foo/                  #   these files to exist — a test that right-clicks
        │   │   ├── hello.txt         #   "test.xlsx" fails if it's not there.
        │   │   └── bar/
        │   └── pastebox/
        └── <name>.pre.sh            #   Optional per-test hook: extra pre-conditions
                                      #   beyond the base fixtures.
```

| Path | Checked in? | Purpose |
|------|-------------|---------|
| `test.sh` | Yes | App-level config + `source trace-tools/test-base.sh` |
| `app-config.json` | Yes (if needed) | Base URL and auth configuration |
| `traces/baselines/*.json` | Yes | Reference traces — the "known good" behavior |
| `traces/baselines/ignore-apis.txt` | Yes (if needed) | APIs to exclude from semantic comparison |
| `traces/capture-scripts/*.spec.ts` | Yes | Hand-written specs for advanced scenarios |
| `traces/fixtures/` | Yes | Server filesystem state needed by tests |
| `traces/fixtures/*.pre.sh` | Yes (if needed) | Per-test fixture hooks |
| `traces/captures/*.json` | No | Output from baseline runs, compared against baselines |
| `traces/videos/*.webm` | No | Recorded videos from `--video` runs |

### Trace-tools (shared dependency)

The app clones `trace-tools/` into its repo root as a subfolder (gitignored by the app). The app's `test.sh` sources `trace-tools/test-base.sh` to get the shared test commands.

```
your-app/
└── trace-tools/                  # git clone https://github.com/xmlui-org/trace-tools
    ├── test-base.sh              #   Shared test logic — sourced by app's test.sh
    ├── generate-playwright.js    #   Baseline → Playwright test generator
    ├── distill-trace.js          #   Raw trace → interaction steps
    ├── compare-traces.js         #   Semantic diff (APIs, forms, navigation)
    ├── playwright.config.ts      #   Reads app-config.json for baseURL + auth
    └── xs-diff.html              #   Inspector viewer — copy to app's public/
```

Generated test files and captured traces inside `trace-tools/` are transient — created during a run and cleaned up afterward.

## Server state: the file tree your tests need

Tests replay user journeys against a live app. If your app works with files (like a file manager), the tests expect specific files and folders to exist. A test that right-clicks `test.xlsx` will fail if `test.xlsx` isn't there.

Each app checks in a `traces/fixtures/` directory with the exact file tree needed by its baselines. **Before running tests, copy this fixture into place:**

```bash
# Example for myWorkDrive-Client (mock server reads from ~/mwd/shares/)
rm -rf ~/mwd/shares/Documents
cp -r traces/fixtures/shares/Documents ~/mwd/shares/Documents
```

The fixture for myWorkDrive-Client looks like this:

```
traces/fixtures/shares/Documents/
  test.xlsx                          # Used by copy-paste, cut-paste, and conflict tests
  xs-diff-20260127T035521.html       # Used by rename test
  foo/                               # Target folder for paste and navigation tests
    .gitkeep
    hello.txt                        # File inside foo (verifies folder contents)
    bar/                             # Nested folder for breadcrumb navigation
      .gitkeep
```

If a test fails with a selector timeout on the very first step (e.g. waiting for a row that should contain `test.xlsx`), the fixture is probably not in place.

See [Fixtures: deterministic server state](#fixtures-deterministic-server-state) for details on why roundtrip journeys matter and how to reset after a flaky run.

## Capturing a trace

Open the XMLUI inspector in the running app and perform the user journey you want to test. When done, use the inspector's Export → Download JSON. The inspector prompts for a filename — use a descriptive name like `enable-disable-user` or `rename-file-roundtrip`. The browser saves it to your Downloads folder, e.g.:

```
~/Downloads/enable-disable-user.json
```

### Tips for good traces

- **Start from the app's root URL.** The generated test always begins at the app's root (e.g. `http://localhost:8123/ui/`). If your journey happens on a subpage like `/users`, include the navigation click (e.g. clicking "USERS" in the sidebar) as part of the trace. If you navigate to the subpage first and then start capturing, the test won't know how to get there.
- **Design roundtrip journeys.** A trace that creates a user should also delete it, so the system ends in the same state it started. Enable/disable is naturally a roundtrip. Create/delete should be captured as one journey: create a test user, then delete it. This ensures the test is repeatable — running it twice produces the same result.
- **Don't worry about being clean.** Extra clicks, hesitations, and accidental interactions are fine. The initial capture just needs to be functionally correct — hitting the right APIs, submitting the right forms, navigating the right pages. On the first passing replay, auto-update replaces the messy human capture with a clean Playwright capture (see [Opt-in chaos](#opt-in-chaos)).
- **Startup noise doesn't matter.** The trace will include initial data fetches and page render events from app startup. The distiller ignores these and only extracts interaction steps (clicks, form submits, API calls triggered by user actions). You can use the inspector's Clear button before starting your journey if you like, but it's not necessary.
- **One journey per trace.** Keep each trace focused on a single user journey. This makes baselines easy to name, understand, and debug when a test fails.

## Walkthrough: capturing and testing user journeys

### Example 1: enable-disable-user (core-ssh-server-ui)

This journey navigates to USERS, selects user "elvis", disables the account, then re-enables it.

**Step 1: Capture the trace.** Start the app at `http://localhost:8123/ui/`, open the XMLUI inspector, and perform the journey. When done, use Export → Download JSON. The inspector prompts for a filename — enter `enable-disable-user`. The browser saves it to your Downloads folder:

```
~/Downloads/enable-disable-user.json
```

**Step 2: Save it as a baseline.** From the app repo root:

```bash
./test.sh save ~/Downloads/enable-disable-user.json enable-disable-user
```

This copies the trace into the baselines directory and prints a summary:

```
Saved baseline: enable-disable-user
Journey: 10 steps, 143 events
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis
```

The file is now at:

```
traces/baselines/enable-disable-user.json
```

Commit this file — it's the reference trace that future test runs compare against.

**Step 3: Run the regression test.**

```bash
./test.sh run enable-disable-user
```

This generates a Playwright test from the baseline, runs it in a browser (login is handled headlessly via `app-config.json`), captures a new trace, and compares the two semantically. The captured trace lands at:

```
traces/captures/enable-disable-user.json
```

Output:

```
═══════════════════════════════════════════════════════════════
                    REGRESSION TEST: enable-disable-user
═══════════════════════════════════════════════════════════════

PASS — Journey completed successfully

Before:
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis
  API errors: (none)
  Mutations: PUT /users/elvis ×2
  Form submits: 0 ()
  Context menus:

After:
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis
  API errors: (none)
  Mutations: PUT /users/elvis ×2
  Form submits: 0 ()
  Context menus:

SEMANTIC: PASS — Same APIs, forms, and navigation

═══════════════════════════════════════════════════════════════
```

### Example 2: rename-file-roundtrip (myWorkDrive-Client)

This journey right-clicks a file, renames it, then renames it back.

**Step 1: Capture the trace.** With `npm run dev` running, open `http://localhost:5173`, open the inspector, perform the journey. Export → Download JSON, enter `rename-file-roundtrip`:

```
~/Downloads/rename-file-roundtrip.json
```

**Step 2: Save it as a baseline.**

```bash
./test.sh save ~/Downloads/rename-file-roundtrip.json rename-file-roundtrip
```

The file is now at:

```
traces/baselines/rename-file-roundtrip.json
```

**Step 3: Run the test.** No `app-config.json` needed — no login required, base URL defaults to `http://localhost:5173`.

```bash
./test.sh run rename-file-roundtrip
```

### Building a library of baselines

Each journey you capture becomes a named baseline. Over time, the baselines directory grows into a regression test suite:

```
traces/baselines/
├── enable-disable-user.json
├── create-delete-user.json
├── create-api-key.json
├── change-password.json
└── update-settings.json
```

Run them all at once:

```bash
./test.sh run-all
```

### After refactoring

Make your code changes, then run the tests:

```bash
./test.sh run enable-disable-user
```

If the app still makes the same API calls and form submissions in the same order, you'll see SEMANTIC: PASS. If something changed (a missing API call, a different endpoint, a form field that stopped being submitted), you'll see SEMANTIC: FAIL with a diff.

### Updating a baseline

If the behavior *should* have changed (new feature, intentional API change), promote the latest capture to become the new baseline:

```bash
./test.sh update enable-disable-user
```

This copies `traces/captures/enable-disable-user.json` to `traces/baselines/enable-disable-user.json`. Commit the updated baseline.

## Commands

### `./test.sh test-all`

Runs everything — all specs, then all baselines — and reports a combined summary.

```bash
./test.sh test-all
```

```
--- Spec: navigation ---
PASS — Spec completed successfully

--- Spec: copy-paste-and-move ---
PASS — Spec completed successfully

--- Baseline: paste-conflict-keep-both ---
PASS — Journey completed successfully
SEMANTIC: PASS — Same APIs, forms, and navigation

═══════════════════════════════════════════════════════════════
  Results: 3 passed, 0 failed
═══════════════════════════════════════════════════════════════
```

Failed tests are prefixed with their mode (`spec:` or `run:`) so you can tell which kind failed.

### `./test.sh spec <name>`

Runs a hand-written Playwright spec from `traces/capture-scripts/<name>.spec.ts`. Resets fixtures first.

```bash
./test.sh spec navigation
```

No baseline is needed — the spec is the test. Use this for scenarios that require explicit assertions or complex conditional logic that the auto-generator doesn't yet handle. See [Spec mode](#spec-mode-hand-written-playwright-tests) for when this is appropriate.

### `./test.sh spec-all`

Runs every spec in `traces/capture-scripts/` and reports a summary.

```bash
./test.sh spec-all
```

### `./test.sh run <journey-name>`

Generates a Playwright test from a baseline, runs it, captures a new trace, and compares the two.

```bash
./test.sh run paste-conflict-keep-both
```

What happens under the hood:

1. **Generate**: `generate-playwright.js` reads `traces/baselines/<journey>.json`, distills the raw trace into interaction steps using `distill-trace.js`, and emits a `.spec.ts` file with Playwright selectors derived from ARIA roles and accessible names.
2. **Run**: Playwright executes the generated test. For apps with auth, a headless setup project logs in first and saves browser state. The test replays each step (clicks, form fills, waits for API responses) and captures a new trace via the XMLUI inspector.
3. **Capture**: The new trace is saved to `traces/captures/<journey>.json`.
4. **Compare**: `compare-traces.js` compares the baseline and capture semantically — same API calls (method + endpoint), same form submissions, same navigation. It ignores timing, DOM details, and event ordering differences.
5. **Clean up**: The generated `.spec.ts` file is deleted.

The exit code is 0 if the semantic comparison passes, even if a Playwright selector failed. This means accessibility gaps (elements without proper ARIA roles) don't block the regression check.

### `./test.sh run-all`

Runs every baseline in `traces/baselines/` and reports a summary.

```bash
./test.sh run-all
```

### `./test.sh list`

Lists all available specs and baselines.

```bash
./test.sh list
```

```
Spec-based tests (capture-scripts):
  navigation
  copy-paste-and-move
  file-operations

Baseline-based tests (recorded journeys):
  paste-conflict-keep-both (139 events)
  rename-file-roundtrip (87 events)
```

### `./test.sh save <trace.json> <journey-name>`

Saves an exported trace as a named baseline.

```bash
./test.sh save ~/Downloads/paste-conflict-keep-both.json paste-conflict-keep-both
```

This copies the trace file to `traces/baselines/<journey-name>.json` and prints a journey summary showing the steps, event count, and API calls. The source file (typically in `~/Downloads/`) is left unchanged.

### `./test.sh update <journey-name>`

Promotes the latest capture to become the new baseline.

```bash
./test.sh update paste-conflict-keep-both
```

Use this when the app's behavior has intentionally changed — a new API endpoint, a different form field, an added navigation step. The capture from the most recent `run` is copied to `traces/baselines/<journey>.json`, replacing the old baseline. Commit the updated baseline.

### `./test.sh compare <journey-name>`

Runs the semantic comparison without running a test. Useful for comparing a previously captured trace against its baseline.

```bash
./test.sh compare paste-conflict-keep-both
```

Compares `traces/baselines/<journey>.json` against `traces/captures/<journey>.json`. You must have run the test at least once to have a capture.

### `./test.sh summary <journey-name>`

Prints a summary of a baseline trace — the number of steps, events, and which API endpoints are called.

```bash
./test.sh summary paste-conflict-keep-both
```

```
Journey: 10 steps, 139 events
  APIs: GET /ListFolder, GET /ListShares, POST /CopyFile, POST /CopyFolder
```

## Video recording

Add `--video` to any test command to record a `.webm` video of the browser session:

```bash
./test.sh test-all --video
./test.sh spec navigation --video
./test.sh run paste-conflict-keep-both --video
```

Videos are saved to `traces/videos/<journey>.webm`. Since the tests replay real UI journeys, the videos are always in sync with the current product — re-run after a UI change and the video updates automatically.

This uses Playwright's built-in video recording. The `--video` flag sets `PLAYWRIGHT_VIDEO=on` in the environment, which `playwright.config.ts` reads.

## Reading the test output

A test run produces several kinds of results:

```
═══════════════════════════════════════════════════════════════
                    REGRESSION TEST: create-delete-folder-roundtrip
═══════════════════════════════════════════════════════════════

PASS — Journey completed successfully

MODALS:
  Create new folder | Create new folder ...
  Are you sure you want to delete folder "test"? | ...

VISIBLE ROWS: foo

Before:
  APIs: GET /ListFolder, GET /ListShares, POST /CreateFile, POST /DeleteFolder
  API errors: (none)
  Mutations: POST /CreateFile ×1, POST /DeleteFolder ×1
  Form submits: 1 (test)
  Context menus:

After:
  APIs: GET /ListFolder, GET /ListShares, POST /CreateFile, POST /DeleteFolder
  API errors: (none)
  Mutations: POST /CreateFile ×1, POST /DeleteFolder ×1
  Form submits: 1 (test)
  Context menus:

SEMANTIC: PASS — Same APIs, forms, and navigation
═══════════════════════════════════════════════════════════════
```

**PASS / FAIL** — Did the generated Playwright test complete? PASS means all Playwright locators resolved and all actions completed. FAIL means a selector timed out — usually because a required element is missing (wrong server state) or hasn't rendered yet (race condition).

**MODALS** — Every modal dialog that appeared during the test, with its title and content. This is always shown, and is essential for diagnosing failures — if the test times out waiting for a selector, the MODALS section often reveals what went wrong (e.g. a "Conflict: File already exists" dialog blocking the UI).

**VISIBLE ROWS** — Table rows visible at the end of the test. Helps diagnose selector failures when a test expects a file or folder that isn't present.

**SEMANTIC: PASS / FAIL** — Did the app behave the same way? This compares API endpoints, API errors (409/417 etc.), mutation counts (POST/PUT/DELETE per endpoint), form submissions, and navigations between the baseline and capture. PASS means all dimensions match. FAIL means something changed — a missing API call, a different number of mutations, an error path that appeared or disappeared.

**BROWSER ERRORS** — Console errors from the browser during the test. Opt-in via `--browser-errors`:

```bash
./test.sh run create-delete-folder-roundtrip --browser-errors
```

Most browser errors (400/404 from existence checks, React DOM nesting warnings) are noise, so this is off by default.

## How semantic comparison works

The `compare` and `run` commands use `compare-traces.js` to check whether two traces represent the same behavior. It compares:

- **API calls**: Same HTTP methods and endpoint paths (e.g. `GET /users`, `PUT /users/elvis`)
- **API errors**: Same set of endpoints that returned error responses (409 conflict, 417 not-empty, etc.). These are logged as `api:error` events and indicate error-handling code paths like conflict dialogs or retry logic.
- **Mutation counts**: Same number of successful POST/PUT/DELETE/PATCH calls per endpoint. A journey that deletes 2 files must always delete 2 files — not 1, not 3. GET counts are excluded because they vary with timing (refresh, polling).
- **Form submissions**: Same number of submits with the same form data transformations
- **Navigation**: Same page transitions

It does **not** compare:

- Timing or performance
- DOM structure or CSS
- Event ordering within a single step
- Startup data fetches (initial page load API calls)
- GET request counts (vary with refresh/polling)
- HTTP status codes on error responses (the XMLUI runtime logs `api:error` without the status code)

This means a refactoring that restructures components but preserves the same user-visible behavior will pass the semantic comparison. But changing the number of mutations (e.g. adding an extra delete) or introducing/removing an error path (e.g. a 409 conflict) will fail.

### Ignoring non-deterministic APIs

Some apps have background API calls that fire non-deterministically — polling endpoints, startup data fetches, or license checks that may or may not appear in a given trace depending on timing. These cause false semantic failures: the baseline trace (captured in the inspector) might not include the call, but the Playwright capture (which loads the page from scratch) does.

For example, core-ssh-server-ui has a `/license` DataSource in `Main.xmlui` that fetches on every page load:

```xml
<DataSource url="/license" id="licenseInfo" />
```

When the inspector trace was captured, the `/license` fetch had already completed before tracing began. But the Playwright test starts fresh with `page.goto('/')`, so it always captures `GET /license`. The semantic comparison sees an "extra" API and reports a failure — even though the app behaves identically.

To handle this, create `traces/baselines/ignore-apis.txt` with one endpoint per line:

```
# APIs to ignore in semantic comparison (one endpoint per line)
# These are polling/startup calls that fire non-deterministically
/license
```

The test runner reads this file and passes each entry as `--ignore-api` to `compare-traces.js`, which filters matching APIs from both traces before comparing. The match is by substring, so `/license` filters out `GET /license`, `POST /license`, etc.

The `ignore-apis.txt` file is app-specific — it lives in the app's `traces/baselines/` directory, not in trace-tools. Each app declares its own ignore list based on its background API patterns. Apps with no non-deterministic APIs don't need the file at all.

The `--ignore-api` flag can also be used directly with `compare-traces.js`:

```bash
node compare-traces.js --semantic --ignore-api /license before.json after.json
```

## How selectors are generated

The XMLUI framework captures ARIA roles and accessible names in trace events. The test generator uses these to produce Playwright selectors:

- `getByRole('button', { name: 'Disable' })` — element has an ARIA role and accessible name
- `getByRole('link', { name: 'USERS' })` — link with text content
- `getByLabel('Name')` — form field with a label
- `getByText('elvis', { exact: true })` — fallback when no ARIA role is available

When an element lacks proper ARIA semantics, the generator emits `// ACCESSIBILITY GAP` — flagging the same problem a screen reader user would encounter. Known gaps are tracked at https://github.com/xmlui-org/trace-tools/issues.

## Auto-update baselines on pass

When the semantic comparison passes, the capture automatically replaces the baseline. The previous baseline is saved as `<journey>.prev.json`.

The semantic comparison (API calls, form submissions, navigation) is what detects regressions. The raw trace events (event counts, timing, rendering details) vary between runs even when behavior is identical. Auto-updating on pass means:

- Baselines always reflect current app behavior
- `git diff` on baselines shows exactly when real behavior changed
- No manual `./test.sh update` step to forget
- The manual `update` command still exists for accepting intentional behavior changes after a semantic FAIL

### How it works

The first baseline for any journey is a raw human capture — extra clicks, hesitations, stop-and-start behavior, background events. On the first passing replay, auto-update replaces it with a clean Playwright capture — deterministic, minimal, no human noise. This converges in one step: the first clean replay is already the stable baseline. Subsequent passes produce essentially identical captures.

The `.prev.json` preserves the prior version. For the first auto-update, that's the original human capture:

```bash
# What changed between the human capture and the clean replay?
node trace-tools/compare-traces.js --semantic traces/baselines/rename-file-roundtrip.prev.json traces/baselines/rename-file-roundtrip.json
```

### Implementation notes

Auto-update required three fixes to make captures round-trip as baselines:

1. **ARIA enrichment in `_xsLogs`** (`AppContent.tsx`). Promoted `ariaRole` and `ariaName` to top-level fields in interaction events so the distiller extracts the same steps from captures as from inspector exports. For table rows, falls back to first `<td>` cell text since rows can be clicked anywhere.

2. **Row locators using `.filter()`** (`generate-playwright.js`). A row's accessible name is all cells concatenated, so `exact: true` never matches and substring matching is ambiguous. Row selectors use `page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })` instead.

3. **FormData fill fallback** (`generate-playwright.js`). Playwright's `.fill()` doesn't fire `keydown` events in `_xsLogs`, so captures lack textbox interactions. On submit, any formData fields not covered by textbox interactions get `fill()` calls generated from the field values.

## Opt-in chaos

Baselines can come from two sources: clean Playwright captures (synthetic) or messy human captures (chaotic). By default we use synthetic baselines for convenience — they're deterministic and easy to generate. But human captures introduce real-world noise: hesitations, extra clicks, stop-and-start behavior, background events that fire during pauses. This chaos is sometimes good — it exercises code paths that clean replays never hit — and sometimes bad — there's nothing to learn from a stray click.

To switch from synthetic to chaotic, capture a baseline manually in the inspector and save it:

```bash
./test.sh save ~/Downloads/rename-file-roundtrip.json rename-file-roundtrip
```

On the first passing replay, auto-update replaces the chaotic baseline with a clean one, but the `.prev.json` preserves the original. If it reveals something interesting — an API call that only fires during slow human interaction, a modal that only appears when you pause between steps — that's a signal worth investigating. The chaos found it; the clean baseline wouldn't have.

## Synthetic baselines

With AI assistance, you can create baselines by describing journeys instead of performing them. The AI generates capture scripts, runs them, and produces baseline traces — no manual clicking required. This is useful for rapidly expanding a test suite.

Suppose you have this.

```
~/myWorkDrive-Client$ ./test.sh list
Available baselines:
  copy-paste-delete-roundtrip (167 events)
  create-delete-folder-roundtrip (150 events)
  cut-paste-file-roundtrip (188 events)
  delete-nonempty-folder (200 events)
```

You want to add these.

```
Name: folder-tree-navigate
Journey: Expand tree node → click subfolder → verify file list updates → click parent → back to start
Key APIs: GET /ListFolder (multiple)
────────────────────────────────────────
Name: breadcrumb-navigate
Journey: Double-click into subfolder → double-click deeper → click breadcrumb link back to root
Key APIs: GET /ListFolder (multiple)
────────────────────────────────────────
Name: paste-conflict-replace
Journey: Copy file → paste in same parent via tree → 409 → "Replace"
Key APIs: POST /CopyFile (409 + retry)
────────────────────────────────────────
Name: delete-nonempty-folder
Journey: Create folder → copy file into it → delete folder → confirm "not empty" recursive
Key APIs: POST /CreateFile, POST /CopyFile, POST /DeleteFolder (417 + retry)
```

The system can learn how to perform and capture them, as seen in this video.

[![Watch the video](https://github.com/user-attachments/assets/cddb7cda-1804-4516-9712-5c4509b128cd)](https://jonudell.info/video/learning-to-make-synthetic-journeys.mp4)

```
~/myWorkDrive-Client$ ./test.sh list
Available baselines:
  breadcrumb-navigate (72 events)
  copy-paste-delete-roundtrip (167 events)
  create-delete-folder-roundtrip (150 events)
  cut-paste-file-roundtrip (188 events)
  delete-nonempty-folder (200 events)
  folder-tree-navigate (59 events)
  paste-conflict-keep-both (200 events)
  paste-conflict-replace (200 events)
  rename-file-roundtrip (143 events)
```

## Opt-in app-level timing with xsTrace

The Community Calendar's search felt slow on the first keystroke. With `xsTrace` instrumentation — available to any trace-tools-aware app — we quickly experimented with different approaches and cut the latency roughly in half. The first click is noticeably snappier.

The XMLUI inspector shows handler-level timing (how long `onDidChange` or `onClick` handlers take), but treats each handler as a single block. If a handler triggers reactive re-evaluation that calls multiple expensive functions, the inspector can't tell you which one is slow.

`xs-trace.js` bridges this gap. Include it in any XMLUI app:

```html
<script src="xs-trace.js"></script>
```

Then wrap expensive function calls:

```js
var _filterEvents = filterEvents;
window.filterEvents = function(events, term) {
  return window.xsTrace
    ? window.xsTrace("filterEvents", function() { return _filterEvents(events, term); })
    : _filterEvents(events, term);
};
```

Entries appear as `app:timing` in the inspector timeline alongside engine-generated `handler:start/complete` and `api:start/complete` entries.

**Implementation note:** Save a reference to the original function before overwriting `window.filterEvents`. In a non-module script, top-level function declarations *are* `window.filterEvents` — overwriting without saving causes infinite recursion.

### How it enables analysis: Community Calendar example

The Community Calendar app displays ~800 events in a virtualized List with per-keystroke search filtering. The inspector showed each keystroke taking ~859ms, but couldn't reveal where the time was spent. After wrapping `filterEvents` and `dedupeEvents` with `xsTrace`, the inspector timeline broke down each keystroke into three phases:

| Phase | Duration | What's happening |
|-------|----------|-----------------|
| `handler:start` → `state:changes` | ~200ms | Engine processes state change |
| `state:changes` → `filterEvents` | ~414ms | Reactive re-evaluation |
| `filterEvents` itself | **~2ms** | O(n) scan over ~800 events |
| `filterEvents` → `handler:complete` | ~235ms | React reconciliation |

This immediately ruled out several optimization strategies: server-side full-text search would not help (filtering is 2ms, not a bottleneck), and pre-computing the data array was unlikely to help (the reactive re-evaluation gap is engine-internal, not expression complexity). Without `xsTrace`, these would have been plausible hypotheses requiring significant implementation effort to test.

The pre-compute hypothesis was tested anyway (three iterations) and confirmed: simplifying the List `data` expression from a complex nested call to a simple `window.filterEvents(window.preparedEvents, filterTerm)` saved only ~30ms of the ~414ms reactive gap. The cost is in XMLUI's reactive infrastructure, not in evaluating the expression.

The breakdown also guided the fix. With the bottleneck identified as reactive overhead + React reconciliation (not filtering), the effective lever was reducing the List's `limit` from 100 to 50 — halving the number of virtual React elements to reconcile per keystroke. Measured result:

| Phase | limit=100 | limit=50 | Savings |
|-------|-----------|----------|---------|
| State processing | ~200ms | ~104ms | ~96ms |
| Reactive re-eval | ~414ms | ~298ms | ~116ms |
| filterEvents | ~2ms | ~2ms | 0ms |
| Reconciliation | ~235ms | ~118ms | ~117ms |
| **Total** | **859ms** | **531ms** | **328ms (38%)** |

The tradeoff — users scroll 50 events instead of 100 before needing search — is negligible when search is one click away.

The same methodology ruled out other hypotheses. Enforcing truly fixed card heights (to eliminate layout variability) showed identical reconciliation times — `fixedItemSize="true"` already handles that at the virtualizer level. Pre-computing the data array to simplify the reactive expression saved only ~30ms of a ~400ms gap.

### Component depth: isolating the real cost

With all app-level levers tested, the next question was whether the per-keystroke cost comes from the engine's base per-item overhead or from the component tree inside each item. Replacing the full EventCard (~12 child components) with a bare `<Text value="{$item.title}" />` dropped the keystroke from 531ms to 102ms — an 81% reduction.

Three data points confirm linear scaling between component count and cost:

| Template | ~Components/item | Total | Per item |
|----------|-----------------|-------|----------|
| Bare Text | 1 | 102ms | 2.0ms |
| Stripped Card (Card, VStack, Text ×4) | 6 | 240ms | 4.8ms |
| Full EventCard (+ Link, Markdown, HStack, AddToCalendar, Checkbox) | 12+ | 531ms | 10.6ms |

Every phase scales with component count — not just reconciliation:

| Phase | Text (1) | Stripped (6) | Full (12+) |
|-------|----------|-------------|------------|
| State processing | ~17ms | ~56ms | ~104ms |
| Reactive re-eval | ~51ms | ~112ms | ~298ms |
| filterEvents | ~2ms | ~2ms | ~2ms |
| Reconciliation | ~25ms | ~63ms | ~118ms |

### Engine internals: why every component pays

The XMLUI engine is **not** a signals/observables system — it's built entirely on React state with a custom expression evaluation layer. The rendering pipeline has three tiers:

1. **ContainerWrapper → StateContainer → Container** — for components with `vars`, `loaders`, `uses`, `contextVars`, `functions`, or `scriptCollected`. Assembles state through a 6-layer pipeline (parent state, reducer, APIs, context vars, two-pass local variable resolution, routing params). Each layer creates intermediate objects wrapped in `useShallowCompareMemoize`.

2. **ComponentAdapter** — for everything else (leaf components like Text, Icon, SpaceFiller). The `isContainerLike()` check in `ComponentWrapper.tsx` routes them here, skipping the 6-layer pipeline. But ComponentAdapter itself runs **~25 React hooks** per render — about 15 of which are unnecessary for simple leaves (inspector hooks, init/cleanup lifecycle, API-bound detection, sync callback lookup, action lookup, context var extraction).

3. **The renderChild instability** — `Container.tsx`'s `stableRenderChild` callback has `componentState` in its `useCallback` deps. When `filterTerm` changes, this recreates the callback, defeating `React.memo` on every list item. **All 50 items fully re-render on every keystroke** even though only the parent's `filterTerm` changed. This is intentional — callback identity is the change notification mechanism. Stabilizing it would break state propagation to children.

### XMLUI 0.12.1 regression: console.log in production

Upgrading from 0.12.0 to 0.12.1 initially showed a 3x regression (531ms → 1620ms). Comparing the two versions' source revealed 30 unconditional `console.log` calls added across the rendering pipeline (`StateContainer.tsx`, `Container.tsx`, `ComponentWrapper.tsx`, `ComponentAdapter.tsx`, etc.), firing on every render of every component. Suppressing them (`console.log = function(){};` before loading the bundle) eliminated the entire regression — 0.12.1 without logs is actually 12% *faster* than 0.12.0:

| Action | 0.12.0 | 0.12.1 (with logs) | 0.12.1 (no logs) |
|--------|--------|-------------------|-----------------|
| Search icon click | ~335ms | 1590ms | **340ms** |
| First "j" keystroke | ~531ms | 1620ms | **467ms** |

### LeafComponentAdapter: fast path for stateless components

Since React's Rules of Hooks forbid conditional hook calls, the 15 unnecessary hooks in `ComponentAdapter` can't be skipped inline. The solution: a separate `LeafComponentAdapter` component with only ~10 essential hooks (valueExtractor, layout CSS, style, registry lookup, when check, renderer call). Routed via `isLeafLike()` in `ComponentWrapper.tsx` — true for components with no user-defined events and no non-text children.

| Action | 0.12.0 | 0.12.1 (no logs) | 0.12.1 + LeafAdapter |
|--------|--------|-----------------|---------------------|
| Search icon click | ~335ms | 340ms | **313ms** |
| First "j" keystroke | ~531ms | 467ms | **439ms** |

The gains are modest (6% over 0.12.1-no-logs) because the skipped hooks are individually cheap — React's `useCallback`/`useMemo` with stable deps are near-zero cost. The remaining cost is in hooks that do real work: expression evaluation, layout resolution, style computation.

### Cumulative scorecard

| Lever | Effect on first keystroke |
|-------|--------------------------|
| Pre-compute data array | Dead end (0-6%) |
| Fixed card height | No effect (noise) |
| fixedItemSize true vs false | No effect (noise) |
| **limit 100→50** | **38% improvement (859→531ms)** |
| **0.12.1 (with log suppression)** | **12% improvement (531→467ms)** |
| **LeafComponentAdapter** | **6% improvement (467→439ms)** |
| **Combined (all three)** | **49% improvement (859→439ms)** |

Without `xsTrace`, these would all have been plausible guesses requiring significant effort to test. With it, the data pointed directly to the effective levers and ruled out the rest.

### What would move the needle further

The remaining ~439ms comes from three sources, all requiring engine changes:

1. **All 50 items re-render on every keystroke** — the `renderChild` instability defeats React.memo for all list items. An item-level re-render boundary (only re-render items whose `$item` or referenced state changed) would be the single biggest win.
2. **Hooks that do real work** — `valueExtractor` (expression evaluation), layout CSS resolution, and `useComponentStyle` involve non-trivial computation per component per render.
3. **ComponentWrapper data transforms** — four data-source transforms run for every component before the leaf/adapter branch, even when no transforms are needed.

The goal: make composition cost O(changed components), not O(total components). XMLUI's value is composability — developers should write clean, readable component trees without worrying about depth.

## Standalone vs dev-environment apps

The two app types differ in how they're served, whether they require auth, and how the base URL is configured.

| | Standalone (e.g. core-ssh-server-ui) | Dev environment (e.g. myWorkDrive-Client) |
|---|---|---|
| How it runs | Static files served by an external process | `npm run dev` (Vite dev server) |
| Base URL | `http://localhost:8123/ui/` (path prefix) | `http://localhost:5173` (root) |
| XMLUI runtime | Checked-in JS bundle (e.g. `xmlui/0.12.1.js`) | Installed via npm, built by Vite |

Either type may require auth. If it does, `app-config.json` describes the login flow (see [Auth configuration](#auth-configuration)). If not, omit the file. Auth is independent of how the app is served.

## Inspector viewer (xs-diff.html)

The XMLUI inspector viewer is a standalone HTML file (`xs-diff.html`) that displays the trace inspector UI in an iframe. It reads `window.parent._xsSourceFiles` and `window.parent._xsLogs` from the host app to show source files, interaction traces, and ARIA metadata.

The canonical copy lives in trace-tools. Each app copies it to its `public/` directory so the dev server serves it:

```bash
cp trace-tools/xs-diff.html public/xs-diff.html
```

When trace-tools updates xs-diff.html (e.g. new inspector features), downstream apps pull the update:

```bash
cd trace-tools && git pull && cd ..
cp trace-tools/xs-diff.html public/xs-diff.html
```

The app's `public/xs-diff.html` is checked in — it's part of the app's served assets. But trace-tools is the single source of truth.

## Fixtures: deterministic server state

Tests replay user journeys against a live app. If the app reads from a filesystem (e.g. a file manager backed by `~/mwd/shares/Documents/`), the tests depend on specific files and folders being present. A copy-paste test that starts by right-clicking `test.xlsx` will fail if `test.xlsx` doesn't exist.

The `traces/fixtures/` directory stores the minimal filesystem state needed by all baselines. It's checked into the repo so any developer can set up the right state:

```bash
# Reset server filesystem to the fixture state
rm -rf ~/mwd/shares/Documents
cp -r traces/fixtures/shares/Documents ~/mwd/shares/Documents
```

For myWorkDrive-Client, the fixture contains:

```
traces/fixtures/shares/Documents/
  test.xlsx                          # Used by copy-paste, cut-paste, and conflict tests
  xs-diff-20260127T035521.html       # Used by rename test
  foo/                               # Target folder for paste and navigation tests
    .gitkeep
    hello.txt                        # File inside foo (verifies folder contents)
    bar/                             # Nested folder for breadcrumb navigation
      .gitkeep
```

### Why roundtrips matter for fixtures

Tests should be roundtrips: copy a file then delete the copy, move a file then move it back, create a folder then delete it. This ensures the server state is the same after the test as before. Without roundtrips, each run leaves behind artifacts (copied files, renamed files, extra folders) that cause conflicts on the next run — the app may show "File already exists" modals that block the test.

If a test flakes and the cleanup step doesn't fire (e.g. the delete after a copy), reset the fixture state before the next run.

## Auth configuration

Apps that require login provide an `app-config.json` in the repo root. trace-tools reads this file and runs a headless Playwright setup project to log in and save browser state before the actual test runs.

```json
{
  "baseURL": "http://localhost:8123/ui/",
  "auth": {
    "fields": [
      { "locator": "getByLabel", "name": "User", "value": "admin", "method": "pressSequentially" },
      { "locator": "getByPlaceholder", "name": "Password", "value": "coressh", "method": "pressSequentially" }
    ],
    "submit": { "role": "button", "name": "Sign In" },
    "waitFor": { "url": "status" }
  }
}
```

Each field specifies a Playwright locator strategy (`getByLabel`, `getByPlaceholder`) and an input method (`fill` or `pressSequentially` for inputs that are initially readonly).

Apps that don't require login (e.g. myWorkDrive-Client) omit this file entirely. The base URL defaults to `http://localhost:5173`, or can be overridden via the `BASE_URL` environment variable.

## Known limitations

- **Interleaved form interactions.** When capturing a trace, if you interact with elements behind a modal form while the form is still open (e.g. clicking a file in the background while a New Folder dialog is open, or starting a second form before submitting the first), the trace records these events chronologically — interleaved with the form's keydown events. The test generator groups form fill and submit steps together and defers background interactions to after the submit, but it cannot handle two different forms whose interactions overlap in the trace. For best results, complete one form before starting another. We aim to improve tolerance of real-world stop-and-start behavior, potentially by reconstructing fill values from keydown sequences, but for now cleaner captures produce more reliable tests.
