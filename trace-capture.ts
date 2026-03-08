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

export async function captureTrace(page: Page): Promise<void> {
  try {
    await page.waitForTimeout(500);
    const logs = await page.evaluate(() => (window as any)._xsLogs || []);
    const traceFile = process.env.TRACE_OUTPUT || 'captured-trace.json';
    fs.writeFileSync(traceFile, JSON.stringify(logs, null, 2));
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
