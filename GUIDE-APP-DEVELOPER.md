# Guide: Making Your XMLUI App Observable and Testable

## Enable tracing

Add to your app's `config.json`:

```json
"appGlobals": {
    "xsVerbose": true,
    "xsVerboseLogMax": 200
}
```

Add the inspector viewer:

```bash
cp trace-tools/xs-diff.html xmlui/xs-diff.html
cp trace-tools/xmlui-parser.es.js xmlui/xmlui-parser.es.js
```

Then navigate to `/xs-diff.html` in the running app, or embed the inspector in-app:

```xml
<Inspector />
```

With tracing enabled, every interaction — click, form fill, API call, state change — is captured as a semantic trace event. The inspector shows these as a navigable timeline.

## Name your components with aria-label

The single most impactful thing you can do for observability (and accessibility) is give components meaningful names via `aria-label`. Without it, traces show the component type but not which instance:

```
[value:change] didChange TextBox "abc"
[value:change] didChange TextBox "xyz"
```

Two TextBoxes, but which is which? Add `aria-label`:

```xml
<TextBox placeholder="Search events..." aria-label="Event search" />
<TextBox placeholder="Filter by name..." aria-label="Name filter" />
```

Now traces distinguish them:

```
[value:change] didChange TextBox [Event search] "abc"
[value:change] didChange TextBox [Name filter] "xyz"
```

The same label goes to screen readers, Playwright test selectors, and AI-readable traces simultaneously.

### Automatic labels from props

Many components already derive a label from props you've written. If your TextBox has `placeholder="Search events..."`, the trace shows `[Search events...]` automatically — no `aria-label` needed. This comes from the `wrapComponent` aria-label cascade:

1. Your explicit `aria-label` (always wins)
2. The wrapper's `deriveAriaLabel` (pulls from existing props like `placeholder`, `title`, `alt`, `name`)
3. The component's `defaultAriaLabel` in metadata (static fallback like "Loading" for Spinner)

You only need explicit `aria-label` when the automatic derivation doesn't say what you want, or when you want to add context beyond what any single prop carries.

### Dynamic aria-labels

`aria-label` can be a reactive expression. This is where observability gets powerful — the label describes what the component *means right now*, not just what it is:

```xml
<TextBox
  placeholder="Search events..."
  aria-label="{'Search: ' + filteredItems.length + ' of ' + allItems.length + ' results'}"
  onDidChange="{(v) => searchTerm = v}"
/>
```

Each trace entry captures the live state at the moment of interaction:

```
[focus:change] gotFocus TextBox [Search: 5 of 5 results]
[value:change] didChange TextBox [Search: 5 of 5 results] "a"
[value:change] didChange TextBox [Search: 4 of 5 results] "ab"
[value:change] didChange TextBox [Search: 0 of 5 results] "abc"
[focus:change] lostFocus TextBox [Search: 0 of 5 results]
```

The trace tells the complete story without any explicit instrumentation code. A screen reader user hears the same narrative in real time.

### When to use dynamic aria-label vs app:trace

**Dynamic `aria-label`** — for describing what a single component shows right now. One reactive expression on one component. The information flows to traces, screen readers, and test assertions simultaneously.

**`app:trace` (xsTrace)** — for structured diagnostic data about what just happened internally. Multiple dimensions, emitted from event handler code, not tied to any single component. Include the script in your app:

```html
<script src="xs-trace.js"></script>
```

Then wrap expensive or diagnostic function calls:

```js
var _filterEvents = filterEvents;
window.filterEvents = function(events, term) {
  return window.xsTrace
    ? window.xsTrace("filterEvents", function() { return _filterEvents(events, term); })
    : _filterEvents(events, term);
};
```

This emits `app:trace` events with timing and structured data that regression tests can diff across runs. See the README section [Opt-in app-level timing with xsTrace](README.md#opt-in-app-level-timing-with-xstrace) for a detailed example of how this was used to diagnose and fix a performance problem.

Rule of thumb: if you can say it in one string on one component, use `aria-label`. If you need structured data from inside handler logic, use `app:trace`.

## Capture a trace

Open the inspector in the running app and perform the user journey you want to test. When done, use Export → Download JSON. The inspector prompts for a filename — use a descriptive name like `enable-disable-user` or `rename-file-roundtrip`.

### Tips for good traces

- **Start from the app's root URL.** The generated test always begins at the app's root. If your journey happens on a subpage, include the navigation click as part of the trace.
- **Design roundtrip journeys.** A trace that creates a user should also delete it, so the system ends in the same state it started.
- **Don't worry about being clean.** Extra clicks, hesitations, and accidental interactions are fine. The distiller extracts only interaction steps.
- **One journey per trace.** Keep each trace focused on a single user journey.

## Turn a trace into a regression test

```bash
# Save trace as a baseline
./test.sh save ~/Downloads/enable-disable-user.json enable-disable-user

# Run the regression test
./test.sh run enable-disable-user

# Run all baselines
./test.sh run-all
```

The pipeline auto-generates a Playwright test from the baseline, replays it, captures a new trace, and compares semantically. Same APIs + same mutations + same navigation = PASS.

See [GUIDE-TEST-OPERATOR.md](GUIDE-TEST-OPERATOR.md) for the full regression testing workflow.

## Share traces with AI

Traces are designed to be AI-readable. Export JSON from the inspector and share it with Claude or any AI assistant. The trace contains the same semantic information a developer would get from the inspector — interactions, API calls, state changes, handler timing — in a structured format an AI can reason about without parsing DOM or screenshots.

The summarizer provides a quick human-readable overview:

```bash
node trace-tools/summarize.js --show-journey trace.json
```

```
Journey:
  click: Aria Label Catalog
  click: Settings
  click: input → TextBox [Search...]=abc
  click: canvas [Revenue by Quarter — bar chart]
```
