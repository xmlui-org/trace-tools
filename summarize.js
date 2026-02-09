#!/usr/bin/env node
/**
 * Summarize a JSON trace file
 *
 * Usage:
 *   node trace-tools/summarize.js <trace.json>
 */

const fs = require('fs');
const { normalizeJsonLogs } = require('./normalize-trace');

// Parse arguments
let showJourney = false;
let inputFile = null;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--show-journey') {
    showJourney = true;
  } else {
    inputFile = process.argv[i];
  }
}

if (!inputFile) {
  console.error('Usage: node summarize.js [--show-journey] <trace.json>');
  process.exit(1);
}

try {
  const logs = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const normalized = normalizeJsonLogs(logs);

  console.log(`\n=== Trace Summary ===`);
  console.log(`Events: ${logs.length}`);
  console.log(`Steps: ${normalized.steps.length}`);

  if (showJourney) {
    console.log(`\nJourney:`);

    for (const step of normalized.steps) {
      if (step.action === 'startup') {
        console.log(`  1. startup`);
        continue;
      }
      if (step.action === 'keydown') continue; // Skip keydown noise

      const target = step.target?.label || step.target?.testId || step.target?.component || '';
      const formData = step.target?.formData;

      let line = `  ${step.action}: ${target}`;
      if (formData?.name) {
        line += ` → "${formData.name}"`;
      }
      console.log(line);
    }
  }

  // Extract key operations
  const apis = logs
    .filter(e => e.kind === 'api:complete' && e.method)
    .map(e => `${e.method.toUpperCase()} ${(e.url || '').split('?')[0]}`);
  const uniqueApis = [...new Set(apis)];

  const formSubmits = logs
    .filter(e => e.kind === 'handler:start' && e.eventName === 'submit')
    .map(e => e.eventArgs?.[0]?.name)
    .filter(Boolean);

  console.log(`\nAPI calls: ${uniqueApis.join(', ')}`);
  if (formSubmits.length) {
    console.log(`Form submits: ${formSubmits.length} (${formSubmits.join(' → ')})`);
  }
  console.log();

} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
