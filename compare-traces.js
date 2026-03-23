/**
 * Compare two distilled traces and report differences
 */

const { distillTrace, resolveMethod } = require('./distill-trace');

/**
 * Distill input - handles JSON logs array or already-distilled object
 */
function distillInput(input) {
  // Already distilled
  if (input && typeof input === 'object' && input.steps) {
    return input;
  }

  // JSON string - parse first
  if (typeof input === 'string') {
    const parsed = JSON.parse(input);
    if (parsed.steps) return parsed;
    if (Array.isArray(parsed)) return distillTrace(parsed);
    return distillTrace([parsed]);
  }

  // JSON array (from Playwright capture)
  if (Array.isArray(input)) {
    return distillTrace(input);
  }

  throw new Error('Unknown trace format');
}

function compareTraces(trace1, trace2) {
  const norm1 = distillInput(trace1);
  const norm2 = distillInput(trace2);

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
function extractSemanticsFromDistilled(distilled) {
  const steps = distilled.steps || [];

  // Collect all APIs across steps
  const allApis = steps.flatMap(s => (s.await?.api || []).map(a => ({
    method: a.method,
    endpoint: (a.endpoint || '').split('?')[0].replace(/^.*\/api/, ''),
    status: a.status
  })));
  const uniqueApis = [...new Set(allApis.map(a => `${a.method} ${a.endpoint}`))].sort();

  // Mutation counts
  const mutationCounts = {};
  allApis
    .filter(a => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method))
    .forEach(a => {
      const key = `${a.method} ${a.endpoint}`;
      mutationCounts[key] = (mutationCounts[key] || 0) + 1;
    });

  // Value changes
  const allVcs = steps.flatMap(s => (s.valueChanges || []).map(vc => ({
    component: vc.component,
    value: vc.displayLabel != null ? String(vc.displayLabel) : undefined,
    ariaName: vc.ariaName
  })));
  const lastValueByComponent = {};
  for (const vc of allVcs) {
    lastValueByComponent[vc.ariaName || vc.component] = vc;
  }
  const uniqueValueChanges = Object.values(lastValueByComponent)
    .map(vc => `${vc.ariaName || vc.component}=${vc.value}`);

  // Navigations
  const allNavs = steps.flatMap(s => s.navigations || []);
  const uniqueNavigations = [...new Set(allNavs.map(n => (n.to || n).split('?')[0]).filter(Boolean))];

  // Modals
  const confirmationDialogs = steps.flatMap(s => (s.modals || []).map(m => ({
    title: m.title,
    outcome: m.outcome || 'unknown'
  })));

  // Journey
  const journey = steps
    .filter(s => s.action !== 'keydown')
    .map(s => {
      const target = s.target?.label || s.target?.testId || s.target?.component || '';
      const formData = s.target?.formData;
      let line = `${s.action}: ${target}`;
      if (formData?.name) line += ` → "${formData.name}"`;
      return line;
    });

  // Extract app:trace transition shapes from distilled steps
  const appTracesByLabel = {};
  for (const s of steps) {
    if (!s.appTraces) continue;
    for (const [label, dataSeq] of Object.entries(s.appTraces)) {
      if (!appTracesByLabel[label]) appTracesByLabel[label] = [];
      appTracesByLabel[label].push(...dataSeq);
    }
  }
  const appTraceShapes = {};
  for (const [label, dataSeq] of Object.entries(appTracesByLabel)) {
    if (dataSeq.length < 2) continue;
    const allKeys = [...new Set(dataSeq.flatMap(d => Object.keys(d)))];
    const shape = {};
    for (const key of allKeys) {
      const transitions = [];
      for (let i = 1; i < dataSeq.length; i++) {
        const prev = dataSeq[i - 1][key];
        const curr = dataSeq[i][key];
        if (typeof curr === 'number' && typeof prev === 'number') {
          transitions.push(curr > prev ? 'up' : curr < prev ? 'down' : 'same');
        } else {
          transitions.push(curr === prev ? 'same' : 'changed');
        }
      }
      shape[key] = transitions;
    }
    appTraceShapes[label] = shape;
  }

  // State diffs (.xs global mutations)
  const allStateDiffs = steps.flatMap(s => (s.stateDiffs || []).map(d => ({
    path: d.path,
    before: d.before,
    after: d.after,
    added: d.added || [],
    removed: d.removed || []
  })));

  // Validation errors (form validation failures)
  const allValidationErrors = steps.flatMap(s => (s.validationErrors || []).map(v => ({
    form: v.form,
    errorCount: v.errorCount,
  })));

  // Data binds (data/view correspondence)
  const allDataBinds = steps.flatMap(s => (s.dataBinds || []).map(d => ({
    component: d.component,
    direction: d.rowCount > d.prevCount ? 'up' : d.rowCount < d.prevCount ? 'down' : 'same',
  })));

  return {
    apis: uniqueApis,
    apiCount: allApis.length,
    apiErrors: [],
    mutationCounts,
    formSubmits: [],
    navigations: uniqueNavigations,
    contextMenus: [],
    confirmationDialogs,
    valueChanges: uniqueValueChanges,
    stateDiffs: allStateDiffs,
    validationErrors: allValidationErrors,
    dataBinds: allDataBinds,
    appTraceShapes,
    journey
  };
}

