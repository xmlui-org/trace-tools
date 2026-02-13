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
        if (urlObj.searchParams.get(paramName) === paramValue) {
          return trueMethod.toUpperCase();
        }
        return falseMethod.toUpperCase();
      } catch (e) { /* fall through */ }
    }
    // No URL context — return the "true" branch as default
    return trueMethod.toUpperCase();
  }

  // Generic fallback: extract the first HTTP verb from the expression
  const verbMatch = method.match(/\b(get|post|put|delete|patch|head|options)\b/i);
  if (verbMatch) {
    return verbMatch[1].toUpperCase();
  }

  return method;
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
      steps.push(step);
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

  return {
    action: interaction.interaction || interaction.eventName,
    target,
    await: Object.keys(awaitConditions).length > 0 ? awaitConditions : undefined
  };
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
