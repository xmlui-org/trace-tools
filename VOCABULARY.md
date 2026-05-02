# Trace Event Vocabulary

The XMLUI engine emits these event kinds into `_xsLogs`. They fall into two categories:

**Behavioral** — events caused by the user or server (clicked, navigated, called an API, showed a modal, emitted a toast, raised an error). These are what trace-tools consumes to generate tests and compare traces. They should never be evicted.

**Rendering** — events caused by the engine's internal state machinery (recalculated state, initialized variables, batched updates). These are high-frequency and evictable when the log hits `xsVerboseLogMax`.

When adding a new event kind to the engine, the question is: did a user or server cause it, or did the engine's internal rendering cause it? Behavioral events get preserved; rendering events get evicted.

### The `displayLabel` convention

Every behavioral event should include a `displayLabel` field — a short, human-readable string that the inspector displays without needing to know the event's schema. The engine code that emits the event chooses what's informative (a tab name, a node name, an item count). The inspector just renders `displayLabel` — no per-kind field picking required.

Examples: `displayLabel: "Settings"` (Tabs), `displayLabel: "Documents"` (Tree node), `displayLabel: "3 items"` (Table multi-select).

### The `ariaName` convention

Events emitted by `wrapComponent` and `wrapCompound` include an `ariaName` field — the component's resolved `aria-label`, derived from the cascade documented in [GUIDE-COMPONENT-DEVELOPER.md](GUIDE-COMPONENT-DEVELOPER.md). The inspector displays this in brackets: `TextBox [Search...] "abc"`. Playwright test generation uses it for `getByRole` selectors.

## Event kinds

### Behavioral events (preserved)

| Kind | Consumed by trace-tools? | Notes |
|------|-------------------------|-------|
| `interaction` | Yes (distiller) | User clicks, keydowns, context menus. Includes `ariaRole` and `ariaName` from the DOM. |
| `navigate` | Yes (distiller, comparator) | Route changes |
| `api:start` | Yes (distiller, generator) | HTTP request initiated |
| `api:complete` | Yes (distiller, comparator) | HTTP response received |
| `api:error` | Yes (comparator) | HTTP error response |
| `handler:start` | Yes (distiller, comparator) | Event handler begins (submit, click, etc.) |
| `handler:complete` | No | Event handler finishes (preserved for timing analysis) |
| `handler:error` | No | Event handler throws |
| `modal:show` | Yes (distiller) | Confirmation dialog appears |
| `modal:confirm` | Yes (distiller, comparator) | User confirms dialog |
| `modal:cancel` | Yes (distiller, comparator) | User cancels dialog |
| `toast` | Yes (distiller) | Toast notification shown |
| `submenu:open` | Yes (distiller) | Context menu submenu opened |
| `selection:change` | Not yet | Table/Tree row selection changed — emits `selectedItems` |
| `focus:change` | Yes (distiller) | Tab switch, Accordion expand, NavGroup toggle; also gotFocus/lostFocus from wrapComponent |
| `value:change` | Yes (distiller, generator) | Value changed — emitted by wrapComponent/wrapCompound. Includes `ariaName`, `component`, `displayLabel`. |
| `method:call` | Yes (distiller) | Component API method invoked (e.g. `dialog.open()`, `radio.setValue('first')`). Emitted at dispatch level in `mergeComponentApis`. Includes `displayLabel` with call signature. |
| `data:bind` | Yes (comparator) | Data-bound component rendered with changed item count. Emitted by wrapComponent when a `data` prop resolves to an array with a different length. Includes `prevCount`, `rowCount`. Suppresses 0→0 on initial empty render. |
| `validation:error` | Yes (comparator) | Form validation failed on submit. Emitted by Form component when `doSubmit` detects invalid fields. Includes `errorFields` (bindTo keys) and `errorMessages`. Enables regression assertions on validation shape (error count, which fields). |
| `native:*` | Not yet | Native library events (click, legendselectchanged, hover, etc.) — emitted via `captureNativeEvents` in wrapComponent. Includes `ariaName`, `displayLabel`. |
| `app:trace` | Yes (comparator) | App-level diagnostic events emitted via xsTrace. Includes structured data and timing. |

### Rendering events (evictable)

| Kind | Consumed by trace-tools? | Notes |
|------|-------------------------|-------|
| `state:changes` | Yes (distiller, comparator) | State diffs — used for DataSource assertions, formData, and `.xs` global mutation tracking. `diffJson` contains before/after arrays for array diffs. |
| `state:part:changed` | No | Single state property change |
| `state:batch:changed` | No | Batched state property changes |
| `component:vars:init` | Yes (distiller) | Component variable initialization |
| `component:vars:change` | No | Component variable change |

## Preserved set (engine)

From `inspectorUtils.ts:splicePreservingInteractions()`:

```
interaction, navigate, api:start, api:complete, api:error,
handler:start, handler:complete, handler:error,
modal:show, modal:confirm, modal:cancel,
toast, submenu:open, selection:change, focus:change, method:call
```

Note: `value:change`, `data:bind`, and `native:*` events from wrapComponent are behavioral but not yet in the preserved set. They survive in practice because they're low-frequency relative to rendering events.

## Consumed set (trace-tools)

From `distill-trace.js`, `generate-playwright.js`, `compare-traces.js`:

```
interaction, navigate, api:start, api:complete, api:error,
handler:start, modal:show, modal:confirm, modal:cancel,
toast, submenu:open, state:changes, component:vars:init,
value:change, method:call, data:bind, app:trace
```

## Self-describing inspector

The inspector's pretty view decides whether a trace group has content worth showing. An **infrastructure set** defines the engine's internal machinery:

```
interaction, handler:start, handler:complete, handler:error,
state:changes, component:vars:init, component:vars:change,
api:start, api:complete, api:error, navigate
```

Everything *not* in that set is a behavioral event that the pretty view displays automatically. Any future event kind added to the engine appears in the inspector without touching xs-diff.html.
