/**
 * Distill parsed trace into essential user journey steps
 */

const { parseTrace } = require('./parse-trace');

/**
 * Resolve API method that may be an unresolved XMLUI expression.
 * The framework sometimes logs expressions like:
 *   {$queryParams.new == 'true' ? 'post' : 'put'}
 * instead of the actual HTTP method. This resolves them using
 * URL query parameters when available, or extracts the first
 * HTTP method from the expression as a fallback.
 */
function resolveMethod(method, url) {
  if (!method || typeof method !== 'string') return method;

  const clean = method.trim().toUpperCase();
  if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(clean)) {
    return clean;
  }

  // Ternary on $queryParams: {$queryParams.foo == 'bar' ? 'post' : 'put'}
  const ternaryMatch = method.match(
    /\{\$queryParams\.(\w+)\s*==\s*'([^']+)'\s*\?\s*'(\w+)'\s*:\s*'(\w+)'\s*\}/
  );
  if (ternaryMatch) {
    const [, paramName, paramValue, trueMethod, falseMethod] = ternaryMatch;
    if (url) {
      try {
        const urlObj = new URL(url, 'http://localhost');
        const paramVal = urlObj.searchParams.get(paramName);
        // Only use the URL to resolve if the param is actually present;
        // $queryParams refers to the page URL, not the API endpoint URL.
        if (paramVal !== null) {
          return (paramVal === paramValue ? trueMethod : falseMethod).toUpperCase();
        }
      } catch (e) { /* fall through */ }
    }
    // Param not in API URL — try heuristic: if the ternary checks for 'new'/'true'
    // and the URL has a resource identifier (e.g. /api/users/elvis vs /api/users),
    // the presence of an ID suggests edit (false branch), absence suggests create (true branch).
    if (paramName === 'new' && paramValue === 'true' && url) {
      // Count path segments after the base resource — if there's an ID, it's an edit
      const pathParts = url.replace(/\?.*/, '').split('/').filter(Boolean);
      // e.g. ['api', 'users', 'elvis'] has 3 parts vs ['api', 'users'] has 2
      if (pathParts.length > 2) {
        return falseMethod.toUpperCase(); // edit → put
      }
      return trueMethod.toUpperCase(); // create → post
    }
    // Generic fallback: return the first method from the expression
    return trueMethod.toUpperCase();
  }

  // Generic fallback: extract the first HTTP verb from the expression
  const verbMatch = method.match(/\b(get|post|put|delete|patch|head|options)\b/i);
  if (verbMatch) {
    return verbMatch[1].toUpperCase();
  }

  return method;
}

/**
 * Extract a display label from a DataSource item object.
 * Tries common label field names first, then falls back to the first
 * short string field. Returns null if no suitable label is found.
 */
function itemLabel(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['name', 'title', 'label', 'displayName', 'username']) {
    if (typeof obj[key] === 'string' && obj[key].length > 0) return obj[key];
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 80) return v;
  }
  return null;
}

function distillTrace(traces) {
  const steps = [];

  // Sort traces by first event's perfTs to get chronological order
  const sortedTraces = [...traces].sort((a, b) => {
    const aTs = a.events[0]?.perfTs || 0;
    const bTs = b.events[0]?.perfTs || 0;
    return aTs - bTs;
  });

  for (const trace of sortedTraces) {
    const step = extractStep(trace);
    if (step) {
      steps.push(step);
    }
  }

  return { steps };
}

function extractStep(trace) {
  // Find the primary interaction event
  const interaction = trace.events.find(e => e.kind === 'interaction');
  if (!interaction && !trace.summary.includes('Startup')) {
    return null; // Skip traces without user interaction (message listeners, etc.)
  }

  // Handle startup specially
  if (trace.summary.includes('Startup')) {
    return extractStartupStep(trace);
  }

  const step = {
    action: interaction.action,
    target: inferTarget(trace, interaction),
    await: extractAwaitConditions(trace)
  };

  // Extract modal events from text-format traces
  const modals = extractModals(trace.events);
  if (modals.length > 0) {
    step.modals = modals;
  }

  return step;
}

