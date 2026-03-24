/**
 * Shared trace-capture helper for hand-written Playwright specs.
 *
 * Usage in a spec:
 *
 *   import { captureTrace } from '../trace-capture';
 *   // ... at the end of your test (or in a finally block):
 *   await captureTrace(page);
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';

/**
 * Inject a file-upload event into the XMLUI trace so the distiller and
 * generator can replay it with setInputFiles().
 *
 * Call this right after page.locator('input[type="file"]').setInputFiles():
 *
 *   await fileInput.setInputFiles('path/to/file.m4a');
 *   await traceFileUpload(page, ['file.m4a']);
 */
export async function traceFileUpload(page: Page, fileNames: string[]): Promise<void> {
  await page.evaluate((names) => {
    const logs = (window as any)._xsLogs;
    if (!logs) return;
    logs.push({
      ts: Date.now(),
      perfTs: performance.now(),
      kind: 'value:change',
      component: 'FileInput',
      files: names.map(name => ({ name })),
    });
  }, fileNames);
}

export async function captureTrace(page: Page): Promise<void> {
  try {
    await page.waitForTimeout(500);
    // Serialize inside the browser to handle circular references from live objects
    // (e.g., React Query cache). Playwright's page.evaluate uses JSON.stringify
    // internally, which throws on circular refs. By serializing in-page with a
    // circular-reference replacer, we get a safe string back.
    const logsJson = await page.evaluate(() => {
      const logs = (window as any)._xsLogs || [];
      const seen = new WeakSet();
      return JSON.stringify(logs, (_key, val) => {
        if (typeof val === 'function') return undefined;
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      }, 2);
    });
    const logs = JSON.parse(logsJson);
    const traceFile = process.env.TRACE_OUTPUT || 'captured-trace.json';
    fs.writeFileSync(traceFile, logsJson);
    console.log(`Trace captured to ${traceFile} (${logs.length} events)`);

    // Report XMLUI runtime errors from _xsLogs
    const errors = logs.filter((e: any) => e.kind?.startsWith('error'));
    if (errors.length > 0) {
      console.log('\nXMLUI RUNTIME ERRORS:');
      errors.forEach((e: any) =>
        console.log(`  [${e.kind}] ${e.error || e.text || JSON.stringify(e)}`),
      );
    }
  } catch (e) {
    console.log('Could not capture trace (browser may have closed)');
  }
}
