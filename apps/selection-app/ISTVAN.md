# Selection App — Notes for István

## Tree click overhead

Tree selection clicks show 700-1900ms of "overhead" — time between the `[interaction] click` event and when `handler:start selectionDidChange` fires. The handler itself is fast (11-50ms). Table clicks have no such gap (34-51ms total).

This suggests the Tree component's internal state reconciliation (updating `effectiveSelectedId`, rebuilding `flatTreeData`, expanding/collapsing) runs synchronously between the click and the callback. The cost scales with tree size and is visible in the trace timeline as pure "overhead."

Example from a tree click on this 11-node test tree:

```
[interaction] click "Tree" (perfTs 135372.7)
... 1852ms gap ...
[handler:start] selectionDidChange (perfTs 137224.2)
```

Worth investigating whether this can be deferred or batched.