function extractSemantics(input) {
  // Handle distilled format ({ steps: [...] })
  if (input && typeof input === 'object' && !Array.isArray(input) && input.steps) {
    return extractSemanticsFromDistilled(input);
  }

  // For raw logs or JSON strings, distill first then extract semantics.
  // This ensures stateDiffs and other distiller-computed fields are available.
  let logs;
  if (Array.isArray(input)) {
    logs = input;
  } else if (typeof input === 'string') {
    if (input.trim().startsWith('[')) {
      logs = JSON.parse(input);
    } else if (input.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(input);
        if (parsed.steps) return extractSemanticsFromDistilled(parsed);
        logs = [parsed];
      } catch (e) {
        return null;
      }
    } else {
      return null;
    }
  } else {
    return null;
  }

  // Distill raw logs to get stateDiffs and other computed fields
  const distilledFromLogs = distillTrace(logs);
  if (distilledFromLogs?.steps) {
    return extractSemanticsFromDistilled(distilledFromLogs);
  }

  // Extract API calls
  const apis = logs
    .filter(e => e.kind === 'api:complete' && e.method)
    .map(e => ({
      method: resolveMethod(e.method, e.url || e.endpoint),
      endpoint: (e.url || '').split('?')[0].replace(/^.*\/api/, ''),
      status: e.status
    }));

  // Unique API signatures (method + endpoint)
  const uniqueApis = [...new Set(apis.map(a => `${a.method} ${a.endpoint}`))].sort();

  // Extract API errors (409 conflict, 417 not-empty, etc.)
  const apiErrors = logs
    .filter(e => e.kind === 'api:error' && e.method)
    .map(e => ({
      method: resolveMethod(e.method, e.url || e.endpoint),
      endpoint: (e.url || '').split('?')[0].replace(/^.*\/api/, '')
    }));
  const uniqueApiErrors = [...new Set(apiErrors.map(a => `${a.method} ${a.endpoint}`))].sort();

  // Count mutations (POST/PUT/DELETE/PATCH completions — user-initiated actions)
  const mutationCounts = {};
  apis
    .filter(a => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method))
    .forEach(a => {
      const key = `${a.method} ${a.endpoint}`;
      mutationCounts[key] = (mutationCounts[key] || 0) + 1;
    });

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

  // Extract confirmation dialog outcomes (use timestamp ordering to handle
  // multiple modals in the same trace group)
  const modalShows = logs.filter(e => e.kind === 'modal:show');
  const modalResolutions = logs.filter(e => e.kind === 'modal:confirm' || e.kind === 'modal:cancel');
  const usedResolutions = new Set();
  const confirmationDialogs = modalShows.map(show => {
    const showTs = show.perfTs || show.ts || 0;
    // Find the first unused resolution after this show event
    const resolution = modalResolutions.find(r => {
      const rTs = r.perfTs || r.ts || 0;
      return rTs > showTs && !usedResolutions.has(r);
    });
    if (resolution) usedResolutions.add(resolution);
    return {
      title: show.title,
      outcome: resolution?.kind === 'modal:confirm'
        ? `confirm:${resolution.buttonLabel || resolution.value}`
        : (resolution?.kind === 'modal:cancel' ? 'cancel' : 'unknown')
    };
  });

  // Extract journey steps (for --show-journey)
  const distilled = distillTrace(logs);
  const journey = distilled.steps
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

  // Extract value changes (from wrapComponent trace events)
  const valueChanges = logs
    .filter(e => e.kind === 'value:change')
    .map(e => ({
      component: e.component,
      value: e.displayLabel != null ? String(e.displayLabel) : undefined,
      ariaName: e.ariaName
    }));
  // Keep only the last value per component (coalesce rapid changes)
  const lastValueByComponent = {};
  for (const vc of valueChanges) {
    lastValueByComponent[vc.ariaName || vc.component] = vc;
  }
  const uniqueValueChanges = Object.values(lastValueByComponent)
    .map(vc => `${vc.ariaName || vc.component}=${vc.value}`);

  // Extract app:trace transition shapes
  // Group by label, then for each field compute the sequence of transitions
  const appTraces = logs.filter(e => e.kind === 'app:trace' && e.data);
  const appTracesByLabel = {};
  for (const e of appTraces) {
    const label = e.label || 'unknown';
    if (!appTracesByLabel[label]) appTracesByLabel[label] = [];
    appTracesByLabel[label].push(e.data);
  }

  // For each label, compute transition shapes per field
  const appTraceShapes = {};
  for (const [label, dataSeq] of Object.entries(appTracesByLabel)) {
    if (dataSeq.length < 2) continue; // need at least 2 to have a transition
    const allKeys = [...new Set(dataSeq.flatMap(d => Object.keys(d)))];
    const shape = {};
    for (const key of allKeys) {
      const transitions = [];
      for (let i = 1; i < dataSeq.length; i++) {
        const prev = dataSeq[i - 1][key];
        const curr = dataSeq[i][key];
        if (typeof curr === 'number' && typeof prev === 'number') {
          // Numeric: direction
          transitions.push(curr > prev ? 'up' : curr < prev ? 'down' : 'same');
        } else {
          // Everything else: changed vs same
          transitions.push(curr === prev ? 'same' : 'changed');
        }
      }
      shape[key] = transitions;
    }
    appTraceShapes[label] = shape;
  }

  return {
    apis: uniqueApis,
    apiCount: apis.length,
    apiErrors: uniqueApiErrors,
    mutationCounts,
    formSubmits,
    navigations: uniqueNavigations,
    contextMenus,
    confirmationDialogs,
    valueChanges: uniqueValueChanges,
    appTraceShapes,
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

  // GET-only API differences are advisory (non-deterministic DataSource refetches).
  // Only mutation API differences break the match.
  const missingMutations = missingApis.filter(a => !a.startsWith('GET '));
  const extraMutations = extraApis.filter(a => !a.startsWith('GET '));
  const missingGets = missingApis.filter(a => a.startsWith('GET '));
  const extraGets = extraApis.filter(a => a.startsWith('GET '));

  if (missingMutations.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'apis_missing',
      message: `Mutation APIs in before but not after: ${missingMutations.join(', ')}`
    });
  }
  if (extraMutations.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'apis_extra',
      message: `Mutation APIs in after but not before: ${extraMutations.join(', ')}`
    });
  }
  if (missingGets.length > 0) {
    report.differences.push({
      type: 'apis_missing_gets',
      message: `GET APIs in before but not after: ${missingGets.join(', ')} (non-deterministic DataSource timing)`
    });
  }
  if (extraGets.length > 0) {
    report.differences.push({
      type: 'apis_extra_gets',
      message: `GET APIs in after but not before: ${extraGets.join(', ')} (non-deterministic DataSource timing)`
    });
  }

  // Compare API errors (advisory only — transient API errors are non-deterministic)
  const missingErrors = sem1.apiErrors.filter(a => !sem2.apiErrors.includes(a));
  const extraErrors = sem2.apiErrors.filter(a => !sem1.apiErrors.includes(a));

  if (missingErrors.length > 0) {
    report.differences.push({
      type: 'api_errors_missing',
      message: `API errors in before but not after: ${missingErrors.join(', ')} (transient API error, not a behavioral difference)`
    });
  }
  if (extraErrors.length > 0) {
    report.differences.push({
      type: 'api_errors_extra',
      message: `API errors in after but not before: ${extraErrors.join(', ')} (transient API error, not a behavioral difference)`
    });
  }

  // Compare mutation counts (POST/PUT/DELETE/PATCH)
  const allMutationKeys = [...new Set([
    ...Object.keys(sem1.mutationCounts),
    ...Object.keys(sem2.mutationCounts)
  ])].sort();

  for (const key of allMutationKeys) {
    const count1 = sem1.mutationCounts[key] || 0;
    const count2 = sem2.mutationCounts[key] || 0;
    if (count1 !== count2) {
      report.match = false;
      report.differences.push({
        type: 'mutation_count',
        message: `${key}: ${count1} → ${count2}`
      });
    }
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

  // Compare confirmation dialogs
  const dialogs1 = (sem1.confirmationDialogs || []).map(d => `${d.title}→${d.outcome}`);
  const dialogs2 = (sem2.confirmationDialogs || []).map(d => `${d.title}→${d.outcome}`);
  const missingDialogs = dialogs1.filter(d => !dialogs2.includes(d));
  const extraDialogs = dialogs2.filter(d => !dialogs1.includes(d));

  if (missingDialogs.length > 0 || extraDialogs.length > 0) {
    report.match = false;
    report.differences.push({
      type: 'confirmation_dialogs',
      missing: missingDialogs,
      extra: extraDialogs
    });
  }

  // Compare value changes
  const vc1 = (sem1.valueChanges || []).sort();
  const vc2 = (sem2.valueChanges || []).sort();
  const missingVC = vc1.filter(v => !vc2.includes(v));
  const extraVC = vc2.filter(v => !vc1.includes(v));

  if (missingVC.length > 0 || extraVC.length > 0) {
    // Value changes are advisory — the set of traced value:change events varies
    // with timing (orphaned FileInput events, reactive re-evaluations, etc.)
    report.differences.push({
      type: 'value_changes',
      message: 'Value change difference (advisory)',
      missing: missingVC,
      extra: extraVC
    });
  }

  // Compare state diffs (.xs global mutations)
  const sd1 = sem1.stateDiffs || [];
  const sd2 = sem2.stateDiffs || [];

  if (sd1.length > 0 || sd2.length > 0) {
    // Match by path — compare before/after counts and added/removed items
    const paths1 = new Map(sd1.map(d => [d.path, d]));
    const paths2 = new Map(sd2.map(d => [d.path, d]));

    for (const [path, d1] of paths1) {
      const d2 = paths2.get(path);
      if (!d2) {
        report.match = false;
        report.differences.push({
          type: 'state_diff_missing',
          message: `State change "${path}" (${d1.before} → ${d1.after}) in before but not after`
        });
        continue;
      }
      // Compare shape: direction of change (grew/shrank/same) and count of added/removed
      // Not specific values — "Jon Udell" vs "Jane Doe" should both pass
      const dir1 = d1.after > d1.before ? 'up' : d1.after < d1.before ? 'down' : 'same';
      const dir2 = d2.after > d2.before ? 'up' : d2.after < d2.before ? 'down' : 'same';
      if (dir1 !== dir2) {
        report.match = false;
        report.differences.push({
          type: 'state_diff_direction',
          message: `State "${path}" direction: expected ${dir1} (${d1.before}→${d1.after}), got ${dir2} (${d2.before}→${d2.after})`
        });
      }
      const addedCount1 = (d1.added || []).length;
      const addedCount2 = (d2.added || []).length;
      const removedCount1 = (d1.removed || []).length;
      const removedCount2 = (d2.removed || []).length;
      if (addedCount1 !== addedCount2 || removedCount1 !== removedCount2) {
        report.match = false;
        report.differences.push({
          type: 'state_diff_shape',
          message: `State "${path}" shape: expected +${addedCount1}/-${removedCount1}, got +${addedCount2}/-${removedCount2}`
        });
      }
    }

    for (const [path, d2] of paths2) {
      if (!paths1.has(path)) {
        report.match = false;
        report.differences.push({
          type: 'state_diff_extra',
          message: `State change "${path}" (${d2.before} → ${d2.after}) in after but not before`
        });
      }
    }
  }

  // Compare validation errors (shape: count of validation failures per form)
  const ve1 = sem1.validationErrors || [];
  const ve2 = sem2.validationErrors || [];
  if (ve1.length !== ve2.length) {
    report.match = false;
    report.differences.push({
      type: 'validation_error_count',
      message: `Validation failure count: expected ${ve1.length}, got ${ve2.length}`
    });
  } else {
    for (let i = 0; i < ve1.length; i++) {
      if (ve1[i].errorCount !== ve2[i].errorCount) {
        report.match = false;
        report.differences.push({
          type: 'validation_error_shape',
          message: `Validation #${i + 1} on "${ve1[i].form}": expected ${ve1[i].errorCount} errors, got ${ve2[i].errorCount}`
        });
      }
    }
  }

  // Compare data binds (shape: direction of change per component)
  const db1 = sem1.dataBinds || [];
  const db2 = sem2.dataBinds || [];
  if (db1.length !== db2.length) {
    report.differences.push({
      type: 'data_bind_count',
      message: `Data bind event count: expected ${db1.length}, got ${db2.length} (advisory)`
    });
  } else {
    for (let i = 0; i < db1.length; i++) {
      if (db1[i].direction !== db2[i].direction) {
        report.match = false;
        report.differences.push({
          type: 'data_bind_direction',
          message: `Data bind "${db1[i].component}": expected ${db1[i].direction}, got ${db2[i].direction}`
        });
      }
    }
  }

  // Compare app:trace transition shapes
  const shapes1 = sem1.appTraceShapes || {};
  const shapes2 = sem2.appTraceShapes || {};
  const allLabels = [...new Set([...Object.keys(shapes1), ...Object.keys(shapes2)])].sort();

  for (const label of allLabels) {
    const s1 = shapes1[label];
    const s2 = shapes2[label];

    if (!s1) {
      // App:trace presence can vary with timing — advisory only
      report.differences.push({
        type: 'app_trace_missing',
        message: `app:trace "${label}" in after but not before`
      });
      continue;
    }
    if (!s2) {
      report.differences.push({
        type: 'app_trace_missing',
        message: `app:trace "${label}" in before but not after`
      });
      continue;
    }

    // Compare transition sequences per field (advisory only — reactive
    // evaluation counts and directions are non-deterministic)
    const allFields = [...new Set([...Object.keys(s1), ...Object.keys(s2)])];
    for (const field of allFields) {
      const sig1 = (s1[field] || []).filter(t => t !== 'same').join(',');
      const sig2 = (s2[field] || []).filter(t => t !== 'same').join(',');
      if (sig1 !== sig2) {
        report.differences.push({
          type: 'app_trace_shape',
          message: `app:trace "${label}" field "${field}": [${sig1}] → [${sig2}] (reactive noise, nothing to worry about)`
        });
      }
    }
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
    lines.push('SEMANTIC_MATCH');
  } else {
    lines.push('SEMANTIC_MISMATCH');
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

  function formatMutations(mutationCounts) {
    const entries = Object.entries(mutationCounts).sort();
    if (entries.length === 0) return '(none)';
    return entries.map(([k, v]) => `${k} ×${v}`).join(', ');
  }

  function formatSemSummary(label, sem) {
    lines.push('');
    lines.push(`${label}:`);
    lines.push(`  APIs: ${sem.apis.join(', ')}`);
    lines.push(`  API errors: ${sem.apiErrors.length > 0 ? sem.apiErrors.join(', ') : '(none)'}`);
    lines.push(`  Mutations: ${formatMutations(sem.mutationCounts)}`);
    lines.push(`  Form submits: ${sem.formSubmits.length} (${sem.formSubmits.join(' → ')})`);
    lines.push(`  Context menus: ${sem.contextMenus.join(', ')}`);
    lines.push(`  Confirmation dialogs: ${(sem.confirmationDialogs || []).length > 0 ? sem.confirmationDialogs.map(d => `"${d.title}"→${d.outcome}`).join(', ') : '(none)'}`);
    lines.push(`  Value changes: ${(sem.valueChanges || []).length > 0 ? sem.valueChanges.join(', ') : '(none)'}`);
    const sds = sem.stateDiffs || [];
    if (sds.length > 0) {
      lines.push(`  State diffs:`);
      for (const sd of sds) {
        const dir = sd.after > sd.before ? 'up' : sd.after < sd.before ? 'down' : 'same';
        const shape = `+${(sd.added || []).length}/-${(sd.removed || []).length}`;
        lines.push(`    ${sd.path}: ${sd.before} → ${sd.after} (${dir}, ${shape})`);
      }
    } else {
      lines.push(`  State diffs: (none)`);
    }
    const ves = sem.validationErrors || [];
    if (ves.length > 0) {
      lines.push(`  Validation errors:`);
      for (const ve of ves) {
        lines.push(`    ${ve.form}: ${ve.errorCount} error${ve.errorCount > 1 ? 's' : ''}`);
      }
    } else {
      lines.push(`  Validation errors: (none)`);
    }
    const dbs = sem.dataBinds || [];
    if (dbs.length > 0) {
      lines.push(`  Data binds:`);
      for (const db of dbs) {
        lines.push(`    ${db.component}: ${db.direction}`);
      }
    } else {
      lines.push(`  Data binds: (none)`);
    }
    const shapes = sem.appTraceShapes || {};
    const shapeLabels = Object.keys(shapes);
    if (shapeLabels.length > 0) {
      lines.push(`  App traces:`);
      for (const sl of shapeLabels) {
        const fields = Object.entries(shapes[sl]).map(([k, v]) => `${k}:[${v.join(',')}]`).join(' ');
        lines.push(`    ${sl}: ${fields}`);
      }
    } else {
      lines.push(`  App traces: (none)`);
    }
    if (showJourney && sem.journey) {
      lines.push('  Journey:');
      for (const step of sem.journey) {
        lines.push(`    ${step}`);
      }
    }
  }

  formatSemSummary('Before', report.before);
  formatSemSummary('After', report.after);

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
