/**
 * Generate Playwright test from normalized trace
 */

const { parseTrace } = require('./parse-trace');
const { normalizeTrace } = require('./normalize-trace');

function generatePlaywright(normalized, options = {}) {
  const { testName = 'user-journey', baseUrl = '/', captureTrace = true, useHashRouting = true, browserErrors = false } = options;

  const lines = [
    `import { test, expect } from '@playwright/test';`,
    `import * as fs from 'fs';`,
    ``,
    `test('${testName}', async ({ page }) => {`,
  ];

  // Ensure startup step comes first
  const startupStep = normalized.steps.find(s => s.action === 'startup');
  const otherSteps = normalized.steps.filter(s => s.action !== 'startup');
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

  for (let si = 0; si < orderedSteps.length; si++) {
    const step = orderedSteps[si];
    lines.push('');
    lines.push(...generateStepCode(step, fillPlan));

    // After a step that awaits a mutating API response (POST/PUT/DELETE),
    // the DOM may not have re-rendered yet. Peek at the next step's target
    // and emit a waitFor() so the selector doesn't race against React.
    if (step.await?.api?.length > 0 && step.action !== 'startup') {
      const hasMutation = step.await.api.some(a =>
        a.method === 'POST' || a.method === 'PUT' || a.method === 'DELETE'
      );
      if (hasMutation && si + 1 < orderedSteps.length) {
        const next = orderedSteps[si + 1];
        const nt = next?.target;
        if (nt?.ariaRole && nt?.ariaName) {
          const exact = nt.ariaRole === 'row' ? '' : ', exact: true';
          lines.push(`  await page.getByRole('${nt.ariaRole}', { name: '${nt.ariaName}'${exact} }).waitFor();`);
        } else if (nt?.label) {
          lines.push(`  await page.getByText('${nt.label}', { exact: true }).waitFor();`);
        }
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
    if (step.action === 'startup' && startingPage && startingPage !== '/') {
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

function generateStepCode(step, fillPlan) {
  const lines = [];
  const indent = '  ';

  // Comment describing the step
  lines.push(`${indent}// ${step.action}: ${step.target?.label || step.target?.component || 'startup'}`);

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
        const { value } = fillPlan.fills.get(kdAriaName);
        fillPlan.fills.consume(kdAriaName);
        lines.push(`${indent}await page.getByRole('textbox', { name: '${kdAriaName}' }).fill('${value.replace(/'/g, "\\'")}');`);
        return lines;
      }
      // Skip keydowns not covered by fill plan
      lines.pop();
      return [];
    }

    default:
      lines.push(`${indent}// TODO: handle action "${step.action}"`);
  }

  // Add await conditions (skip for startup - already handled inline)
  if (step.await && step.action !== 'startup') {
    lines.push(...generateAwaitCode(step.await, indent));
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

  // Textbox click with ariaName: generate fill() if we matched a formData field
  if (ariaRole === 'textbox' && ariaName && fillPlan.fills?.has(ariaName)) {
    const { value } = fillPlan.fills.get(ariaName);
    fillPlan.fills.consume(ariaName);
    lines.push(`${indent}await page.getByRole('textbox', { name: '${ariaName}' }).fill('${value.replace(/'/g, "\\'")}');`);
    return lines;
  }

  // Form submit button: only fill fields the user actually interacted with
  // (handled above via fillPlan). Fields the user didn't touch have defaults
  // and should not be filled — their field names often don't match UI labels.

  // Checkbox in a table row: hover the row first to make the checkbox visible
  // (XMLUI tables hide selection checkboxes until row hover)
  if (ariaRole === 'checkbox' && ariaName?.startsWith('Select ')) {
    const rowName = ariaName.replace('Select ', '');
    lines.push(`${indent}await page.getByRole('row', { name: '${rowName}' }).hover();`);
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}', exact: true }).${method}();`);
    return lines;
  }

  // Best: ARIA role + name → getByRole(role, { name, exact: true })
  // For 'row' role, skip exact since the row's accessible name is the full
  // row text content and we're matching by the clicked cell's text
  if (ariaRole && ariaName) {
    const exact = ariaRole === 'row' ? '' : ', exact: true';
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}'${exact} }).${method}();`);
    return lines;
  }

  // ARIA role without name — accessibility gap, but still usable if unique
  if (ariaRole && !ariaName) {
    lines.push(`${indent}// ACCESSIBILITY GAP: ${ariaRole} has no accessible name`);
    lines.push(`${indent}await page.getByRole('${ariaRole}').${method}();`);
    return lines;
  }

  // Fallback: use label with getByText (exact match to avoid ambiguity)
  if (label) {
    lines.push(`${indent}await page.getByText('${label}', { exact: true }).${method}();`);
    return lines;
  }

  // Fallback: testId when no ARIA or label
  if (step.target?.testId) {
    lines.push(`${indent}await page.getByTestId('${step.target.testId}').${method}();`);
    return lines;
  }

  // No ARIA, no label, no testId — not actionable
  lines.push(`${indent}// ACCESSIBILITY GAP: ${targetTag || 'element'} has no role or accessible name`);
  return lines;
}

function generateContextMenuCode(step, indent) {
  const lines = [];
  const ariaRole = step.target?.ariaRole;
  const ariaName = step.target?.ariaName;
  const label = step.target?.label;

  if (ariaRole && ariaName) {
    const exact = ariaRole === 'row' ? '' : ', exact: true';
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}'${exact} }).click({ button: 'right' });`);
  } else if (label) {
    lines.push(`${indent}await page.getByText('${label}', { exact: true }).click({ button: 'right' });`);
  } else if (step.target?.testId) {
    lines.push(`${indent}await page.getByTestId('${step.target.testId}').click({ button: 'right' });`);
  } else {
    lines.push(`${indent}// ACCESSIBILITY GAP: context menu target has no role or accessible name`);
  }

  return lines;
}

function generateAwaitCode(awaitConditions, indent) {
  const lines = [];

  // Wait for navigation
  if (awaitConditions.navigate) {
    const to = awaitConditions.navigate.to;
    // Extract meaningful part of URL for matching
    const folderMatch = to.match(/folder=([^&]+)/);
    if (folderMatch) {
      const folder = decodeURIComponent(folderMatch[1]);
      lines.push(`${indent}await page.waitForURL('**/*folder=${encodeURIComponent(folder)}*');`);
    }
  }

  // Wait for API calls (just the first significant one to avoid over-waiting)
  if (awaitConditions.api?.length > 0) {
    const api = awaitConditions.api.find(a => a.method === 'GET' || a.method === 'POST') || awaitConditions.api[0];
    if (api) {
      const path = extractEndpointPath(api.endpoint || api);
      lines.push(`${indent}await page.waitForResponse(r => r.url().includes('${path}'));`);
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
  const { normalizeJsonLogs } = require('./normalize-trace');

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

  let normalized;

  // Detect JSON vs text format
  if (input.trim().startsWith('[') || input.trim().startsWith('{')) {
    // JSON format - use normalizeJsonLogs
    const logs = JSON.parse(input);
    normalized = normalizeJsonLogs(logs);
  } else {
    // Text format - use parseTrace + normalizeTrace
    const parsed = parseTrace(input);
    normalized = normalizeTrace(parsed);
  }

  const playwright = generatePlaywright(normalized, { testName, useHashRouting, browserErrors });
  console.log(playwright);
}
