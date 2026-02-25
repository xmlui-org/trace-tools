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
