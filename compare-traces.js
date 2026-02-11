/**
 * Compare two normalized traces and report differences
 */

const { parseTrace } = require('./parse-trace');
const { normalizeTrace, normalizeJsonLogs, resolveMethod } = require('./normalize-trace');

/**
 * Normalize input - handles text export, JSON logs array, or already-normalized object
 */
function normalizeInput(input) {
  // Already normalized
  if (input && typeof input === 'object' && input.steps) {
    return input;
  }

  // JSON string - parse first
  if (typeof input === 'string' && input.trim().startsWith('[')) {
    try {
      const logs = JSON.parse(input);
      return normalizeJsonLogs(logs);
    } catch (e) {
      // Fall through to text parsing
    }
  }

  // JSON array (from Playwright capture)
  if (Array.isArray(input)) {
    return normalizeJsonLogs(input);
  }

  // Text export format
  if (typeof input === 'string') {
    return normalizeTrace(parseTrace(input));
  }

  throw new Error('Unknown trace format');
}

function compareTraces(trace1, trace2) {
  const norm1 = normalizeInput(trace1);
  const norm2 = normalizeInput(trace2);

  const report = {
    match: true,
    stepCount: {
      before: norm1.steps.length,
      after: norm2.steps.length
    },
    differences: []
  };

  const maxSteps = Math.max(norm1.steps.length, norm2.steps.length);

  for (let i = 0; i < maxSteps; i++) {
    const step1 = norm1.steps[i];
    const step2 = norm2.steps[i];

    if (!step1) {
      report.match = false;
      report.differences.push({
        step: i + 1,
        type: 'extra_step',
        message: `After trace has extra step: ${step2.action} ${step2.target?.label || ''}`
      });
      continue;
    }

    if (!step2) {
      report.match = false;
      report.differences.push({
        step: i + 1,
        type: 'missing_step',
        message: `After trace missing step: ${step1.action} ${step1.target?.label || ''}`
      });
      continue;
    }

    // Compare action
    if (step1.action !== step2.action) {
      report.match = false;
      report.differences.push({
        step: i + 1,
        type: 'action_mismatch',
        before: step1.action,
        after: step2.action
      });
    }

    // Compare target (semantic comparison)
    const targetDiff = compareTargets(step1.target, step2.target);
    if (targetDiff) {
      report.match = false;
      report.differences.push({
        step: i + 1,
        type: 'target_mismatch',
        ...targetDiff
      });
    }

    // Compare await conditions
    const awaitDiff = compareAwait(step1.await, step2.await);
    if (awaitDiff.length > 0) {
      report.match = false;
      report.differences.push({
        step: i + 1,
        type: 'await_mismatch',
        details: awaitDiff
      });
    }
  }

  return report;
}

function compareTargets(t1, t2, options = {}) {
  const { allowComponentChanges = true } = options;

  if (!t1 && !t2) return null;
  if (!t1) return { message: 'target missing in before', after: t2 };
  if (!t2) return { message: 'target missing in after', before: t1 };

  // Compare labels (semantic identity)
  if (t1.label !== t2.label) {
    return {
      field: 'label',
      before: t1.label,
      after: t2.label
    };
  }

  // Component type mismatch is OK if label matches (refactoring)
  // Only report as difference if allowComponentChanges is false
  if (t1.component !== t2.component && !allowComponentChanges) {
    return {
      field: 'component',
      before: t1.component,
      after: t2.component,
      note: 'Component type changed but label matches - likely refactoring'
    };
  }

  return null;
}

function compareAwait(a1, a2) {
  const diffs = [];

  if (!a1 && !a2) return diffs;
  if (!a1) {
    diffs.push({ type: 'await_added', after: a2 });
    return diffs;
  }
  if (!a2) {
    diffs.push({ type: 'await_removed', before: a1 });
    return diffs;
  }

  // Compare API calls
  const apis1 = (a1.api || []).map(a => `${a.method} ${a.endpoint}`).sort();
  const apis2 = (a2.api || []).map(a => `${a.method} ${a.endpoint}`).sort();

  const missingApis = apis1.filter(a => !apis2.includes(a));
  const extraApis = apis2.filter(a => !apis1.includes(a));

  if (missingApis.length > 0) {
    diffs.push({ type: 'api_removed', apis: missingApis });
  }
  if (extraApis.length > 0) {
    diffs.push({ type: 'api_added', apis: extraApis });
  }

  // Compare navigation
  if (a1.navigate?.to !== a2.navigate?.to) {
    diffs.push({
      type: 'navigate_mismatch',
      before: a1.navigate?.to,
      after: a2.navigate?.to
    });
  }

  return diffs;
}

