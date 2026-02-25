# Trace Event Vocabulary

The XMLUI engine emits exactly these event kinds into `_xsLogs`. They fall into two categories:

**Behavioral** — events caused by the user or server (clicked, navigated, called an API, showed a modal, emitted a toast, raised an error). These are what trace-tools consumes to generate tests and compare traces. They should never be evicted.

**Rendering** — events caused by the engine's internal state machinery (recalculated state, initialized variables, batched updates). These are high-frequency and evictable when the log hits `xsVerboseLogMax`.

When adding a new event kind to the engine, the question is: did a user or server cause it, or did the engine's internal rendering cause it? Behavioral events get preserved; rendering events get evicted.

## Event kinds

| Kind | Preserved? | Consumed by trace-tools? | Category | Notes |
|------|-----------|-------------------------|----------|-------|
| `interaction` | Yes | Yes (distiller) | Behavioral | User clicks, keydowns, context menus |
| `navigate` | Yes | Yes (distiller, comparator) | Behavioral | Route changes |
| `api:start` | Yes | Yes (distiller, generator) | Behavioral | HTTP request initiated |
| `api:complete` | Yes | Yes (distiller, comparator) | Behavioral | HTTP response received |
| `api:error` | Yes | Yes (comparator) | Behavioral | HTTP error response |
| `handler:start` | Yes | Yes (distiller, comparator) | Behavioral | Event handler begins (submit, click, etc.) |
| `handler:complete` | Yes | No | Behavioral | Event handler finishes |
| `handler:error` | Yes | No | Behavioral | Event handler throws |
| `modal:show` | Yes | Yes (distiller) | Behavioral | Confirmation dialog appears |
| `modal:confirm` | Yes | Yes (distiller, comparator) | Behavioral | User confirms dialog |
| `modal:cancel` | Yes | Yes (distiller, comparator) | Behavioral | User cancels dialog |
| `toast` | Yes | Yes (distiller) | Behavioral | Toast notification shown |
| `submenu:open` | Yes | Yes (distiller) | Behavioral | Context menu submenu opened |
| `selection:change` | Yes | Not yet | Behavioral | Table/Tree row selection changed — emits selectedItems |
| `focus:change` | Yes | Not yet | Behavioral | Tab switch, Accordion expand, NavGroup toggle |
| `emitEvent` | No | No | Behavioral | Compound component custom event — not yet consumed |
| `error:boundary` | No | No | Behavioral | React ErrorBoundary catch — not yet consumed |
| `error:runtime` | No | No | Behavioral | Runtime error — not yet consumed |
| `state:changes` | No | Yes (distiller) | Rendering | State diffs — used for DataSource assertions and formData |
| `state:part:changed` | No | No | Rendering | Single state property change |
| `state:batch:changed` | No | No | Rendering | Batched state property changes |
| `component:vars:init` | No | Yes (distiller) | Rendering | Component variable initialization |
| `component:vars:change` | No | No | Rendering | Component variable change |

## Gaps

**Preserved but not consumed:** `handler:complete`, `handler:error` — preserved in the engine but trace-tools doesn't use them yet. Harmless; they may become useful for timing analysis or error detection.

**Consumed but not preserved:** `state:changes`, `component:vars:init` — the distiller reads these for DataSource diff assertions and formData extraction, but the engine evicts them under pressure. Long journeys may lose these events, causing missing assertions. Consider either preserving them or extracting the data the distiller needs into dedicated behavioral events (e.g. `datasource:changed`).

**Not preserved, not consumed:** `emitEvent`, `error:boundary`, `error:runtime` — these are behavioral events that should arguably be preserved. `error:boundary` and `error:runtime` are especially relevant since the generated spec already collects console errors. `emitEvent` may matter for compound component testing.

## Predicted future event kinds

These don't exist yet but are predicted from XMLUI's component and interaction model. Each represents a user or server action that the test pipeline will eventually need to replay or assert. Grouped by the XMLUI capability that motivates them.

### Selection and focus

| Predicted kind | Status | Trigger | Why trace-tools will need it |
|---------------|--------|---------|------------------------------|
| `selection:change` | **Implemented** | Table `selectionDidChange`, Tree `selectionDidChange` | Generator needs to replay row/node selection for journeys that branch on what's selected. Emits `selectedItems` array with id/name. Added guard to suppress empty-selection events on mount. |
| `focus:change` | **Implemented** | Tab switch (Tabs `onValueChange`), Accordion expand, NavGroup toggle | Generator needs to know which tab/section is active. Emits `tabIndex`/`tabLabel` for Tabs, `expandedItems` for Accordion, `label`/`expanded` for NavGroup. |

