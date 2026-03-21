# Trace Tools: Observability and Regression Testing for XMLUI Apps

## Overview

The XMLUI engine can instrument any running app with detailed traces of interactions, API calls, state changes, and component rendering. Trace-tools makes this observability useful for humans, AIs, and automated regression tests.

**For humans:** The `xs-diff.html` viewer presents traces as a navigable timeline — click an interaction to see its API calls, state changes, handlers, and timing. Links into XMLUI sources connect runtime behavior to the code that produced it.

**For AIs:** The same traces are available as raw text and JSON — a structured record that AI tools can read, diff, and reason about without parsing DOM or screenshots.

**For regression testing:** Replay a user journey, capture a new trace, and compare semantically. Same APIs + same mutations + same navigation = the app's behavior is unchanged.

## Quick start

1. Enable tracing in your app's `config.json`:

```json
"appGlobals": {
    "xsVerbose": true,
    "xsVerboseLogMax": 200
}
```

2. Add the inspector — both files must be in the same directory:

```bash
cp trace-tools/xs-diff.html xmlui/xs-diff.html
cp trace-tools/xmlui-parser.es.js xmlui/xmlui-parser.es.js
```

3. Navigate to `/xs-diff.html` in the running app, or use the built-in `<Inspector />` component.

## Guides

### [App Developer Guide](GUIDE-APP-DEVELOPER.md)

How to make your XMLUI app observable and testable:
- Naming components with `aria-label` (static and dynamic) for semantic traces and accessibility
- Using `app:trace` (xsTrace) for structured diagnostics
- Capturing traces and sharing them with AI
- Turning a trace into a regression test

### [Component Developer Guide](GUIDE-COMPONENT-DEVELOPER.md)

How to make wrapped React components trace-friendly:
- `defaultAriaLabel` in metadata for static fallbacks
- `deriveAriaLabel` in config to pull labels from existing props
- `captureNativeEvents` for library event bridges (ECharts, Tiptap, etc.)
- The aria-label resolution cascade

### [Test Operator Guide](GUIDE-TEST-OPERATOR.md)

How to run the regression test pipeline:
- Setup, directory layout, server state
- Baseline mode (`run`) vs hand-written specs (`spec`)
- Commands: `run`, `run-all`, `spec`, `save`, `update`, `convert`
- Fixtures, auth configuration, video recording
- Reading test output and semantic comparison

## Reference

### [Trace Event Vocabulary](VOCABULARY.md)

Reference for engine contributors: every trace event kind, preservation rules, and predicted future kinds.

### [Draft Features](DRAFT.md)

Design notes for features not yet implemented: auto-update baselines, chaos testing.

## How semantic naming works

Components automatically get semantic names from props the app author already writes. The resolved name flows to the DOM (for screen readers), traces (as `ariaName`), and Playwright test selectors simultaneously.

Before:
```
[value:change] didChange TextBox "abc"
[native:click] click EChart "series0 → Q2 = 200"
[value:change] didChange Gauge "42.92"
```

After:
```
[value:change] didChange TextBox [Search...] "abc"
[native:click] click EChart [Revenue by Quarter — bar chart] "series0 → Q2 = 200"
[value:change] didChange Gauge [Gauge] "42.92"
```

The cascade resolves labels from three tiers — app author's explicit `aria-label` wins, then the wrapper's `deriveAriaLabel` (from existing props like `placeholder`, `title`, `alt`), then a static `defaultAriaLabel` in metadata. See the [App Developer Guide](GUIDE-APP-DEVELOPER.md) and [Component Developer Guide](GUIDE-COMPONENT-DEVELOPER.md) for details.
