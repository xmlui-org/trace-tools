/**
 * Generate Playwright test from distilled trace
 */

const { parseTrace } = require('./parse-trace');
const { distillTrace } = require('./distill-trace');

function generatePlaywright(distilled, options = {}) {
  const { testName = 'user-journey', baseUrl = '/', captureTrace = true, useHashRouting = true, browserErrors = false } = options;

  const lines = [
    `import { test, expect } from '@playwright/test';`,
    `import * as fs from 'fs';`,
    ``,
    `test('${testName}', async ({ page }) => {`,
  ];

  // Ensure startup step comes first
  const startupStep = distilled.steps.find(s => s.action === 'startup');
  const otherSteps = distilled.steps.filter(s => s.action !== 'startup');
  const preOrdered = startupStep ? [startupStep, ...otherSteps] : otherSteps;

  // Reorder so form fill → submit are adjacent (modal interactions can
  // interleave with background clicks in the captured trace).
  const orderedSteps = reorderFormSteps(preOrdered);

  // Pre-pass: match textbox interactions to formData fields so we can
  // generate fills using actual ariaNames instead of field-name guesses.
  const fillPlan = buildFillPlan(orderedSteps);

  // Detect starting page: if the first interaction has navigate.from on a
  // non-root path, the trace was captured on a subpage and the test needs
  // to navigate there after the initial goto('/')
  const firstInteraction = otherSteps[0];
  const startingPage = firstInteraction?.await?.navigate?.from;

  let responsePromiseCounter = 0;
  for (let si = 0; si < orderedSteps.length; si++) {
    const step = orderedSteps[si];
    lines.push('');
    lines.push(...generateStepCode(step, fillPlan, responsePromiseCounter, si));
    // Increment counter by the number of deduplicated API promises used
    if (step.action !== 'startup' && step.await?.api?.length > 0) {
      const seenPaths = new Set();
      for (const api of step.await.api) {
        const p = extractEndpointPath(api.endpoint || api);
        if (p) seenPaths.add(p);
      }
      responsePromiseCounter += Math.max(1, seenPaths.size);
    }

    // After a step that awaits a mutating API response (POST/PUT/DELETE),
    // the DOM may not have re-rendered yet. If the step also has a GET
    // (e.g. ListFolder refetch after a paste/move), wait for that GET first
    // since it triggers the re-render. Then peek at the next step's target
    // and emit a waitFor() so the selector doesn't race against React.
    if (step.await?.api?.length > 0 && step.action !== 'startup') {
      const hasMutation = step.await.api.some(a =>
        a.method === 'POST' || a.method === 'PUT' || a.method === 'DELETE'
      );
      if (hasMutation && si + 1 < orderedSteps.length) {
        // If this step also has a GET after the mutation (e.g. ListFolder
        // refetch after paste/move), the table needs to re-render before we
        // can interact with the next element. The waitFor() below handles that,
        // but we also need a small delay to let React process the response.
        const refreshGet = step.await.api.find(a => a.method === 'GET');
        if (refreshGet) {
          lines.push(`  await page.waitForTimeout(500);`);
        }
        const next = orderedSteps[si + 1];
        const nt = next?.target;
        if (nt?.ariaRole && nt?.ariaName) {
          if (nt.ariaRole === 'row') {
            lines.push(`  await ${rowLocator(nt.ariaName)}.waitFor();`);
          } else if (nt.ariaRole === 'button') {
            // Buttons may be disabled during state transitions (e.g. server restart);
            // wait for them to be enabled, not just present in the DOM.
            lines.push(`  await expect(page.getByRole('button', { name: '${nt.ariaName}', exact: true })).toBeEnabled({ timeout: 15000 });`);
          } else {
            lines.push(`  await page.getByRole('${nt.ariaRole}', { name: '${nt.ariaName}', exact: true }).waitFor();`);
          }
        }
      }
    }

    // After a step that triggers client-side navigation (e.g. Actions.navigate('?new=true'))
    // but has no API calls, the DOM re-renders (e.g. a modal appears) without any network
    // signal to wait on. Peek at the next step's target and emit a waitFor().
    if (step.await?.navigate && (!step.await?.api?.length) && step.action !== 'startup' && si + 1 < orderedSteps.length) {
      const next = orderedSteps[si + 1];
      const nt = next?.target;
      if (nt?.ariaRole && nt?.ariaName) {
        const exact = !['textbox', 'textarea'].includes(nt.ariaRole);
        lines.push(`  await page.getByRole('${nt.ariaRole}', { name: '${nt.ariaName}'${exact ? ', exact: true' : ''} }).waitFor();`);
      }
    }

    // After startup, install a modal observer to detect unexpected dialogs
    if (step.action === 'startup') {
      lines.push('');
      lines.push(`  // Monitor for modal dialogs (Conflict, error, etc.)`);
      lines.push(`  await page.evaluate(() => {`);
      lines.push(`    new MutationObserver(() => {`);
      lines.push(`      document.querySelectorAll('[role="dialog"]').forEach(d => {`);
      lines.push(`        if (d.getAttribute('data-modal-seen')) return;`);
      lines.push(`        d.setAttribute('data-modal-seen', '1');`);
      lines.push(`        const title = (d.querySelector('h2, h3, [class*="title"]') as HTMLElement)?.innerText || '';`);
      lines.push(`        const body = (d as HTMLElement).innerText?.slice(0, 300) || '';`);
      lines.push(`        console.log('__MODAL__:' + title + ' | ' + body);`);
      lines.push(`      });`);
      lines.push(`    }).observe(document.body, { childList: true, subtree: true });`);
      lines.push(`  });`);
    }

    // After startup, navigate to the starting page if it's not the root.
    // XMLUI apps use client-side routing, so page.goto() won't work —
    // click the nav label instead (path /users → click "USERS"), then
    // wait for the first interaction target to confirm the page rendered.
    // Skip navigation for root ('/') and single-segment default routes like '/my-files'
    // which are where the app lands after goto('./').  Only navigate for deeper paths
    // like '/users/settings' that require clicking through the app's navigation.
    const needsNavigation = startingPage && startingPage !== '/' &&
      startingPage.replace(/^\//, '').includes('/');
    if (step.action === 'startup' && needsNavigation) {
      const navLabel = startingPage.replace(/^\//, '').toUpperCase();
      lines.push('');
      lines.push(`  // Navigate to starting page (trace was captured on ${startingPage})`);
      lines.push(`  await page.getByText('${navLabel}', { exact: true }).click();`);

      // Wait for the first interaction's target element to confirm the page rendered
      const ft = firstInteraction?.target;
      if (ft?.ariaRole && ft?.ariaName) {
        lines.push(`  await page.getByRole('${ft.ariaRole}', { name: '${ft.ariaName}' }).waitFor();`);
      } else if (ft?.label) {
        lines.push(`  await page.getByText('${ft.label}', { exact: true }).waitFor();`);
      }
    }
  }

  lines.push(`});`);

  // Wrap the test body in try/finally to capture trace even on failure
  if (captureTrace) {
    // Find the test body start and wrap it
    const testStart = lines.findIndex(l => l.includes("test('"));
    const testEnd = lines.length - 1;

    // Insert error collection before try, and try block after
    lines.splice(testStart + 1, 0, `
  // Platform-aware modifier key (Meta on macOS, Control on Windows/Linux)
  const _mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  // Collect XMLUI runtime errors (ErrorBoundary, script errors, toast messages)
  const _xsErrors: string[] = [];
  const _modalsSeen: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') _xsErrors.push(msg.text());
    if (msg.text().startsWith('__MODAL__:')) _modalsSeen.push(msg.text().slice(10));
  });
  page.on('pageerror', err => _xsErrors.push(err.message));

  try {`);

    // Replace closing with finally block - handle browser already closed
    lines[lines.length - 1] = `  } finally {
    // Capture trace even on failure (if browser still open)
    try {
      await page.waitForTimeout(500);
      const logs = await page.evaluate(() => (window as any)._xsLogs || []);
      const traceFile = process.env.TRACE_OUTPUT || 'captured-trace.json';
      fs.writeFileSync(traceFile, JSON.stringify(logs, null, 2));
      console.log(\`Trace captured to \${traceFile} (\${logs.length} events)\`);
      // Report XMLUI errors from _xsLogs
      const errors = logs.filter((e: any) => e.kind?.startsWith('error'));
      if (errors.length > 0) {
        console.log('\\nXMLUI RUNTIME ERRORS:');
        errors.forEach((e: any) => console.log(\`  [\${e.kind}] \${e.error || e.text || JSON.stringify(e)}\`));
      }
    } catch (e) {
      console.log('Could not capture trace (browser may have closed)');
    }
    // Report modals that appeared during the test
    if (_modalsSeen.length > 0) {
      console.log('\\nMODALS:');
      _modalsSeen.forEach(m => console.log(\`  \${m}\`));
    }
    // Report visible table rows for diagnostics
    try {
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('table tbody tr'))
          .map(r => (r as HTMLElement).innerText?.split('\\t')[0]?.trim())
          .filter(Boolean)
      );
      if (rows.length > 0) {
        console.log('\\nVISIBLE ROWS: ' + rows.join(', '));
      }
    } catch (_) {}
    // Report console errors collected during the test (opt-in via --browser-errors)
    if (${browserErrors} && _xsErrors.length > 0) {
      console.log('\\nBROWSER ERRORS:');
      _xsErrors.forEach(e => console.log(\`  \${e}\`));
    }
  }
});`;
  }

  return lines.join('\n');
}

/**
 * Reorder steps so that form interactions (keydowns on textboxes and their
 * submit button clicks) are grouped together. When a user types into a modal
 * form, they may also click on elements behind the modal; the trace captures
 * these interleaved events chronologically, but Playwright must complete the
 * form before interacting with elements underneath.
 *
 * Strategy: find each textbox keydown sequence, locate its submit button,
 * and move any non-form steps between the first keydown and the submit to
 * after the submit.
 */
function reorderFormSteps(steps) {
  const result = [...steps];

  // Find submit steps (clicks with formData)
  function isSubmit(s) {
    return s.action === 'click' && s.target?.formData && typeof s.target.formData === 'object';
  }

  // Detect interleaving: a non-keydown step appears BETWEEN two keydowns
  // on the same textbox before the submit. This is the signal that background
  // clicks happened while a modal form was open.
  function hasInterleaving(steps, fillStart, submitIdx, ariaName) {
    let sawNonKeydown = false;
    let sawSecondKeydown = false;
    for (let j = fillStart + 1; j < submitIdx; j++) {
      const s = steps[j];
      const isSameKeydown = s.action === 'keydown' && s.target?.ariaRole === 'textbox' &&
                             s.target?.ariaName === ariaName;
      if (!isSameKeydown) {
        sawNonKeydown = true;
      } else if (sawNonKeydown) {
        sawSecondKeydown = true;
        break;
      }
    }
    return sawNonKeydown && sawSecondKeydown;
  }

  // Iterate and group form sequences
  let i = 0;
  while (i < result.length) {
    const step = result[i];

    // Look for the start of a form fill (keydown on textbox)
    if (step.action === 'keydown' && step.target?.ariaRole === 'textbox') {
      const formAriaName = step.target.ariaName;
      const fillStart = i;

      // Find the corresponding submit: next click with formData after this point
      let submitIdx = -1;
      for (let j = i + 1; j < result.length; j++) {
        if (isSubmit(result[j])) {
          submitIdx = j;
          break;
        }
      }

      if (submitIdx === -1) { i++; continue; }

      // Only reorder if keydowns on this textbox are interleaved with
      // non-keydown steps (evidence of background clicks during modal form)
      if (!hasInterleaving(result, fillStart, submitIdx, formAriaName)) {
        i++;
        continue;
      }

      // Collect steps between fillStart and submitIdx. Keep only keydowns
      // on the SAME textbox (same ariaName) — these are continuation of
      // the same typing sequence. Everything else is deferred to after submit.
      const deferred = [];
      const kept = [];
      for (let j = fillStart + 1; j < submitIdx; j++) {
        const s = result[j];
        if (s.action === 'keydown' && s.target?.ariaRole === 'textbox' &&
            s.target?.ariaName === formAriaName) {
          kept.push(s);
        } else {
          deferred.push(s);
        }
      }

      // Rebuild: [fillStart, ...kept keydowns, submit, ...deferred]
      const submit = result[submitIdx];
      result.splice(fillStart + 1, submitIdx - fillStart);
      result.splice(fillStart + 1, 0, ...kept, submit, ...deferred);

      // Advance past the submit
      i = fillStart + 1 + kept.length + 1; // past submit
    } else {
      i++;
    }
  }

  return result;
}

/**
 * Pre-scan steps to match textbox interactions to formData fields on submit.
 * Returns a plan: which textbox clicks/keydowns get fill() calls.
 *
 * Supports multiple form submissions in a single journey by pairing each
 * textbox interaction with its nearest following submit step.
 */
function buildFillPlan(steps) {
  // Find ALL submit steps (clicks with formData)
  const submitSteps = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].action === 'click' && steps[i].target?.formData &&
        typeof steps[i].target.formData === 'object') {
      submitSteps.push({ index: i, formData: steps[i].target.formData });
    }
  }
  if (submitSteps.length === 0) return { fills: new Map(), coveredFields: new Set() };

  // For each textbox interaction, find the next submit step and match to its formData.
  // Use a queue per ariaName so repeated interactions on the same field (e.g. two renames)
  // each get their own fill value.
  const fillQueues = new Map(); // ariaName → [{ fieldName, value }, ...]
  const coveredFields = new Set();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if ((step.action === 'click' || step.action === 'keydown') &&
        step.target?.ariaRole === 'textbox' && step.target?.ariaName) {
      const ariaName = step.target.ariaName;

      // Find the next submit step after this interaction
      const nextSubmit = submitSteps.find(s => s.index > i);
      if (!nextSubmit) continue;

      // Skip if we already planned a fill for this ariaName for this submit
      const queue = fillQueues.get(ariaName) || [];
      if (queue.length > 0 && queue[queue.length - 1]._submitIndex === nextSubmit.index) continue;

      const stringFields = Object.entries(nextSubmit.formData).filter(([, v]) => typeof v === 'string');
      let bestMatch = null;
      let bestScore = 0;
      for (const [fieldName, value] of stringFields) {
        const score = fieldMatchScore(fieldName, ariaName);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { fieldName, value, _submitIndex: nextSubmit.index };
        }
      }

      if (bestMatch) {
        queue.push(bestMatch);
        fillQueues.set(ariaName, queue);
        coveredFields.add(bestMatch.fieldName);
      }
    }
  }

  // Convert queues to a Map-like interface: fills.get(ariaName) returns next value
  const fills = {
    has(ariaName) { return fillQueues.has(ariaName) && fillQueues.get(ariaName).length > 0; },
    get(ariaName) { return fillQueues.get(ariaName)?.[0]; },
    consume(ariaName) { const q = fillQueues.get(ariaName); if (q) q.shift(); }
  };

  return { fills, coveredFields };
}

