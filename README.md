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
│   │   └── enable-disable-user.json
│   └── captures/                   # Output from test runs (gitignored)
│       └── enable-disable-user.json
└── trace-tools/                    # Cloned dependency (gitignored)
    ├── generate-playwright.js      # Generates .spec.ts from a baseline trace
    ├── normalize-trace.js          # Extracts steps from raw trace
    ├── compare-traces.js           # Semantic comparison (APIs, forms, nav)
    ├── summarize.js                # Journey summary
    ├── auth-setup.ts               # Playwright auth (reads app-config.json)
    └── playwright.config.ts        # Playwright config (reads app-config.json)
```

### What's checked in vs transient

| File | Checked in? | Purpose |
|------|-------------|---------|
| `test.sh` | Yes | App-level test runner |
| `app-config.json` | Yes (if needed) | Base URL and auth configuration |
| `traces/baselines/*.json` | Yes | Reference traces — the "known good" behavior |
| `traces/captures/*.json` | No | Output from test runs, compared against baselines |
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

## All commands

```
./test.sh list                          # List available baselines
./test.sh save <trace.json> <journey>   # Save an exported trace as baseline
./test.sh run <journey>                 # Generate test, run it, compare
./test.sh run-all                       # Run all baselines
./test.sh update <journey>              # Promote latest capture to baseline
./test.sh compare <journey>             # Compare latest capture vs baseline
./test.sh summary <journey>             # Show journey summary
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
