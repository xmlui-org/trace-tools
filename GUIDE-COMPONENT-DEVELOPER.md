# Guide: Making Wrapped Components Trace-Friendly

When you wrap a React component for XMLUI using `wrapComponent` or `wrapCompound`, you get semantic tracing for free — `value:change`, `focus:change`, and event handler traces are emitted automatically. This guide covers how to make those traces more informative with semantic naming, and how to capture native library events.

## The basics: what you get for free

```ts
export const spinnerComponentRenderer = wrapComponent(
  COMP,
  ThemedSpinner,
  SpinnerMd,
);
```

With no config at all, this component emits traces with the component type name:

```
[value:change] didChange Spinner
```

## Add a static default label

If the component has a single obvious purpose, add `defaultAriaLabel` to the metadata. One line, every instance benefits:

```ts
export const SpinnerMd = createMetadata({
  description: "`Spinner` is an animated indicator...",
  defaultAriaLabel: "Loading",
  // ...
});
```

Now traces and screen readers say "Loading" instead of nothing:

```
screen reader: "Loading"
trace:         [value:change] didChange Spinner [Loading]
```

Good candidates for static defaults: components with a single universal purpose.

| Component | defaultAriaLabel |
|-----------|-----------------|
| Spinner | "Loading" |
| ToneChangerButton | "Toggle color mode" |
| TreeDisplay | "Tree" |
| TiptapEditor | "Rich text editor" |
| Gauge | "Gauge" |

## Derive labels from props

Most components have a prop that already describes the instance. Point `deriveAriaLabel` at it:

```ts
export const avatarComponentRenderer = wrapComponent(
  COMP,
  Avatar,
  AvatarMd,
  {
    deriveAriaLabel: (props) => props.name,
  },
);
```

When the app author writes `<Avatar name="Jane Doe" />`, the trace shows:

```
[interaction] click Avatar [Jane Doe]
```

The app author didn't write `aria-label` — the wrapper derived it from a prop they already set for functional reasons.

### Common patterns

| Component | deriveAriaLabel | What it reads |
|-----------|----------------|---------------|
| Avatar | `props.name` | "Jane Doe" |
| Image | `props.alt` | "Company logo" |
| Card | `props.title` | "Dashboard" |
| Link | `props.label` | "Settings" |
| Icon | `props.name` | "settings" |
| TextBox | `props.placeholder` | "Search..." |
| NumberBox | `props.placeholder` | "Enter amount" |

### Caution: don't derive from URL-like props

`deriveAriaLabel` should return a human-readable string, not a URL or fragment. Link's `to` prop (`"#green-section"`, `"/settings"`) is not a good label — it overrides the element's text content (which Playwright and screen readers use as the accessible name), breaking `getByRole('link', { name: 'Jump to green' })` selectors.

### Dynamic derivation for complex components

For components that wrap libraries with rich configuration (charting, editors), derive a meaningful label from the config:

```ts
export const echartComponentRenderer = wrapComponent(COMP, EChartRender, EChartMd, {
  captureNativeEvents: true,
  deriveAriaLabel: (props) => {
    const option = props.option;
    if (!option?.series) return "Chart";
    const types = [
      ...new Set(
        (Array.isArray(option.series) ? option.series : [option.series])
          .map((s: any) => s.type),
      ),
    ];
    const title = option.title?.text;
    const chartType = types.join("/") + " chart";
    return title ? `${title} — ${chartType}` : chartType;
  },
});
```

Result: `[Revenue by Quarter — bar chart]` instead of nothing on a `<canvas>`.

## The resolution cascade

The app author's explicit `aria-label` always wins. Your `deriveAriaLabel` and `defaultAriaLabel` are fallbacks:

1. `aria-label="Volume"` on the markup (app author)
2. `deriveAriaLabel(props)` (wrapper author — you)
3. `defaultAriaLabel` in metadata (wrapper author — you)
4. No label (same as before)

App authors can always override your defaults. Your defaults improve things for everyone who doesn't.

## Capture native library events

For components wrapping libraries with their own event systems (ECharts, Monaco, Tiptap), enable native event capture:

```ts
export const echartComponentRenderer = wrapComponent(COMP, EChartRender, EChartMd, {
  captureNativeEvents: true,
});
```

Then in the render component, call `onNativeEvent` with library events:

```tsx
function EChartRender({ onNativeEvent, ...props }) {
  const onEvents = useMemo(() => {
    if (!onNativeEvent) return undefined;
    const map = {};
    for (const eventName of ECHARTS_EVENTS) {
      map[eventName] = (event) => {
        onNativeEvent({
          ...event,
          type: event?.type || eventName,
          displayLabel: formatDisplayLabel(event, eventName),
        });
      };
    }
    return map;
  }, [onNativeEvent]);

  return <ReactECharts onEvents={onEvents} ... />;
}
```

The wrapper traces these automatically — including `ariaName` from the cascade:

```
[native:click] click EChart [Revenue by Quarter — bar chart] "series0 → Q2 = 200"
[native:legendselectchanged] EChart [Revenue by Quarter — bar chart] "Series 1: hidden"
```

### The displayLabel convention

When forwarding native events, include a `displayLabel` — a short human-readable string summarizing what happened:

```ts
onNativeEvent({
  ...event,
  type: eventName,
  displayLabel: `${event.seriesName} → ${event.name} = ${event.value}`,
});
```

The inspector shows `displayLabel` in the timeline. Without it, you just see the event type. With it, you see what the event *meant*.

## What you don't need to do

- **No ARIA work required.** The cascade handles it.
- **No trace API calls.** `wrapComponent` emits `value:change`, `focus:change`, and native events automatically.
- **No metadata required upfront.** Add `defaultAriaLabel` and `deriveAriaLabel` when you're ready — the component works without them.
