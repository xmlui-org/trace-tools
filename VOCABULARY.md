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

| Predicted kind | Trigger | Why trace-tools will need it |
|---------------|---------|------------------------------|
| `selection:change` | Table `selectionDidChange`, Tree `selectionDidChange`, List selection | Generator needs to replay row/node selection for journeys that branch on what's selected. Currently inferred from `interaction` clicks but not explicitly tracked — multi-select with Shift/Ctrl is especially fragile. |
| `focus:change` | Tab switch (Tabs `activeTab`), Accordion expand, NavGroup toggle | Generator needs to know which tab/section is active. Currently invisible in traces — a tab switch produces no event unless it triggers an API call. |

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
modal:cancel, toast, submenu:open
```

## Consumed set (trace-tools)

From `distill-trace.js`, `generate-playwright.js`, `compare-traces.js`:

```
interaction, navigate, api:start, api:complete, api:error,
handler:start, modal:show, modal:confirm, modal:cancel,
toast, submenu:open, state:changes, component:vars:init
```