function extractStartupStep(trace) {
  const apiCalls = trace.events
    .filter(e => e.kind === 'api:complete' && e.method && e.endpoint)
    .map(e => ({ method: resolveMethod(e.method, e.endpoint), endpoint: e.endpoint }));

  // Dedupe by method+endpoint
  const uniqueApis = [];
  const seen = new Set();
  for (const api of apiCalls) {
    const key = `${api.method} ${api.endpoint}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueApis.push(api);
    }
  }

  const stateInits = trace.events
    .filter(e => e.kind === 'state:changes' || e.kind === 'component:vars:init')
    .map(e => e.stateName)
    .filter(Boolean);

  return {
    action: 'startup',
    await: {
      api: uniqueApis,
      state: [...new Set(stateInits)]
    }
  };
}

function inferTarget(trace, interaction) {
  const target = {
    component: interaction.target,
    label: null,
    selector: null
  };

  // Look at handler args for semantic info
  const handlerStart = trace.events.find(e => e.kind === 'handler:start' && (e.args || e.displayName || e.itemName));
  if (handlerStart) {
    // Check for extracted displayName (from truncated JSON)
    if (handlerStart.displayName) {
      target.label = handlerStart.displayName;
      target.selector = { role: 'treeitem', name: handlerStart.displayName };
    }

    // Check for extracted itemName
    if (handlerStart.itemName && !target.label) {
      target.label = handlerStart.itemName;
    }

    // Check parsed args object
    if (handlerStart.args) {
      const args = Array.isArray(handlerStart.args) ? handlerStart.args[0] : handlerStart.args;

      // Tree node info
      if (args?.displayName && !target.label) {
        target.label = args.displayName;
        target.selector = { role: 'treeitem', name: args.displayName };
      }

      // Item info (for tiles, etc.)
      if (args?.name && !target.label) {
        target.label = args.name;
      }

      // Path info
      if (args?.path) {
        target.path = args.path;
      }
    }
  }

  // Look at state changes to infer target
  const stateChange = trace.events.find(e => e.kind === 'state:changes' && e.changes);
  if (stateChange?.changes) {
    for (const change of stateChange.changes) {
      // selectedIds change tells us what was selected
      const selectedMatch = change.match(/selectedIds:.*→\s*\["([^"]+)"\]/);
      if (selectedMatch) {
        const path = selectedMatch[1];
        const name = path.split('/').pop();
        if (!target.label) {
          target.label = name;
        }
        target.selectedPath = path;
      }
    }
  }

  // For menu items, the interaction target is usually the semantic label
  // But only if we haven't already found a better label from state changes/args
  // and the target looks like a user-visible label (not a component type)
  const isGenericComponentName = /^[A-Z][a-z]+[A-Z]|^(HStack|VStack|Tree|Stack|Box|Link|Text)$/.test(interaction.target);
  if (!target.label && interaction.target && !isGenericComponentName) {
    target.label = interaction.target;
    // Assume it's a menu item if it's a click on a named item
    if (interaction.action === 'click') {
      target.selector = { role: 'menuitem', name: interaction.target };
    }
  }

  return target;
}

function extractAwaitConditions(trace) {
  const conditions = {};

  // API calls
  const apiCalls = trace.events
    .filter(e => e.kind === 'api:complete' || e.kind === 'api:start')
    .map(e => ({
      method: e.method,
      endpoint: e.endpoint,
      status: e.status
    }))
    .filter(a => a.method);

  if (apiCalls.length > 0) {
    conditions.api = apiCalls;
  }

  // Navigation
  const navigate = trace.events.find(e => e.kind === 'navigate');
  if (navigate) {
    conditions.navigate = {
      from: navigate.from,
      to: navigate.to
    };
  }

  // State changes
  const stateChanges = trace.events
    .filter(e => e.kind === 'state:changes' && e.changes)
    .flatMap(e => e.changes || []);

  if (stateChanges.length > 0) {
    conditions.state = stateChanges;
  }

  return Object.keys(conditions).length > 0 ? conditions : undefined;
}

/**
 * Distill raw JSON logs from window._xsLogs (captured by Playwright)
 */
function distillJsonLogs(logs) {
  // Build a global modifier-key timeline from all keydown/keyup interaction events.
  // This is needed because Table row clicks are captured in a separate traceId from
  // the keydown event for the modifier key (e.g. Ctrl), so we can't see the modifier
  // inside the click's own trace group. We resolve it via perfTs proximity instead.
  const MODIFIER_KEYS = { Control: 'Control', Meta: 'Meta', Shift: 'Shift', Alt: 'Alt' };
  const modifierTimeline = []; // { perfTs, key, active }
  for (const log of logs) {
    if (log.kind !== 'interaction') continue;
    const action = log.interaction || log.eventName;
    if (action !== 'keydown' && action !== 'keyup') continue;
    const key = (log.detail || {}).key;
    if (!MODIFIER_KEYS[key]) continue;
    modifierTimeline.push({ perfTs: log.perfTs || 0, key, active: action === 'keydown' });
  }
  modifierTimeline.sort((a, b) => a.perfTs - b.perfTs);

  // Returns the set of modifier keys active at a given perfTs.
  // A modifier is considered "active" if its keydown occurred within
  // MAX_MODIFIER_HOLD_MS before perfTs and no keyup has cleared it.
  // The time cap prevents a missing keyup from leaking the modifier
  // into all subsequent steps indefinitely.
  const MAX_MODIFIER_HOLD_MS = 500;
  function getActiveModifiers(perfTs) {
    const active = new Set();
    const lastKeydownTs = new Map(); // key → perfTs of most recent keydown
    for (const entry of modifierTimeline) {
      if (entry.perfTs > perfTs) break;
      if (entry.active) {
        active.add(entry.key);
        lastKeydownTs.set(entry.key, entry.perfTs);
      } else {
        active.delete(entry.key);
        lastKeydownTs.delete(entry.key);
      }
    }
    // Remove modifiers whose keydown was too far in the past (key was likely
    // released but the keyup event was not captured in the trace).
    for (const key of [...active]) {
      if (perfTs - (lastKeydownTs.get(key) || 0) > MAX_MODIFIER_HOLD_MS) {
        active.delete(key);
      }
    }
    return [...active];
  }

  // Group logs by traceId
  const traces = new Map();

  for (const log of logs) {
    const traceId = log.traceId || 'unknown';
    if (!traces.has(traceId)) {
      traces.set(traceId, {
        traceId,
        events: [],
        firstPerfTs: log.perfTs || 0
      });
    }
    traces.get(traceId).events.push(log);
  }

  // Convert to array and sort by first event time
  const traceArray = Array.from(traces.values())
    .sort((a, b) => a.firstPerfTs - b.firstPerfTs);

  // Convert each trace group to distilled step format
  const steps = [];

  for (const trace of traceArray) {
    const step = extractStepFromJsonLogs(trace);
    if (step) {
      // If click/dblclick has no modifiers in its detail, infer from global timeline.
      // Table row clicks are captured in a separate traceId from the keydown event
      // for the modifier key (e.g. Ctrl), so we resolve via perfTs proximity.
      if ((step.action === 'click' || step.action === 'dblclick') &&
          !step.target?.ctrlKey && !step.target?.metaKey &&
          !step.target?.shiftKey && !step.target?.altKey) {
        const activeMods = getActiveModifiers(trace.firstPerfTs);
        if (activeMods.length > 0) {
          if (!step.target) step.target = {};
          if (activeMods.includes('Control')) step.target.ctrlKey = true;
          if (activeMods.includes('Meta')) step.target.metaKey = true;
          if (activeMods.includes('Shift')) step.target.shiftKey = true;
          if (activeMods.includes('Alt')) step.target.altKey = true;
        }
      }
      steps.push(step);
    }
  }

  // Diff consecutive DataSource array snapshots to detect items added or
  // removed by mutating operations. Only attach to steps that have mutating
  // API calls (POST/PUT/DELETE/PATCH) — navigation-only changes are not
  // assertion-worthy.
  const prevSnapshots = {}; // DataSource path → [labels]
  for (const step of steps) {
    if (step._dataSourceSnapshots) {
      const hasMutation = step.await?.api?.some(a =>
        ['POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method)
      );

      for (const [dsPath, labels] of Object.entries(step._dataSourceSnapshots)) {
        if (prevSnapshots[dsPath] && hasMutation) {
          const prevSet = new Set(prevSnapshots[dsPath]);
          const currSet = new Set(labels);
          const added = labels.filter(l => !prevSet.has(l));
          const removed = prevSnapshots[dsPath].filter(l => !currSet.has(l));

          if (added.length > 0 || removed.length > 0) {
            if (!step.dataSourceChanges) step.dataSourceChanges = [];
            step.dataSourceChanges.push({ source: dsPath, added, removed });
          }
        }
        prevSnapshots[dsPath] = labels;
      }
      delete step._dataSourceSnapshots;
    }
  }

  // Dedupe: if we have click + click + dblclick on same target, keep only dblclick
  const deduped = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    const nextNext = steps[i + 2];

    // Check for click + click + dblclick pattern
    if (step.action === 'click' && next?.action === 'click' && nextNext?.action === 'dblclick' &&
        step.target?.testId === next.target?.testId && step.target?.testId === nextNext.target?.testId) {
      // Skip the two clicks, keep the dblclick
      deduped.push(nextNext);
      i += 2; // Skip next two
    } else {
      deduped.push(step);
    }
  }

  return { steps: deduped };
}

function extractStepFromJsonLogs(trace) {
  const events = trace.events;

  // Find interaction event
  const interaction = events.find(e => e.kind === 'interaction');

  // Handle startup (no interaction, starts with startup- traceId)
  if (!interaction && trace.traceId?.startsWith('startup-')) {
    const apiCalls = events
      .filter(e => e.kind === 'api:complete' && e.method)
      .map(e => ({ method: resolveMethod(e.method, e.url || e.endpoint), endpoint: e.url || e.endpoint }));
    return {
      action: 'startup',
      await: { api: apiCalls }
    };
  }

  if (!interaction) {
    // Toast-only trace groups (triggered by message handlers, not direct clicks)
    const toastEvents = events.filter(e => e.kind === 'toast');
    if (toastEvents.length > 0) {
      return {
        action: 'toast',
        toasts: toastEvents.map(e => ({ type: e.toastType || 'default', message: e.message }))
      };
    }
    return null; // Skip non-interaction traces (message handlers, etc.)
  }

  // Skip inspector UI interactions — not part of user journey
  if (interaction.componentLabel === 'XMLUI Inspector' ||
      interaction.componentType === 'XSInspector' ||
      (interaction.detail?.text || '').includes('XMLUI Inspector')) {
    return null;
  }

  const target = {
    component: interaction.componentType || interaction.componentLabel,
    label: null
  };

  // Capture targetTag for better selector generation
  if (interaction.detail?.targetTag) {
    target.targetTag = interaction.detail.targetTag;
  }

  // Capture selectorPath if available (Playwright-ready selector)
  if (interaction.detail?.selectorPath) {
    target.selectorPath = interaction.detail.selectorPath;
  }

  // Capture keyboard modifiers for multi-select clicks (Ctrl+Click, Shift+Click, Option/Alt+Click)
  if (interaction.detail?.ctrlKey) target.ctrlKey = true;
  if (interaction.detail?.shiftKey) target.shiftKey = true;
  if (interaction.detail?.metaKey) target.metaKey = true;
  if (interaction.detail?.altKey) target.altKey = true;

  // Capture ARIA role and accessible name for Playwright getByRole selectors
  if (interaction.detail?.ariaRole) {
    target.ariaRole = interaction.detail.ariaRole;
  }
  if (interaction.detail?.ariaName) {
    target.ariaName = interaction.detail.ariaName;
  }

  // Capture testId (uid) as fallback selector when ARIA isn't available
  if (interaction.uid) {
    target.testId = interaction.uid;
  }

  // Extract label from interaction detail
  // But skip overly long labels (modal content) in favor of shorter text
  if (interaction.detail?.text) {
    const text = interaction.detail.text;
    if (text.length < 50) {
      target.label = text;
    }
  }

  // Look at handler args
  const handlerStart = events.find(e => e.kind === 'handler:start' && (e.args || e.eventArgs));
  if (handlerStart) {
    const args = handlerStart.eventArgs?.[0] ||
                 (Array.isArray(handlerStart.args) ? handlerStart.args[0] : handlerStart.args);
    if (args?.displayName) {
      target.label = args.displayName;
      target.selector = { role: 'treeitem', name: args.displayName };
    }
    // Capture form data for form submit handlers
    if (handlerStart.eventName === 'submit' && args) {
      target.formData = args;
    }
  }

  // Fallback: if no submit handler emitted formData, check for a mutating API
  // call with a body (the form data is in the request body).
  if (!target.formData) {
    const mutatingApi = events.find(e =>
      e.kind === 'api:start' && e.body && typeof e.body === 'object' &&
      ['POST', 'PUT', 'PATCH'].includes(resolveMethod(e.method, e.url)?.toUpperCase())
    );
    if (mutatingApi?.body) {
      target.formData = mutatingApi.body;
    }
  }

  // Look at state changes for selection
  const stateChange = events.find(e => e.kind === 'state:changes' && e.diffJson);
  if (stateChange?.diffJson) {
    for (const diff of stateChange.diffJson) {
      if (diff.path?.includes('selectedIds') && diff.after) {
        const selected = Array.isArray(diff.after) ? diff.after[0] : diff.after;
        if (selected && typeof selected === 'string') {
          const name = selected.split('/').pop();
          if (!target.label) {
            target.label = name;
          }
          target.selectedPath = selected;
        }
      }
    }
  }

  // For keydown events: preserve the key
  if (interaction.interaction === 'keydown' || interaction.eventName === 'keydown') {
    if (interaction.detail?.key) {
      target.key = interaction.detail.key;
    }
  }

  // Use interaction label if still not found
  if (!target.label && interaction.componentLabel) {
    const label = interaction.componentLabel;
    const isGeneric = /^[A-Z][a-z]+[A-Z]|^(HStack|VStack|Tree|Stack|Box|Link|Text)$/.test(label);
    // Also skip raw HTML element names used as labels (svg, input, div, etc.)
    const isHtmlTag = /^(svg|path|input|textarea|div|span|button|a|img|label|select|option|ul|li|ol|tr|td|th|table|form|section|header|footer|nav|main|aside|article)$/i.test(label);
    if (!isGeneric && !isHtmlTag) {
      target.label = label;
    }
  }

  // Extract await conditions
  const awaitConditions = {};

  const apiCalls = events
    .filter(e => (e.kind === 'api:complete' || e.kind === 'api:start') && e.method)
    .map(e => ({ method: resolveMethod(e.method, e.url || e.endpoint), endpoint: e.url || e.endpoint, status: e.status }));
  if (apiCalls.length > 0) {
    awaitConditions.api = apiCalls;
  }

  const navigate = events.find(e => e.kind === 'navigate');
  if (navigate) {
    awaitConditions.navigate = { from: navigate.from, to: navigate.to };
  }

  const step = {
    action: interaction.interaction || interaction.eventName,
    target,
    await: Object.keys(awaitConditions).length > 0 ? awaitConditions : undefined
  };

  // Extract modal (confirmation dialog) events from the same trace group
  const modals = extractModals(events);
  if (modals.length > 0) {
    step.modals = modals;
  }

  // Extract toast notifications from the same trace group
  const toasts = events
    .filter(e => e.kind === 'toast')
    .map(e => ({ type: e.toastType || 'default', message: e.message }));
  if (toasts.length > 0) {
    step.toasts = toasts;
  }

  // Capture DataSource array snapshots for cross-step diffing.
  // The caller (distillJsonLogs) will diff consecutive snapshots and attach
  // dataSourceChanges to steps with mutating API calls.
  const dsArrayChanges = events
    .filter(e => e.kind === 'state:changes' && e.diffJson)
    .flatMap(e => e.diffJson)
    .filter(d => d.path && d.path.startsWith('DataSource:') && Array.isArray(d.after));
  if (dsArrayChanges.length > 0) {
    if (!step._dataSourceSnapshots) step._dataSourceSnapshots = {};
    for (const d of dsArrayChanges) {
      step._dataSourceSnapshots[d.path] = d.after.map(itemLabel).filter(Boolean);
    }
  }

  return step;
}

/**
 * Extract confirmation dialog interactions from a trace group's events.
 * A modal sequence is: modal:show → modal:confirm or modal:cancel.
 * There can be multiple modal sequences in one trace (e.g., delete confirmation
 * followed by "folder not empty" confirmation).
 */
function extractModals(events) {
  const modals = [];
  const modalShows = events.filter(e => e.kind === 'modal:show');

  for (let i = 0; i < modalShows.length; i++) {
    const show = modalShows[i];
    const showTs = show.perfTs || show.ts || 0;

    // Find the next modal:confirm or modal:cancel after this show
    const nextShowTs = modalShows[i + 1]?.perfTs || modalShows[i + 1]?.ts || Infinity;
    const resolution = events.find(e =>
      (e.kind === 'modal:confirm' || e.kind === 'modal:cancel') &&
      (e.perfTs || e.ts || 0) > showTs &&
      (e.perfTs || e.ts || 0) <= nextShowTs
    );

    const modal = {
      title: show.title,
      buttons: show.buttons, // available with enhanced engine instrumentation
    };

    if (resolution?.kind === 'modal:confirm') {
      modal.action = 'confirm';
      modal.value = resolution.value;
      modal.buttonLabel = resolution.buttonLabel;
      // Fallback: look up label from buttons array if buttonLabel not available
      if (!modal.buttonLabel && modal.buttons && modal.value !== undefined) {
        const btn = modal.buttons.find(b => b.value === modal.value);
        if (btn) modal.buttonLabel = btn.label;
      }
    } else if (resolution?.kind === 'modal:cancel') {
      modal.action = 'cancel';
    } else {
      modal.action = 'unknown'; // show without resolution (shouldn't happen)
    }

    modals.push(modal);
  }

  return modals;
}

// Export
if (typeof module !== 'undefined') {
  module.exports = { distillTrace, distillJsonLogs, parseTrace, resolveMethod };
}

// CLI usage
if (require.main === module) {
  const fs = require('fs');
  const input = fs.readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
  const outputFile = process.argv[3];

  let distilled;
  // Detect JSON vs text format
  if (input.trim().startsWith('[') || input.trim().startsWith('{')) {
    const logs = JSON.parse(input);
    distilled = distillJsonLogs(logs);
  } else {
    const parsed = parseTrace(input);
    distilled = distillTrace(parsed);
  }

  const output = JSON.stringify(distilled, null, 2);
  if (outputFile) {
    fs.writeFileSync(outputFile, output);
  } else {
    console.log(output);
  }
}