### Drag and drop

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `drag:start` | User begins dragging a row, tree node, or file | Drag-and-drop reordering (List, Tree) and file upload (FileUploadDropZone) produce no trace events today. The generator can't replay them. |
| `drag:drop` | User drops onto a target | Completes the drag operation. Needed for both intra-app reordering and file upload from OS. FileUploadDropZone fires an `upload` event but it's not traced. |

### File upload

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `upload:start` | FileUploadDropZone `onUpload`, FileInput file selection | Currently a known limitation — file uploads are browser-native and invisible to traces. Even if drag-drop can't be replayed, tracing the upload event would let the comparator verify the right files were uploaded. |

### Real-time and polling

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `realtime:message` | RealTimeAdapter receives a server-sent event or WebSocket message | Apps with real-time updates (chat, notifications, live dashboards) need the test pipeline to know when server-pushed data arrived, to distinguish it from user-initiated fetches. |
| `timer:tick` | Timer fires at interval | Timer-driven UI updates (polling, auto-refresh) are invisible today. Knowing when a timer fired helps explain unexpected API calls in traces. |
| `datasource:poll` | DataSource `pollIntervalInSeconds` triggers a refetch | Similar to timer — polling DataSources fire `api:start`/`api:complete` but there's no way to tell a poll-triggered fetch from a user-triggered one. |

### Queue processing

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `queue:enqueue` | Queue `enqueueItem` / `enqueueItems` called | Batch operations (bulk import, multi-file upload) process items sequentially. Tracing enqueue/process/complete lets the comparator verify the right number of items were processed. |
| `queue:process` | Queue fires `process` event for each item | Pairs with `queue:enqueue` to trace the full batch lifecycle. |

### Component API calls

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `method:call` | App code calls a component method (e.g. `dialog.open()`, `table.getSelectedItems()`, `dataSource.refetch()`) | Currently invisible. When a handler calls `dialog.open()`, the trace shows `handler:start` but not what the handler did. Tracing method calls would close the gap between "handler ran" and "here's what it did." |

### Validation and form state

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `validation:error` | Form validation fails on submit | The comparator checks `handler:start` with `eventName === 'submit'` but can't distinguish a successful submit from one blocked by validation. Tracing validation failures would let the pipeline assert error paths. |
| `form:reset` | Form is reset to initial values | Currently invisible — a reset looks like "nothing happened" in the trace. |

### Routing and guards

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `redirect` | Redirect component fires, or auth guard redirects | Currently a `navigate` event, but the cause is lost. Knowing it was a redirect (vs user click) matters for auth-gated journeys where the test needs to distinguish "user navigated" from "app redirected." |

### Clipboard

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `clipboard:copy` | Table `onCopy` keyboard action (Ctrl+C) | Table keyboard actions (copy, cut, delete, paste) fire handler events but the clipboard content isn't traced. The generator already handles Meta+C as a keyboard shortcut but can't verify what was copied. |
| `clipboard:paste` | Table `onPaste` or FileUploadDropZone clipboard paste | Same — the paste target and content are invisible. |

---

## Current preserved set (engine)

From `inspectorUtils.ts:splicePreservingInteractions()`:

```
interaction, navigate, api:start, api:complete, api:error,
handler:start, handler:complete, modal:show, modal:confirm,
modal:cancel, toast, submenu:open, selection:change, focus:change
```

## Consumed set (trace-tools)

From `distill-trace.js`, `generate-playwright.js`, `compare-traces.js`:

```
interaction, navigate, api:start, api:complete, api:error,
handler:start, modal:show, modal:confirm, modal:cancel,
toast, submenu:open, state:changes, component:vars:init
```

## MCP-informed test apps: systematic engine extension

We proved a workflow for extending the engine's trace vocabulary that can scale to cover the full XMLUI surface area:

1. **Consult this vocabulary** to identify the next predicted event kind (e.g. `focus:change`)
2. **Ask xmlui-mcp** for the component docs and source — learn the API surface, find the hook points (onValueChange, onOpenChange, etc.)
3. **Build a minimal standalone app** in `apps/` that exercises the relevant components (Tabs, Accordion, NavGroup for focus:change; Table, Tree for selection:change)
4. **Apply the engine change** — emit the new event kind from the component's direct event handler (not useEffect — learned the hard way with selection:change firing on mount)
5. **Verify with the inspector** — the self-describing pretty view (see below) displays the new event kind automatically, no renderer changes needed
6. **Iterate** — if the event shape is wrong or noisy, the standalone app gives immediate feedback without touching the real app