function formatReport(report) {
  const lines = [];

  if (report.match) {
    lines.push('✓ Traces match');
    lines.push(`  ${report.stepCount.before} steps compared`);
  } else {
    lines.push('✗ Traces differ');
    lines.push(`  Before: ${report.stepCount.before} steps`);
    lines.push(`  After: ${report.stepCount.after} steps`);
    lines.push('');
    lines.push('Differences:');

    for (const diff of report.differences) {
      lines.push(`  Step ${diff.step}: ${diff.type}`);
      if (diff.before !== undefined) {
        lines.push(`    before: ${JSON.stringify(diff.before)}`);
      }
      if (diff.after !== undefined) {
        lines.push(`    after: ${JSON.stringify(diff.after)}`);
      }
      if (diff.message) {
        lines.push(`    ${diff.message}`);
      }
      if (diff.details) {
        for (const d of diff.details) {
          lines.push(`    - ${d.type}: ${JSON.stringify(d)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Extract semantic summary from trace for high-level comparison
 */
function extractSemantics(input) {
  // Get raw logs if we have normalized input
  let logs;
  if (Array.isArray(input)) {
    logs = input;
  } else if (typeof input === 'string') {
    if (input.trim().startsWith('[')) {
      logs = JSON.parse(input);
    } else {
      // Text format - can't extract semantics directly
      return null;
    }
  } else {
    return null;
  }

  // Extract API calls (exclude startup-trace APIs since manually-captured
  // baselines lose them to buffer eviction, making comparison unreliable)
  const apis = logs
    .filter(e => e.kind === 'api:complete' && e.method && !(e.traceId && e.traceId.startsWith('startup-')))
    .map(e => ({
      method: resolveMethod(e.method, e.url || e.endpoint),
      endpoint: (e.url || '').split('?')[0].replace(/^.*\/api/, ''),
      status: e.status
    }));

  // Unique API signatures (method + endpoint)
  const uniqueApis = [...new Set(apis.map(a => `${a.method} ${a.endpoint}`))].sort();

  // Extract form submits
  const formSubmits = logs
    .filter(e => e.kind === 'handler:start' && e.eventName === 'submit')
    .map(e => e.eventArgs?.[0]?.name)
    .filter(Boolean);

  // Extract navigation endpoints
  const navigations = logs
    .filter(e => e.kind === 'navigate')
    .map(e => e.to?.split('?')[0])
    .filter(Boolean);
  const uniqueNavigations = [...new Set(navigations)];

  // Extract context menu targets
  const contextMenus = logs
    .filter(e => e.kind === 'interaction' && e.action === 'contextmenu')
    .map(e => e.detail?.label || e.detail?.testId)
    .filter(Boolean);

  // Extract journey steps (for --show-journey)
  const normalized = normalizeJsonLogs(logs);
  const journey = normalized.steps
    .filter(s => s.action !== 'keydown')
    .map(s => {
      const target = s.target?.label || s.target?.testId || s.target?.component || '';
      const formData = s.target?.formData;
      let line = `${s.action}: ${target}`;
      if (formData?.name) {
        line += ` → "${formData.name}"`;
      }
      return line;
    });

  return {
    apis: uniqueApis,
    apiCount: apis.length,
    formSubmits,
    navigations: uniqueNavigations,
    contextMenus,
    journey
  };
}

/**
 * Compare two traces semantically (outcomes rather than steps)
 */
function compareSemanticTraces(trace1, trace2, options = {}) {
  const { ignoreApis = [] } = options;
  const sem1 = extractSemantics(trace1);
  const sem2 = extractSemantics(trace2);

  if (!sem1 || !sem2) {
    return { error: 'Semantic comparison requires JSON trace format' };
  }

  // Filter out ignored APIs (match by endpoint substring)
  const apiFilter = api => !ignoreApis.some(pattern => api.includes(pattern));
  sem1.apis = sem1.apis.filter(apiFilter);
  sem2.apis = sem2.apis.filter(apiFilter);

  const report = {
    match: true,
    differences: []
  };

  if (ignoreApis.length > 0) {
    report.ignoredApis = ignoreApis;
  }

  // Compare API calls
  const missingApis = sem1.apis.filter(a => !sem2.apis.includes(a));
  const extraApis = sem2.apis.filter(a => !sem1.apis.includes(a));

  if (missingApis.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'apis_missing',
      message: `APIs in before but not after: ${missingApis.join(', ')}`
    });
  }
  if (extraApis.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'apis_extra',
      message: `APIs in after but not before: ${extraApis.join(', ')}`
    });
  }

  // Compare form submits
  if (sem1.formSubmits.length !== sem2.formSubmits.length) {
    report.match = false;
    report.differences.push({
      type: 'form_submit_count',
      before: sem1.formSubmits.length,
      after: sem2.formSubmits.length
    });
  }

  const submitDiff = sem1.formSubmits.filter((s, i) => s !== sem2.formSubmits[i]);
  if (submitDiff.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'form_submit_values',
      before: sem1.formSubmits,
      after: sem2.formSubmits
    });
  }

  // Compare context menu targets
  const missingCtx = sem1.contextMenus.filter(c => !sem2.contextMenus.includes(c));
  const extraCtx = sem2.contextMenus.filter(c => !sem1.contextMenus.includes(c));

  if (missingCtx.length > 0 || extraCtx.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'context_menu_targets',
      missing: missingCtx,
      extra: extraCtx
    });
  }

  // Add summaries
  report.before = sem1;
  report.after = sem2;

  return report;
}

function formatSemanticReport(report, options = {}) {
  const { showJourney } = options;
  const lines = [];

  if (report.error) {
    lines.push(`Error: ${report.error}`);
    return lines.join('\n');
  }

  if (report.ignoredApis?.length > 0) {
    lines.push(`(ignoring APIs: ${report.ignoredApis.join(', ')})`);
  }

  if (report.match) {
    lines.push('✓ Traces match semantically');
  } else {
    lines.push('✗ Traces differ semantically');
    lines.push('');
    lines.push('Differences:');
    for (const diff of report.differences) {
      lines.push(`  ${diff.type}: ${diff.message || ''}`);
      if (diff.before !== undefined) lines.push(`    before: ${JSON.stringify(diff.before)}`);
      if (diff.after !== undefined) lines.push(`    after: ${JSON.stringify(diff.after)}`);
      if (diff.missing?.length) lines.push(`    missing: ${diff.missing.join(', ')}`);
      if (diff.extra?.length) lines.push(`    extra: ${diff.extra.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Before:');
  lines.push(`  APIs: ${report.before.apis.join(', ')}`);
  lines.push(`  Form submits: ${report.before.formSubmits.length} (${report.before.formSubmits.join(' → ')})`);
  lines.push(`  Context menus: ${report.before.contextMenus.join(', ')}`);
  if (showJourney && report.before.journey) {
    lines.push('  Journey:');
    for (const step of report.before.journey) {
      lines.push(`    ${step}`);
    }
  }

  lines.push('');
  lines.push('After:');
  lines.push(`  APIs: ${report.after.apis.join(', ')}`);
  lines.push(`  Form submits: ${report.after.formSubmits.length} (${report.after.formSubmits.join(' → ')})`);
  lines.push(`  Context menus: ${report.after.contextMenus.join(', ')}`);
  if (showJourney && report.after.journey) {
    lines.push('  Journey:');
    for (const step of report.after.journey) {
      lines.push(`    ${step}`);
    }
  }

  return lines.join('\n');
}

// Export
if (typeof module !== 'undefined') {
  module.exports = { compareTraces, formatReport, compareSemanticTraces, formatSemanticReport };
}

// CLI usage
if (require.main === module) {
  const fs = require('fs');

  const args = process.argv.slice(2);
  const semantic = args.includes('--semantic');
  const showJourney = args.includes('--show-journey');

  // Collect --ignore-api values (can be repeated)
  const ignoreApis = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ignore-api' && args[i + 1]) {
      ignoreApis.push(args[i + 1]);
      i++; // skip the value
    }
  }

  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ignore-api');

  if (files.length < 2) {
    console.error('Usage: node compare-traces.js [--semantic] [--show-journey] [--ignore-api <endpoint>]... <before.json> <after.json>');
    process.exit(1);
  }

  const trace1 = fs.readFileSync(files[0], 'utf8');
  const trace2 = fs.readFileSync(files[1], 'utf8');

  if (semantic) {
    const report = compareSemanticTraces(trace1, trace2, { ignoreApis });
    console.log(formatSemanticReport(report, { showJourney }));
  } else {
    const report = compareTraces(trace1, trace2);
    console.log(formatReport(report));
    console.log('\n--- Raw report ---');
    console.log(JSON.stringify(report, null, 2));
  }
}
