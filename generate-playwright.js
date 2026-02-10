/**
 * Generate Playwright test from normalized trace
 */

const { parseTrace } = require('./parse-trace');
const { normalizeTrace } = require('./normalize-trace');

function generatePlaywright(normalized, options = {}) {
  const { testName = 'user-journey', baseUrl = '/', captureTrace = true, useHashRouting = true } = options;

  const lines = [
    `import { test, expect } from '@playwright/test';`,
    `import * as fs from 'fs';`,
    ``,
    `test('${testName}', async ({ page }) => {`,
  ];

  // Ensure startup step comes first
  const startupStep = normalized.steps.find(s => s.action === 'startup');
  const otherSteps = normalized.steps.filter(s => s.action !== 'startup');
  const orderedSteps = startupStep ? [startupStep, ...otherSteps] : otherSteps;

  // Detect starting page: if the first interaction has navigate.from on a
  // non-root path, the trace was captured on a subpage and the test needs
  // to navigate there after the initial goto('/')
  const firstInteraction = otherSteps[0];
  const startingPage = firstInteraction?.await?.navigate?.from;

  for (const step of orderedSteps) {
    lines.push('');
    lines.push(...generateStepCode(step));

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

    // Insert try after test opening
    lines.splice(testStart + 1, 0, '  try {');

    // Replace closing with finally block - handle browser already closed
    lines[lines.length - 1] = `  } finally {
    // Capture trace even on failure (if browser still open)
    try {
      await page.waitForTimeout(500);
      const logs = await page.evaluate(() => (window as any)._xsLogs || []);
      const traceFile = process.env.TRACE_OUTPUT || 'captured-trace.json';
      fs.writeFileSync(traceFile, JSON.stringify(logs, null, 2));
      console.log(\`Trace captured to \${traceFile} (\${logs.length} events)\`);
    } catch (e) {
      console.log('Could not capture trace (browser may have closed)');
    }
  }
});`;
  }

  return lines.join('\n');
}

function generateStepCode(step) {
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

    case 'click':
      const clickLines = generateClickCode(step, indent);
      lines.push(...clickLines);
      if (clickLines._skipAwait) {
        return lines; // Skip await code for tree navigation
      }
      break;

    case 'contextmenu':
      lines.push(...generateContextMenuCode(step, indent));
      break;

    case 'dblclick':
      lines.push(...generateClickCode(step, indent, 'dblclick'));
      break;

    case 'keydown':
      // Skip keydown events - they represent typing but we don't capture the full text
      // The form submit will be captured separately
      lines.pop(); // Remove the comment we added
      return []; // Return empty to skip this step entirely

    default:
      lines.push(`${indent}// TODO: handle action "${step.action}"`);
  }

  // Add await conditions (skip for startup - already handled inline)
  if (step.await && step.action !== 'startup') {
    lines.push(...generateAwaitCode(step.await, indent));
  }

  return lines;
}

function generateClickCode(step, indent, method = 'click') {
  const lines = [];
  const label = step.target?.label;
  const ariaRole = step.target?.ariaRole;
  const ariaName = step.target?.ariaName;
  const targetTag = step.target?.targetTag;
  const formData = step.target?.formData;

  // Form submit: fill fields by label, then click the submit button
  if (formData && typeof formData === 'object') {
    for (const [fieldName, fieldValue] of Object.entries(formData)) {
      if (typeof fieldValue === 'string') {
        const labelName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1).replace(/([A-Z])/g, ' $1');
        lines.push(`${indent}await page.getByLabel('${labelName}').clear();`);
        lines.push(`${indent}await page.getByLabel('${labelName}').fill('${fieldValue}');`);
      }
    }
  }

  // Best: ARIA role + name → getByRole(role, { name })
  if (ariaRole && ariaName) {
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}' }).${method}();`);
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

  // No ARIA, no label — not actionable
  lines.push(`${indent}// ACCESSIBILITY GAP: ${targetTag || 'element'} has no role or accessible name`);
  return lines;
}

function generateContextMenuCode(step, indent) {
  const lines = [];
  const ariaRole = step.target?.ariaRole;
  const ariaName = step.target?.ariaName;
  const label = step.target?.label;

  if (ariaRole && ariaName) {
    lines.push(`${indent}await page.getByRole('${ariaRole}', { name: '${ariaName}' }).click({ button: 'right' });`);
  } else if (label) {
    lines.push(`${indent}await page.getByText('${label}', { exact: true }).click({ button: 'right' });`);
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

  const inputFile = process.argv[2] || '/dev/stdin';
  const testName = process.argv[3] || 'user-journey';
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

  const playwright = generatePlaywright(normalized, { testName, useHashRouting });
  console.log(playwright);
}