/**
 * Score how well a formData field name matches a UI label (ariaName).
 * Higher = better match.
 *   "password" vs "Password:" → high (exact word match)
 *   "name" vs "User Name:" → medium (partial word match)
 *   "rootDirectory" vs "Home Directory:" → low (only "directory" matches)
 */
function fieldMatchScore(fieldName, ariaName) {
  const normalizedAria = ariaName.toLowerCase().replace(/[:\s*]+/g, '');
  const normalizedField = fieldName.toLowerCase();

  // Exact match after normalization
  if (normalizedAria === normalizedField) return 100;

  // Full field name appears in ariaName
  if (normalizedAria.includes(normalizedField)) return 50 + normalizedField.length;

  // Split camelCase field name into words and check each
  const parts = fieldName.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
  const matchedLength = parts
    .filter(p => normalizedAria.includes(p))
    .reduce((sum, p) => sum + p.length, 0);

  return matchedLength;
}

/**
 * Build a Playwright locator string for a table row by its first-cell text.
 * A row's accessible name is ALL cells concatenated, so getByRole('row', { name, exact })
 * either over-matches (substring) or fails (exact). Instead, filter by the cell content.
 */
function rowLocator(ariaName) {
  const escaped = ariaName.replace(/'/g, "\\'");
  return `page.getByRole('row').filter({ has: page.getByRole('cell', { name: '${escaped}', exact: true }) })`;
}

/**
 * Build Playwright click options string from step target modifiers and extra options.
 * Returns '' for a plain click, or '{ modifiers: [...] }' / '{ button: "right", modifiers: [...] }' etc.
 */
function clickOptions(target, extra = {}) {
  const modifiers = [];
  if (target?.ctrlKey || target?.metaKey) modifiers.push("_mod");
  if (target?.shiftKey) modifiers.push("'Shift'");
  if (target?.altKey) modifiers.push("'Alt'");

  const opts = { ...extra };
  if (modifiers.length > 0) opts.modifiers = modifiers;

  const entries = Object.entries(opts);
  if (entries.length === 0) return '';

  const parts = entries.map(([k, v]) => {
    if (k === 'modifiers') return `modifiers: [${v.join(', ')}]`;
    if (typeof v === 'string') return `${k}: '${v}'`;
    return `${k}: ${v}`;
  });
  return `{ ${parts.join(', ')} }`;
}

function generateStepCode(step, fillPlan, promiseCounter = 0, stepIndex = 0) {
  const lines = [];
  const indent = '  ';

  // Comment describing the step
  lines.push(`${indent}// ${step.action}: ${step.target?.label || step.target?.component || 'startup'}`);

  // For non-startup steps with API awaits, set up response promises BEFORE
  // the action to avoid race conditions (response arriving before waitForResponse).
  // Deduplicate by endpoint path so we don't wait for the same URL twice.
  // Skip for treeitem contextmenu — generateContextMenuCode already awaits ListFolder.
  // For mutating methods (POST/PUT/DELETE/PATCH), include method in the filter
  // to avoid catching polling GET responses that share the same URL path.
  const isTreeContextMenu = step.action === 'contextmenu' && step.target?.ariaRole === 'treeitem';
  const apiAwaits = [];
  if (step.action !== 'startup' && step.await?.api?.length > 0 && !isTreeContextMenu) {
    const hasMutation = step.await.api.some(a =>
      ['POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method));
    const seenPaths = new Set();
    for (const api of step.await.api) {
      // When a step includes a mutating call, only await the mutation(s) —
      // coincidental GETs (polling, refetches) are unreliable during replay.
      if (hasMutation && !['POST', 'PUT', 'DELETE', 'PATCH'].includes(api.method)) continue;
      const path = extractEndpointPath(api.endpoint || api);
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        apiAwaits.push({ path, method: api.method, varName: `responsePromise${promiseCounter}_${apiAwaits.length}` });
      }
    }
    for (const { path, varName, method } of apiAwaits) {
      // Encode spaces in endpoint paths so they match URL-encoded requests
      const urlPath = path.replace(/ /g, '%20');
      const isMutating = method && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method);
      if (isMutating) {
        lines.push(`${indent}const ${varName} = page.waitForResponse(r => r.url().includes('${urlPath}') && r.request().method() === '${method}');`);
      } else {
        lines.push(`${indent}const ${varName} = page.waitForResponse(r => r.url().includes('${urlPath}'));`);
      }
    }
  }

  switch (step.action) {
    case 'startup':
      if (step.await?.api?.length > 0) {
        const firstApi = step.await.api[0];
        const endpoint = extractEndpointPath(firstApi);
        // Wait for initial data load by combining goto with response wait
        // Use './' so Playwright resolves relative to baseURL (preserves path like /ui/)
        lines.push(`${indent}await Promise.all([`);
        lines.push(`${indent}  page.waitForResponse(r => r.url().includes('${endpoint}')),`);
        lines.push(`${indent}  page.goto('./'),`);
        lines.push(`${indent}]);`);
      } else {
        lines.push(`${indent}await page.goto('./');`);
      }
      break;

    case 'click': {
      // Skip clicks on unnamed form inputs — just focus noise
      if (step.target?.ariaRole && !step.target?.ariaName &&
          ['textbox', 'textarea'].includes(step.target.ariaRole) &&
          !step.target?.formData) {
        lines.pop();
        return [];
      }
      // Skip clicks on unnamed structural roles (banner, navigation, etc.) — noise
      // Only keep if there are mutating API calls (not just coincidental GETs)
      if (step.target?.ariaRole && !step.target?.ariaName &&
          ['banner', 'navigation', 'main', 'contentinfo', 'complementary'].includes(step.target.ariaRole) &&
          !step.await?.api?.some(a => ['POST', 'PUT', 'DELETE', 'PATCH'].includes(a.method))) {
        lines.pop();
        return [];
      }
      const clickLines = generateClickCode(step, indent, 'click', fillPlan);
      lines.push(...clickLines);
      if (clickLines._skipAwait) {
        return lines;
      }
      break;
    }

    case 'contextmenu':
      lines.push(...generateContextMenuCode(step, indent));
      break;

    case 'dblclick':
      lines.push(...generateClickCode(step, indent, 'dblclick', fillPlan));
      break;

    case 'keydown': {
      // Keydowns on textboxes covered by the fill plan: generate fill() on the
      // first keydown for each form interaction, skip subsequent ones.
      const kdAriaName = step.target?.ariaName;
      if (step.target?.ariaRole === 'textbox' && kdAriaName && fillPlan.fills?.has(kdAriaName)) {
        // Track which ariaNames we've already filled so that subsequent keydowns
        // for the same field (remaining keystrokes) are skipped. Reset when we
        // encounter a new click on the same field (next form).
        if (!fillPlan._filledInCurrentForm) fillPlan._filledInCurrentForm = new Set();
        if (fillPlan._filledInCurrentForm.has(kdAriaName)) {
          lines.pop();
          return [];
        }
        const entry = fillPlan.fills.get(kdAriaName);
        fillPlan.fills.consume(kdAriaName);
        fillPlan._filledInCurrentForm.add(kdAriaName);
        lines.push(`${indent}await page.getByRole('textbox', { name: '${kdAriaName}' }).fill('${entry.value.replace(/'/g, "\\'")}');`);
        return lines;
      }
      // Skip keydowns not covered by fill plan
      lines.pop();
      return [];
    }

    case 'toast':
      for (const toast of step.toasts || []) {
        const escaped = toast.message.replace(/'/g, "\\'");
        lines.push(`${indent}await expect(page.locator('[role="status"]').filter({ hasText: '${escaped}' })).toBeVisible({ timeout: 5000 });`);
      }
      break;

    default:
      lines.push(`${indent}// TODO: handle action "${step.action}"`);
  }

  // Handle confirmation dialogs that appear during this step.
  // Each dialog may appear asynchronously (e.g. Conflict dialogs appear after the
  // server detects a conflict during copy/paste). Always waitFor() the dialog button
  // before clicking — harmless if the dialog is already open, essential if it's async.
  if (step.modals?.length > 0) {
    lines.push(...generateModalCode(step.modals, indent));
  }

  // Await all response promises set up before the action
  if (apiAwaits.length === 1) {
    lines.push(`${indent}await ${apiAwaits[0].varName};`);
  } else if (apiAwaits.length > 1) {
    lines.push(`${indent}await Promise.all([${apiAwaits.map(a => a.varName).join(', ')}]);`);
  }

  // Add navigation await conditions (skip for startup - already handled inline)
  if (step.await && step.action !== 'startup') {
    lines.push(...generateNavigateAwaitCode(step.await, indent));
  }

  // Assert toast notifications that appeared during this step
  // Use [role="status"] selector because toast container has aria-hidden="true",
  // making getByText unreliable when multiple toasts are visible simultaneously
  if (step.toasts?.length > 0) {
    for (const t of step.toasts) {
      const escaped = t.message.replace(/'/g, "\\'");
      lines.push(`${indent}await expect(page.locator('[role="status"]').filter({ hasText: '${escaped}' })).toBeVisible({ timeout: 5000 });`);
    }
  }

  // Assert DataSource changes after mutating operations
  if (step.dataSourceChanges?.length > 0) {
    for (const change of step.dataSourceChanges) {
      for (const name of (change.added || [])) {
        const escaped = name.replace(/'/g, "\\'");
        lines.push(`${indent}await expect(page.getByRole('cell', { name: '${escaped}', exact: true })).toBeVisible({ timeout: 10000 });`);
      }
      for (const name of (change.removed || [])) {
        const escaped = name.replace(/'/g, "\\'");
        lines.push(`${indent}await expect(page.getByRole('cell', { name: '${escaped}', exact: true })).toHaveCount(0);`);
      }
    }
  }

  return lines;
}

function generateClickCode(step, indent, method = 'click', fillPlan = {}) {
  const lines = [];
  const label = step.target?.label;
  const ariaRole = step.target?.ariaRole;
  const ariaName = step.target?.ariaName;
  const targetTag = step.target?.targetTag;
  const formData = step.target?.formData;
  const opts = clickOptions(step.target);
  const callSuffix = opts ? `(${opts})` : '()';
  const methodCall = `.${method}${callSuffix}`;

  // Textbox click with ariaName: generate fill() if we matched a formData field
  if (ariaRole === 'textbox' && ariaName && fillPlan.fills?.has(ariaName)) {
    const { value } = fillPlan.fills.get(ariaName);
    fillPlan.fills.consume(ariaName);
    if (!fillPlan._filledInCurrentForm) fillPlan._filledInCurrentForm = new Set();
    fillPlan._filledInCurrentForm.add(ariaName);
    lines.push(`${indent}await page.getByRole('textbox', { name: '${ariaName}' }).fill('${value.replace(/'/g, "\\'")}');`);
    return lines;
  }

  // Form submit button: fill any formData fields not already covered by textbox
  // interactions (e.g. when the trace comes from a Playwright capture that uses
  // .fill() instead of keydown events).
  // Only emit uncovered fills when there were textbox interactions for THIS specific
  // form submission (tracked via _filledInCurrentForm). If no fields were filled
  // for this submit, it's a save-without-changes — skip synthesized fills.
  // Clear the per-form fill tracker so the next form's fields can be filled.
  if (formData && typeof formData === 'object') {
    const hadInteractions = fillPlan._filledInCurrentForm && fillPlan._filledInCurrentForm.size > 0;
    if (fillPlan._filledInCurrentForm) fillPlan._filledInCurrentForm.clear();
    // NOTE: Previously emitted fill() calls for uncovered formData fields using
    // camelCase-derived labels, but these don't match actual UI labels reliably
    // (e.g. "SFTPRootDir" → "SF T P Root Dir" vs actual "Default Root Directory:").
    // Disabled until we have a reliable field-name-to-label mapping.
    // Fields with textbox interactions are filled via the fill plan above.
  }

  // Checkbox in a table row: hover the row first to make the checkbox visible
  // (XMLUI tables hide selection checkboxes until row hover)
  if (ariaRole === 'checkbox' && ariaName?.startsWith('Select ')) {
    const rowName = ariaName.replace('Select ', '');
    lines.push(`${indent}await ${rowLocator(rowName)}.hover();`);
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}', exact: true })${methodCall};`);
    return lines;
  }

  // Checkboxes in forms: wait briefly for data sources to finish populating the
  // form before interacting, to avoid the checkbox state being overwritten after
  // clicking. Then scroll into view since they may be deep in a long page.
  if (ariaRole === 'checkbox' && ariaName && !ariaName.startsWith('Select ')) {
    lines.push(`${indent}await page.waitForTimeout(1000);`);
    lines.push(`${indent}{ const el = page.getByRole('checkbox', { name: '${ariaName}', exact: true });`);
    lines.push(`${indent}  await el.scrollIntoViewIfNeeded();`);
    lines.push(`${indent}  await el.${method}(); }`);
    return lines;
  }

  // Buttons: scroll the button's nearest scrollable ancestor to the top so
  // sticky submit buttons drop out of sticky position and clear any fixed
  // app header that overlaps them.
  if (ariaRole === 'button' && ariaName) {
    lines.push(`${indent}await page.getByRole('button', { name: '${ariaName}', exact: true }).evaluate(node => {`);
    lines.push(`${indent}  let el = node.parentElement;`);
    lines.push(`${indent}  while (el && el !== document.documentElement) {`);
    lines.push(`${indent}    if (el.scrollHeight > el.clientHeight) { el.scrollTop = 0; break; }`);
    lines.push(`${indent}    el = el.parentElement;`);
    lines.push(`${indent}  }`);
    lines.push(`${indent}  window.scrollTo(0, 0);`);
    lines.push(`${indent}});`);
    lines.push(`${indent}await page.getByRole('button', { name: '${ariaName}', exact: true }).${method}();`);
    return lines;
  }

  // Best: ARIA role + name → getByRole(role, { name, exact: true })
  // For rows, use .filter() with a cell matcher since a row's accessible name
  // is the concatenation of ALL cells (e.g. "foo 0 KiB 2024-01-01"), not just
  // the filename. A cell's accessible name IS its text, so exact matching works.
  // For textbox/textarea, skip exact: XMLUI labels may include required indicators
  // (e.g. "User Name:*") that aren't in the trace's ariaName.
  if (ariaRole && ariaName) {
    const exact = !['textbox', 'textarea'].includes(ariaRole);
    if (ariaRole === 'row') {
      lines.push(`${indent}await ${rowLocator(ariaName)}${methodCall};`);
    } else if (ariaRole === 'treeitem' &&
               ((targetTag === 'svg' || targetTag === 'polyline') ||
                ((targetTag === 'DIV' || targetTag === 'SPAN') && !step.await?.api?.length))) {
      // XMLUI TreeView: click was on the toggle arrow (expand/collapse), not the label.
      // Detected by SVG/polyline targetTag, or DIV/SPAN with no API calls (pure visual toggle).
      lines.push(`${indent}await page.getByRole('treeitem', { name: '${ariaName}', exact: true }).locator('[class*="toggleWrapper"]')${methodCall};`);
      lines.push(`${indent}await page.waitForTimeout(300);`);
      lines._skipAwait = true;
    } else {
      lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}'${exact ? ', exact: true' : ''} })${methodCall};`);
    }
    return lines;
  }

  // ARIA role without name — accessibility gap, but still usable if unique
  if (ariaRole && !ariaName) {
    lines.push(`${indent}// ACCESSIBILITY GAP: ${ariaRole} has no accessible name`);
    lines.push(`${indent}await page.getByRole('${ariaRole}')${methodCall};`);
    return lines;
  }

  // Fallback: use label with getByText (exact match to avoid ambiguity)
  if (label) {
    lines.push(`${indent}await page.getByText('${label}', { exact: true })${methodCall};`);
    return lines;
  }

  // No ARIA, no label — not actionable
  lines.push(`${indent}// ACCESSIBILITY GAP: ${step.target?.testId || targetTag || 'element'} has no role or accessible name`);
  return lines;
}

function generateContextMenuCode(step, indent) {
  const lines = [];
  const ariaRole = step.target?.ariaRole;
  const ariaName = step.target?.ariaName;
  const label = step.target?.label;
  const opts = clickOptions(step.target, { button: 'right' });

  if (ariaRole && ariaName) {
    if (ariaRole === 'row') {
      lines.push(`${indent}await ${rowLocator(ariaName)}.click(${opts});`);
    } else if (ariaRole === 'treeitem') {
      // XMLUI TreeView: right-clicking a treeitem also triggers navigation
      // (the tree's contextMenu handler fires after a delay). We must wait
      // for the ListFolder response before interacting with the context menu.
      lines.push(`${indent}const _treeCtxNav = page.waitForResponse(r => r.url().includes('ListFolder'));`);
      lines.push(`${indent}await page.getByRole('treeitem', { name: '${ariaName}', exact: true }).click(${opts});`);
      lines.push(`${indent}await _treeCtxNav;`);
    } else {
      lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}', exact: true }).click(${opts});`);
    }
  } else if (label) {
    lines.push(`${indent}await page.getByText('${label}', { exact: true }).click(${opts});`);
  } else {
    lines.push(`${indent}// ACCESSIBILITY GAP: ${step.target?.testId || 'element'} has no role or accessible name (context menu)`);
  }

  return lines;
}

/**
 * Generate code for confirmation dialogs that appear during a step.
 *
 * Simple case: each modal has a unique title → emit sequential clicks.
 * Complex case: multiple modals share a title but get different actions
 * (e.g. two "Conflict" dialogs where one is closed and the other confirmed).
 * In that case, emit a loop that reads dialog text at runtime to decide,
 * since queue processing order may vary between runs.
 */
function generateModalCode(modals, indent) {
  const lines = [];

  // Group modals by title to detect the "same title, different action" pattern
  const byTitle = new Map();
  for (const m of modals) {
    const t = m.title || 'confirm';
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(m);
  }

  // Check if any title group has mixed actions (confirm vs cancel)
  const hasMixedGroup = [...byTitle.values()].some(group =>
    group.length > 1 && new Set(group.map(m => m.action)).size > 1
  );

  if (hasMixedGroup) {
    // Emit a runtime-branching loop for the mixed groups
    for (const [title, group] of byTitle) {
      if (group.length > 1 && new Set(group.map(m => m.action)).size > 1) {
        // Count how many of each action
        const confirms = group.filter(m => m.action === 'confirm');
        const cancels = group.filter(m => m.action === 'cancel');
        lines.push('');
        lines.push(`${indent}// Handle ${group.length} "${title}" dialogs (order may vary at runtime)`);
        lines.push(`${indent}for (let _dlg = 0; _dlg < ${group.length}; _dlg++) {`);
        // Wait for the dialog's action button to appear
        const waitButton = confirms[0]?.buttonLabel || confirms[0]?.buttons?.[0]?.label || 'OK';
        lines.push(`${indent}  await page.getByRole('button', { name: '${waitButton}', exact: true }).waitFor({ timeout: 10000 });`);
        lines.push(`${indent}  const _dialogText = await page.locator('[role="dialog"]').last().innerText();`);

        // Generate branches for each distinct action
        // Use the confirm branch as the "if" and cancel as "else"
        if (confirms.length > 0 && cancels.length > 0) {
          // Determine a text hint to distinguish — use "File" vs "Folder" as common pattern
          lines.push(`${indent}  if (_dialogText.includes('File')) {`);
          if (cancels[0].action === 'cancel') {
            lines.push(`${indent}    // File conflict — skip`);
            lines.push(`${indent}    await page.locator('[role="dialog"]').last().locator('button[aria-label="Close"]').click();`);
          } else {
            const btn = cancels[0].buttonLabel || 'Cancel';
            lines.push(`${indent}    await page.getByRole('dialog').last().getByRole('button', { name: '${btn}', exact: true }).click();`);
          }
          lines.push(`${indent}  } else {`);
          const confirmBtn = confirms[0].buttonLabel || confirms[0].buttons?.[confirms.length - 1]?.label || 'OK';
          lines.push(`${indent}    // Folder conflict — ${confirmBtn}`);
          lines.push(`${indent}    await page.getByRole('dialog').last().getByRole('button', { name: '${confirmBtn}', exact: true }).click();`);
          lines.push(`${indent}  }`);
        }
        lines.push(`${indent}  await page.waitForTimeout(500);`);
        lines.push(`${indent}}`);
      } else {
        // Single or uniform group — emit sequentially
        for (const modal of group) {
          lines.push(...generateSingleModalCode(modal, indent));
        }
      }
    }
  } else {
    // All modals have unique titles or uniform actions — emit sequentially
    for (const modal of modals) {
      lines.push(...generateSingleModalCode(modal, indent));
    }
  }

  return lines;
}

function generateSingleModalCode(modal, indent) {
  const lines = [];
  lines.push('');
  lines.push(`${indent}// Confirmation dialog: "${modal.title || 'confirm'}"`);
  if (modal.action === 'confirm' && modal.buttonLabel) {
    // waitFor() before click — harmless if dialog is already open, essential if async
    lines.push(`${indent}await page.getByRole('button', { name: '${modal.buttonLabel}', exact: true }).waitFor();`);
    lines.push(`${indent}await page.getByRole('dialog').last().getByRole('button', { name: '${modal.buttonLabel}', exact: true }).click();`);
  } else if (modal.action === 'cancel') {
    lines.push(`${indent}await page.locator('[role="dialog"]').last().locator('button[aria-label="Close"]').waitFor();`);
    lines.push(`${indent}await page.locator('[role="dialog"]').last().locator('button[aria-label="Close"]').click();`);
  } else if (modal.action === 'confirm' && modal.buttons?.length > 0) {
    const actionBtn = modal.buttons[modal.buttons.length - 1];
    lines.push(`${indent}await page.getByRole('button', { name: '${actionBtn.label}', exact: true }).waitFor();`);
    lines.push(`${indent}await page.getByRole('dialog').last().getByRole('button', { name: '${actionBtn.label}', exact: true }).click();`);
  } else {
    lines.push(`${indent}// TODO: resolve confirmation dialog (value=${JSON.stringify(modal.value)})`);
  }
  return lines;
}

function generateNavigateAwaitCode(awaitConditions, indent) {
  const lines = [];

  // Wait for navigation (polls automatically, safe to place after action)
  if (awaitConditions.navigate) {
    const to = awaitConditions.navigate.to;
    // Extract meaningful part of URL for matching
    const folderMatch = to.match(/folder=([^&]+)/);
    if (folderMatch) {
      const folder = decodeURIComponent(folderMatch[1]);
      lines.push(`${indent}await page.waitForURL('**/*folder=${encodeURIComponent(folder)}*');`);
    }
  }

  return lines;
}

function extractEndpointPath(endpoint) {
  if (typeof endpoint === 'string') {
    // Remove query params for matching
    return endpoint.split('?')[0].replace(/^\//, '');
  }
  if (endpoint?.endpoint) {
    return endpoint.endpoint.split('?')[0].replace(/^\//, '');
  }
  return '';
}

// Export
if (typeof module !== 'undefined') {
  module.exports = { generatePlaywright };
}

// CLI usage
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const { distillJsonLogs } = require('./distill-trace');

  const args = process.argv.slice(2);
  const browserErrors = args.includes('--browser-errors');
  const positional = args.filter(a => !a.startsWith('--'));
  const inputFile = positional[0] || '/dev/stdin';
  const testName = positional[1] || 'user-journey';
  const input = fs.readFileSync(inputFile, 'utf8');

  // Detect routing mode from the app's config.json (check parent dir first)
  let useHashRouting = true; // XMLUI default
  const parentConfig = path.join(__dirname, '..', 'config.json');
  const localConfig = path.join(__dirname, 'config.json');
  const configPath = fs.existsSync(parentConfig) ? parentConfig : (fs.existsSync(localConfig) ? localConfig : null);
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
      const config = JSON.parse(raw);
      if (config.appGlobals?.useHashBasedRouting === false) {
        useHashRouting = false;
      }
    } catch (e) { /* ignore parse errors */ }
  }

  let distilled;

  // Detect JSON vs text format
  if (input.trim().startsWith('[') || input.trim().startsWith('{')) {
    // JSON format - use distillJsonLogs
    const logs = JSON.parse(input);
    distilled = distillJsonLogs(logs);
  } else {
    // Text format - use parseTrace + distillTrace
    const parsed = parseTrace(input);
    distilled = distillTrace(parsed);
  }

  const playwright = generatePlaywright(distilled, { testName, useHashRouting, browserErrors });
  console.log(playwright);
}
