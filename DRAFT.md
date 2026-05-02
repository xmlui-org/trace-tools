# Draft sections (not yet implemented)

These sections were moved out of README.md because they describe features that are not yet implemented.

---

## Auto-update baselines on pass (NOT YET IMPLEMENTED)

**Status: design only — not implemented in `test-base.sh`.** Currently, promoting a capture to baseline requires a manual `./test.sh update <journey>` command.

The intended behavior: when the semantic comparison passes, the capture automatically replaces the baseline. The previous baseline is saved as `<journey>.prev.json`.

The semantic comparison (API calls, form submissions, navigation) is what detects regressions. The raw trace events (event counts, timing, rendering details) vary between runs even when behavior is identical. Auto-updating on pass would mean:

- Baselines always reflect current app behavior
- `git diff` on baselines shows exactly when real behavior changed
- No manual `./test.sh update` step to forget
- The manual `update` command still exists for accepting intentional behavior changes after a semantic FAIL

### How it would work

The first baseline for any journey is a raw human capture — extra clicks, hesitations, stop-and-start behavior, background events. On the first passing replay, auto-update replaces it with a clean Playwright capture — deterministic, minimal, no human noise. This converges in one step: the first clean replay is already the stable baseline. Subsequent passes produce essentially identical captures.

The `.prev.json` would preserve the prior version. For the first auto-update, that's the original human capture:

```bash
# What changed between the human capture and the clean replay?
node trace-tools/compare-traces.js --semantic traces/baselines/rename-file-roundtrip.prev.json traces/baselines/rename-file-roundtrip.json
```

### Implementation prerequisites

Auto-update requires three fixes to make captures round-trip as baselines:

1. **ARIA enrichment in `_xsLogs`** (`AppContent.tsx`). Promoted `ariaRole` and `ariaName` to top-level fields in interaction events so the distiller extracts the same steps from captures as from inspector exports. For table rows, falls back to first `<td>` cell text since rows can be clicked anywhere.

2. **Row locators using `.filter()`** (`generate-playwright.js`). A row's accessible name is all cells concatenated, so `exact: true` never matches and substring matching is ambiguous. Row selectors use `page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })` instead.

3. **FormData fill fallback** (`generate-playwright.js`). Playwright's `.fill()` doesn't fire `keydown` events in `_xsLogs`, so captures lack textbox interactions. On submit, any formData fields not covered by textbox interactions get `fill()` calls generated from the field values.

## Opt-in chaos (NOT YET IMPLEMENTED)

**Status: design only — depends on auto-update above.**

Baselines can come from two sources: clean Playwright captures (synthetic) or messy human captures (chaotic). By default we use synthetic baselines for convenience — they're deterministic and easy to generate. But human captures introduce real-world noise: hesitations, extra clicks, stop-and-start behavior, background events that fire during pauses. This chaos is sometimes good — it exercises code paths that clean replays never hit — and sometimes bad — there's nothing to learn from a stray click.

To switch from synthetic to chaotic, capture a baseline manually in the inspector and save it:

```bash
./test.sh save ~/Downloads/rename-file-roundtrip.json rename-file-roundtrip
```

On the first passing replay, auto-update would replace the chaotic baseline with a clean one, but the `.prev.json` preserves the original. If it reveals something interesting — an API call that only fires during slow human interaction, a modal that only appears when you pause between steps — that's a signal worth investigating. The chaos found it; the clean baseline wouldn't have.

## Synthetic baselines

With AI assistance, you can create baselines by describing journeys instead of performing them. The AI generates specs, runs them, and produces baseline traces — no manual clicking required. This is useful for rapidly expanding a test suite.

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
