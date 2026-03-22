#!/usr/bin/env node
/**
 * Summarize a JSON trace file
 *
 * Usage:
 *   node trace-tools/summarize.js <trace.json>
 */

const fs = require('fs');
const { distillTrace } = require('./distill-trace');

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
  const distilled = distillTrace(logs);

  console.log(`\n=== Trace Summary ===`);
  console.log(`Events: ${logs.length}`);
  console.log(`Steps: ${distilled.steps.length}`);

  if (showJourney) {
    console.log(`\nJourney:`);

    for (const step of distilled.steps) {
      if (step.action === 'startup') {
        console.log(`  1. startup`);
        continue;
      }
      if (step.action === 'keydown') continue; // Skip keydown noise

      const target = step.target?.label || step.target?.testId || step.target?.component || '';
      const ariaName = step.target?.ariaName;
      const formData = step.target?.formData;

      let line = `  ${step.action}: ${target}`;
      if (ariaName && ariaName !== target) {
        line += ` [${ariaName}]`;
      }
      if (step.valueChanges?.length > 0) {
        for (const vc of step.valueChanges) {
          const vcLabel = vc.ariaName ? ` [${vc.ariaName}]` : '';
          line += ` → ${vc.component}${vcLabel}=${vc.value ?? ''}`;
        }
      }
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