Each standalone app is tiny (~30 lines of XMLUI) and targets one capability from the predicted kinds table. The apps accumulate in `apps/` as a living test suite for the trace vocabulary itself. An AI agent with access to xmlui-mcp can execute this workflow autonomously: read VOCABULARY.md for what's next, query xmlui-mcp for component APIs and source, generate the app and engine patch, verify the result. The predicted kinds table above is the backlog; the standalone apps are the proof.

This makes it feasible to systematically cover every behavioral event in XMLUI's component model — not by hand-writing each one, but by driving an informed loop: vocabulary → MCP → app → engine → verify.

### Self-describing inspector: the display fix that enables the loop

When we added `selection:change` and `focus:change` to the engine, the inspector's pretty view silently dropped them. The root cause: `renderPrettyView` in `xs-diff.html` decides whether a trace group has "content" worth showing based on `changeCount > 0 || hasError || startCount > 0` — counting only state diffs, errors, and handler:start events. A trace with only behavioral events like `focus:change` had zero content by that definition and was filtered out.

The fix avoids the "add a renderer for each new kind" trap. Instead, we defined an **infrastructure set** — the kinds that are part of the engine's internal machinery:

```
interaction, handler:start, handler:complete, handler:error,
state:changes, component:vars:init, component:vars:change,
api:start, api:complete, api:error, navigate
```

Everything *not* in that set is a **behavioral event** that the pretty view should display. The `hasContent` check now includes `behavioralEventCount > 0`, and a `componentText` fallback derives a trace title from the first behavioral event's kind + component (e.g. "focus:change Tabs").

**What this means:** any future event kind added to the engine — `drag:start`, `upload:start`, `validation:error`, whatever — will automatically appear in the inspector pretty view without touching xs-diff.html. The infrastructure set is stable (it tracks the engine's rendering pipeline, which changes rarely); the behavioral set is open-ended and self-describing. This closes the loop: the verify step in the workflow above just works for any new kind, so the agent never gets stuck on a display gap.

## Plan: config-driven preservation (not yet implemented)

The current preserved set is hardcoded in `inspectorUtils.ts:splicePreservingInteractions()`. Every time trace-tools starts consuming a new event kind, someone has to open a PR on the engine to add it to the hardcoded `Set`. This is backwards — the consumer should declare what it needs, and the engine should read that declaration.

### How it would work

1. **trace-tools exports `preserved-kinds.json`** — a flat array of event kind strings that the pipeline depends on. This file is the single source of truth. It can be auto-generated by grepping the codebase for `kind === '...'` patterns, or hand-maintained in one place (preferable since it's small and stable).

2. **The app's `config.json` gains `xsVerbosePreserveKinds`** — an array that the engine's eviction logic reads instead of its hardcoded `Set`. Apps that use trace-tools copy the list from `preserved-kinds.json` into their config. Apps that don't use trace-tools don't set it, and the engine falls back to a sensible default (preserve everything, or preserve nothing — TBD).

3. **`splicePreservingInteractions` reads from config** — instead of `const preserved = new Set(["interaction", ...])`, it reads `window.AppConfig.xsVerbosePreserveKinds` or equivalent. The hardcoded list becomes the fallback default.

### Why config, not runtime dependency

trace-tools is not a runtime dependency of the engine — it's a dev/test tool that reads traces after the fact. So trace-tools can't inject its needs at import time. The config layer is the natural interface: it's already how apps configure `xsVerbose` and `xsVerboseLogMax`.

### Migration path

1. Add `preserved-kinds.json` to trace-tools (extract from this document's consumed set)
2. Add `xsVerbosePreserveKinds` support to the engine's eviction logic, falling back to the current hardcoded set
3. Update app configs to include the list (or have `test.sh` inject it at test time)
4. Remove the hardcoded set from the engine once all apps have migrated

### What this enables

- Adding a new event kind to trace-tools means updating `preserved-kinds.json` and the app config — no engine PR
- Different apps can preserve different sets (e.g. an app using Queue preserves `queue:enqueue` while others don't)
- The vocabulary document becomes the design spec; `preserved-kinds.json` becomes the implementation
