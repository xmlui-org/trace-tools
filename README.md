# Regression Testing with Trace Tools

## Overview

XMLUI apps use [trace-tools](https://github.com/xmlui-org/trace-tools) to auto-generate Playwright regression tests from XMLUI inspector traces. The workflow:

1. Perform a user journey in the running app
2. Export a trace from the XMLUI inspector (Export → Download JSON)
3. Save it as a baseline
4. Before and after code changes, replay the journey and compare semantically

This works across all XMLUI apps. It has been tested on:

- **core-ssh-server-ui** — a standalone app served as static files with its own login
- **myWorkDrive-Client** — a dev-environment app run via `npm run dev` with no login required

## Standalone vs dev-environment apps

The two app types differ in how they're served, whether they require auth, and how the base URL is configured.

| | Standalone (e.g. core-ssh-server-ui) | Dev environment (e.g. myWorkDrive-Client) |
|---|---|---|
| How it runs | Static files served by an external process | `npm run dev` (Vite dev server) |
| Base URL | `http://localhost:8123/ui/` (path prefix) | `http://localhost:5173` (root) |
| Auth required | Yes — `app-config.json` describes the login flow | No — no `app-config.json` needed |
| XMLUI runtime | Checked-in JS bundle (`xmlui/0.12.0.js`) | Installed via npm, built by Vite |

For standalone apps, `app-config.json` provides both the base URL and auth configuration. For dev-environment apps, trace-tools defaults to `http://localhost:5173` and skips auth entirely.

## Directory layout

```
your-app/
├── test.sh                         # Entry point — run this
├── app-config.json                 # Auth + base URL config (only if needed)
├── traces/
│   ├── baselines/                  # Reference traces (checked in)
│   │   ├── enable-disable-user.json
│   │   └── ignore-apis.txt         # APIs to exclude from semantic comparison
│   ├── captures/                   # Output from test runs (gitignored)
│   │   └── enable-disable-user.json
│   └── fixtures/                   # Server filesystem state (checked in)
│       └── shares/Documents/       # Minimal files needed by baselines
└── trace-tools/                    # Cloned dependency (gitignored)
    ├── generate-playwright.js      # Generates .spec.ts from a baseline trace
    ├── normalize-trace.js          # Extracts steps from raw trace
    ├── compare-traces.js           # Semantic comparison (APIs, forms, nav)
    ├── summarize.js                # Journey summary
    ├── auth-setup.ts               # Playwright auth (reads app-config.json)
    ├── playwright.config.ts        # Playwright config (reads app-config.json)
    └── xs-diff.html                # Canonical inspector viewer (copied to app)
```

### What's checked in vs transient

| File | Checked in? | Purpose |
|------|-------------|---------|
| `test.sh` | Yes | App-level test runner |
| `app-config.json` | Yes (if needed) | Base URL and auth configuration |
| `traces/baselines/*.json` | Yes | Reference traces — the "known good" behavior |
| `traces/baselines/ignore-apis.txt` | Yes (if needed) | APIs to exclude from semantic comparison |
| `traces/captures/*.json` | No | Output from test runs, compared against baselines |
| `traces/fixtures/` | Yes | Server filesystem state needed by baselines |
| `trace-tools/` | No | Cloned from github.com/xmlui-org/trace-tools |

Generated test files and captured traces inside `trace-tools/` are transient — created during a run and cleaned up afterward.

## Setup

```bash
git clone https://github.com/xmlui-org/trace-tools.git
cd trace-tools
npm install
npx playwright install chromium
cd ..
```

Make sure the app is running before running tests:

- **Standalone apps**: start the app server (e.g. for core-ssh-server-ui, the app serves at `http://localhost:8123/ui/`)
- **Dev-environment apps**: run `npm run dev` (serves at `http://localhost:5173` by default)

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

## Capturing a trace

Open the XMLUI inspector in the running app and perform the user journey you want to test. When done, use the inspector's Export → Download JSON. The inspector prompts for a filename — use a descriptive name like `enable-disable-user` or `rename-file-roundtrip`. The browser saves it to your Downloads folder, e.g.:

```
~/Downloads/enable-disable-user.json
```

### Tips for good traces

- **Start from the app's root URL.** The generated test always begins at the app's root (e.g. `http://localhost:8123/ui/`). If your journey happens on a subpage like `/users`, include the navigation click (e.g. clicking "USERS" in the sidebar) as part of the trace. If you navigate to the subpage first and then start capturing, the test won't know how to get there.
- **Design roundtrip journeys.** A trace that creates a user should also delete it, so the system ends in the same state it started. Enable/disable is naturally a roundtrip. Create/delete should be captured as one journey: create a test user, then delete it. This ensures the test is repeatable — running it twice produces the same result.
- **Don't worry about being clean.** Extra clicks, hesitations, and accidental interactions are fine. The initial capture just needs to be functionally correct — hitting the right APIs, submitting the right forms, navigating the right pages. On the first passing replay, auto-update replaces the messy human capture with a clean Playwright capture (see [Opt-in chaos](#opt-in-chaos)).
- **Startup noise doesn't matter.** The trace will include initial data fetches and page render events from app startup. The normalizer ignores these and only extracts interaction steps (clicks, form submits, API calls triggered by user actions). You can use the inspector's Clear button before starting your journey if you like, but it's not necessary.
- **One journey per trace.** Keep each trace focused on a single user journey. This makes baselines easy to name, understand, and debug when a test fails.

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
  test.xlsx                          # Used by copy-paste and cut-paste tests
  xs-diff-20260127T035521.html       # Used by rename test
  foo/                               # Target folder for paste operations
    .gitkeep
```

### Why roundtrips matter for fixtures

Tests should be roundtrips: copy a file then delete the copy, move a file then move it back, create a folder then delete it. This ensures the server state is the same after the test as before. Without roundtrips, each run leaves behind artifacts (copied files, renamed files, extra folders) that cause conflicts on the next run — the app may show "File already exists" modals that block the test.

If a test flakes and the cleanup step doesn't fire (e.g. the delete after a copy), reset the fixture state before the next run.

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

✓ Traces match semantically

Before:
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis

After:
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis

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

### `./test.sh list`

Lists all available baselines with their event counts.

```bash
./test.sh list
```

```
Available baselines:
  enable-disable-user (143 events)
  create-delete-user (87 events)
```

Reads filenames from `traces/baselines/*.json`. The event count is the number of raw trace events in each file.

### `./test.sh save <trace.json> <journey-name>`

Saves an exported trace as a named baseline.

```bash
./test.sh save ~/Downloads/enable-disable-user.json enable-disable-user
```

This copies the trace file to `traces/baselines/<journey-name>.json` and prints a journey summary showing the steps, event count, and API calls. The source file (typically in `~/Downloads/`) is left unchanged.

### `./test.sh run <journey-name>`

The main command. Generates a Playwright test from a baseline, runs it, captures a new trace, and compares the two.

```bash
./test.sh run enable-disable-user
```

What happens under the hood:

1. **Generate**: `generate-playwright.js` reads `traces/baselines/<journey>.json`, normalizes the raw trace into interaction steps using `normalize-trace.js`, and emits a `.spec.ts` file with Playwright selectors derived from ARIA roles and accessible names.
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

```
--- Running: enable-disable-user ---
...
SEMANTIC: PASS

--- Running: create-delete-user ---
...
SEMANTIC: PASS

═══════════════════════════════════════════════════════════════
  Results: 2 passed, 0 failed
═══════════════════════════════════════════════════════════════
```

### `./test.sh update <journey-name>`

Promotes the latest capture to become the new baseline.

```bash
./test.sh update enable-disable-user
```

Use this when the app's behavior has intentionally changed — a new API endpoint, a different form field, an added navigation step. The capture from the most recent `run` is copied to `traces/baselines/<journey>.json`, replacing the old baseline. Commit the updated baseline.

### `./test.sh compare <journey-name>`

Runs the semantic comparison without running a test. Useful for comparing a previously captured trace against its baseline.

```bash
./test.sh compare enable-disable-user
```

Compares `traces/baselines/<journey>.json` against `traces/captures/<journey>.json`. You must have run the test at least once to have a capture.

### `./test.sh summary <journey-name>`

Prints a summary of a baseline trace — the number of steps, events, and which API endpoints are called.

```bash
./test.sh summary enable-disable-user
```

```
Journey: 10 steps, 143 events
  APIs: GET /groups, GET /license, GET /settings, GET /status, GET /users, PUT /users/elvis
```

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

## How selectors are generated

The XMLUI framework captures ARIA roles and accessible names in trace events. The test generator uses these to produce Playwright selectors:

- `getByRole('button', { name: 'Disable' })` — element has an ARIA role and accessible name
- `getByRole('link', { name: 'USERS' })` — link with text content
- `getByLabel('Name')` — form field with a label
- `getByText('elvis', { exact: true })` — fallback when no ARIA role is available

When an element lacks proper ARIA semantics, the generator emits `// ACCESSIBILITY GAP` — flagging the same problem a screen reader user would encounter. Known gaps are tracked at https://github.com/xmlui-org/trace-tools/issues.

## How semantic comparison works

The `compare` and `run` commands use `compare-traces.js` to check whether two traces represent the same behavior. It compares:

- **API calls**: Same HTTP methods and endpoint paths, in the same order (e.g. `GET /users`, `PUT /users/elvis`)
- **Form submissions**: Same number of submits with the same form data transformations
- **Navigation**: Same page transitions

It does **not** compare:

- Timing or performance
- DOM structure or CSS
- Event ordering within a single step
- Startup data fetches (initial page load API calls)

This means a refactoring that restructures components but preserves the same user-visible behavior will pass the semantic comparison.

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

## Reading the test output

A test run produces several kinds of results:

```
═══════════════════════════════════════════════════════════════
                    REGRESSION TEST: create-delete-folder-roundtrip
═══════════════════════════════════════════════════════════════

PASS — Journey completed successfully

MODALS:
  Create new folder | Create new folder
Add a folder to organize your files.
Name*
Cancel
Create
close
  Are you sure you want to delete folder "test"? | ...

VISIBLE ROWS: foo

✓ Traces match semantically
...
SEMANTIC: PASS — Same APIs, forms, and navigation
═══════════════════════════════════════════════════════════════
```

**PASS / FAIL** — Did the generated Playwright test complete? PASS means all Playwright locators resolved and all actions completed. FAIL means a selector timed out — usually because a required element is missing (wrong server state) or hasn't rendered yet (race condition).

**MODALS** — Every modal dialog that appeared during the test, with its title and content. This is always shown, and is essential for diagnosing failures — if the test times out waiting for a selector, the MODALS section often reveals what went wrong (e.g. a "Conflict: File already exists" dialog blocking the UI).

**VISIBLE ROWS** — Table rows visible at the end of the test. Helps diagnose selector failures when a test expects a file or folder that isn't present.

**SEMANTIC: PASS / FAIL** — Did the app make the same API calls? This compares the API endpoints, form submissions, and navigations between the baseline trace and the new trace. PASS means the app's behavior is unchanged. FAIL means an API call appeared or disappeared — check whether it's a real regression or a timing artifact.

**BROWSER ERRORS** — Console errors from the browser during the test. Opt-in via `--browser-errors`:

```bash
./test.sh run create-delete-folder-roundtrip --browser-errors
```

Most browser errors (400/404 from existence checks, React DOM nesting warnings) are noise, so this is off by default.

## Known limitations

- **Interleaved form interactions.** When capturing a trace, if you interact with elements behind a modal form while the form is still open (e.g. clicking a file in the background while a New Folder dialog is open, or starting a second form before submitting the first), the trace records these events chronologically — interleaved with the form's keydown events. The test generator groups form fill and submit steps together and defers background interactions to after the submit, but it cannot handle two different forms whose interactions overlap in the trace. For best results, complete one form before starting another. We aim to improve tolerance of real-world stop-and-start behavior, potentially by reconstructing fill values from keydown sequences, but for now cleaner captures produce more reliable tests.

## TBD

- **Resilience to XMLUI core rendering changes.** The test generator produces Playwright selectors from ARIA roles and accessible names captured in the trace. These depend on how the XMLUI framework renders components to the DOM — what HTML elements are used, how labels are associated with inputs, which elements get implicit ARIA roles. When the framework's rendering changes (e.g. a form input component switches from `<div>` wrappers to native `<fieldset>`, or label association moves from `htmlFor` to `aria-labelledby`), the captured trace metadata may change, breaking previously working selectors. How should trace-tools handle this? Options include: pinning traces to a framework version, detecting selector failures and falling back to alternative strategies, or decoupling the semantic comparison (which is framework-agnostic) from the Playwright test generation (which is framework-sensitive).

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

If the `.prev.json` reveals something interesting — an API call that only fires during slow human interaction, a modal that only appears when you pause between steps — that's a signal worth investigating. The chaos found it; the clean baseline wouldn't have.

### Implementation notes

Auto-update required three fixes to make captures round-trip as baselines:

1. **ARIA enrichment in `_xsLogs`** (`AppContent.tsx`). Promoted `ariaRole` and `ariaName` to top-level fields in interaction events so the normalizer extracts the same steps from captures as from inspector exports. For table rows, falls back to first `<td>` cell text since rows can be clicked anywhere.

2. **Row locators using `.filter()`** (`generate-playwright.js`). A row's accessible name is all cells concatenated, so `exact: true` never matches and substring matching is ambiguous. Row selectors use `page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })` instead.

3. **FormData fill fallback** (`generate-playwright.js`). Playwright's `.fill()` doesn't fire `keydown` events in `_xsLogs`, so captures lack textbox interactions. On submit, any formData fields not covered by textbox interactions get `fill()` calls generated from the field values.
