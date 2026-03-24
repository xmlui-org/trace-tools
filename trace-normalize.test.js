/**
 * Unit tests for trace-normalize.js
 *
 * Run: node trace-normalize.test.js
 */

const TN = require('./trace-normalize');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------
console.log('\nPredicates');

test('isPollingEvent: serverInfo state change', () => {
  assert(TN.isPollingEvent({ kind: 'state:changes', eventName: 'DataSource:serverInfo' }));
});

test('isPollingEvent: status API call', () => {
  assert(TN.isPollingEvent({ kind: 'api:start', url: '/api/status' }));
  assert(TN.isPollingEvent({ kind: 'api:complete', url: '/api/status' }));
});

test('isPollingEvent: license API call', () => {
  assert(TN.isPollingEvent({ kind: 'api:start', url: '/api/license' }));
});

test('isPollingEvent: loaded handler for serverInfo', () => {
  assert(TN.isPollingEvent({ kind: 'handler:start', eventName: 'loaded', componentLabel: 'serverInfo' }));
});

test('isPollingEvent: AppState stats polling', () => {
  assert(TN.isPollingEvent({
    kind: 'state:changes', eventName: 'AppState:main',
    diffJson: [{ path: 'stats.cpu' }, { path: 'status' }]
  }));
});

test('isPollingEvent: rejects user API call', () => {
  assert(!TN.isPollingEvent({ kind: 'api:start', url: '/api/users' }));
});

test('isPollingEvent: rejects non-polling state change', () => {
  assert(!TN.isPollingEvent({
    kind: 'state:changes', eventName: 'AppState:main',
    diffJson: [{ path: 'users' }]
  }));
});

test('isUserActionEvent: API call to users', () => {
  assert(TN.isUserActionEvent({ kind: 'api:start', url: '/api/users' }));
});

test('isUserActionEvent: rejects status API', () => {
  assert(!TN.isUserActionEvent({ kind: 'api:start', url: '/api/status' }));
});

test('isUserActionEvent: rejects license API', () => {
  assert(!TN.isUserActionEvent({ kind: 'api:complete', url: '/api/license' }));
});

test('isUserActionEvent: user state change', () => {
  assert(TN.isUserActionEvent({
    kind: 'state:changes', eventName: 'DataSource:users',
    diffJson: [{ path: 'items' }]
  }));
});

test('isUserActionEvent: rejects serverInfo', () => {
  assert(!TN.isUserActionEvent({ kind: 'state:changes', eventName: 'DataSource:serverInfo' }));
});

test('isUserActionEvent: component vars change', () => {
  assert(TN.isUserActionEvent({ kind: 'component:vars:change', diff: [{ path: 'items' }] }));
});

test('isUserActionEvent: rejects serverStatus component var', () => {
  assert(!TN.isUserActionEvent({ kind: 'component:vars:change', diff: [{ path: 'serverStatus' }] }));
});

test('isOrphanedPollingEvent: loaded handler', () => {
  assert(TN.isOrphanedPollingEvent({ kind: 'handler:start', eventName: 'loaded' }));
  assert(TN.isOrphanedPollingEvent({ kind: 'handler:complete', eventName: 'loaded' }));
});

test('isOrphanedPollingEvent: rejects click handler', () => {
  assert(!TN.isOrphanedPollingEvent({ kind: 'handler:start', eventName: 'click' }));
});

// ---------------------------------------------------------------------------
// defaultSortKey
// ---------------------------------------------------------------------------
console.log('\ndefaultSortKey');

test('prefers perfTs', () => {
  assert.strictEqual(TN.defaultSortKey({ perfTs: 100, ts: 50 }), 100);
});

test('falls back to ts', () => {
  assert.strictEqual(TN.defaultSortKey({ ts: 50 }), 50);
});

test('returns 0 for empty', () => {
  assert.strictEqual(TN.defaultSortKey({}), 0);
  assert.strictEqual(TN.defaultSortKey(null), 0);
});

// ---------------------------------------------------------------------------
// matchApiPairs
// ---------------------------------------------------------------------------
console.log('\nmatchApiPairs');

test('matches api:start to api:complete by method+url+instanceId', () => {
  TN.resetRequestIdCounter();
  const entries = [
    { kind: 'api:start', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 100, traceId: 'i-1' },
    { kind: 'api:complete', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 200 },
  ];
  TN.matchApiPairs(entries);
  assert.strictEqual(entries[0]._requestId, entries[1]._requestId);
  assert.strictEqual(entries[1].traceId, 'i-1'); // inherited from start
});

test('matches multiple api pairs: completions processed chronologically', () => {
  TN.resetRequestIdCounter();
  const entries = [
    { kind: 'api:start', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 100, traceId: 'i-1' },
    { kind: 'api:start', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 150, traceId: 'i-2' },
    { kind: 'api:complete', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 200 },
    { kind: 'api:complete', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 250 },
  ];
  TN.matchApiPairs(entries);
  // First completion (200) matches most recent start before it (150 = i-2)
  // Second completion (250) matches remaining start (100 = i-1)
  assert.strictEqual(entries[2]._requestId, entries[1]._requestId);
  assert.strictEqual(entries[3]._requestId, entries[0]._requestId);
  assert.strictEqual(entries[2].traceId, 'i-2');
  assert.strictEqual(entries[3].traceId, 'i-1');
});

test('does not match across different instanceIds', () => {
  TN.resetRequestIdCounter();
  const entries = [
    { kind: 'api:start', method: 'GET', url: '/api/users', instanceId: 'ds1', perfTs: 100 },
    { kind: 'api:complete', method: 'GET', url: '/api/users', instanceId: 'ds2', perfTs: 200 },
  ];
  TN.matchApiPairs(entries);
  assert(entries[0]._requestId);
  assert(!entries[1]._requestId); // no match
});

// ---------------------------------------------------------------------------
// groupByTraceId
// ---------------------------------------------------------------------------
console.log('\ngroupByTraceId');

test('groups entries by traceId, orphans have no traceId', () => {
  const entries = [
    { kind: 'handler:start', traceId: 'i-1' },
    { kind: 'state:changes', traceId: 'i-1' },
    { kind: 'api:start' },
    { kind: 'handler:start', traceId: 'startup-abc' },
  ];
  const { tracesMap, orphans } = TN.groupByTraceId(entries);
  assert.strictEqual(tracesMap.get('i-1').length, 2);
  assert.strictEqual(tracesMap.get('startup-abc').length, 1);
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].kind, 'api:start');
});

// ---------------------------------------------------------------------------
// mergeBootstrapOrphans
// ---------------------------------------------------------------------------
console.log('\nmergeBootstrapOrphans');

test('merges orphans before startup into startup trace', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', [{ kind: 'handler:start', perfTs: 100 }]);
  const orphans = [
    { kind: 'state:changes', perfTs: 50 },  // before startup
    { kind: 'state:changes', perfTs: 0 },    // no timestamp
    { kind: 'api:start', perfTs: 500 },      // after startup
  ];
  const remaining = TN.mergeBootstrapOrphans(tracesMap, orphans);
  assert.strictEqual(tracesMap.get('startup-abc').length, 3); // original + 2 bootstrap
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].perfTs, 500);
});

// ---------------------------------------------------------------------------
// mergePollingTraces
// ---------------------------------------------------------------------------
console.log('\nmergePollingTraces');

test('merges all-loaded-handler traces into startup', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', [{ kind: 'handler:start', perfTs: 10 }]);
  tracesMap.set('t-poll', [
    { kind: 'handler:start', eventName: 'loaded' },
    { kind: 'handler:complete', eventName: 'loaded' },
    { kind: 'state:changes' },
  ]);
  tracesMap.set('i-click', [
    { kind: 'handler:start', eventName: 'click' },
  ]);
  TN.mergePollingTraces(tracesMap);
  assert(!tracesMap.has('t-poll')); // merged away
  assert(tracesMap.has('i-click')); // kept
  assert.strictEqual(tracesMap.get('startup-abc').length, 4); // 1 original + 3 from polling (minus interaction)
});

test('merges method:call state-only traces into startup', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', [{ kind: 'handler:start', perfTs: 10 }]);
  tracesMap.set('t-state', [
    { kind: 'method:call', componentLabel: 'state', displayLabel: 'state.update({...})' },
  ]);
  tracesMap.set('t-mixed', [
    { kind: 'method:call', componentLabel: 'state' },
    { kind: 'handler:start', eventName: 'click' },
  ]);
  TN.mergePollingTraces(tracesMap);
  assert(!tracesMap.has('t-state')); // merged — only method:call state
  assert(tracesMap.has('t-mixed')); // kept — has a handler
  assert.strictEqual(tracesMap.get('startup-abc').length, 2); // original + 1 from t-state
});

test('does not merge traces with native events', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', []);
  tracesMap.set('t-native', [
    { kind: 'handler:start', eventName: 'loaded' },
    { kind: 'native:click' },
  ]);
  TN.mergePollingTraces(tracesMap);
  assert(tracesMap.has('t-native')); // kept because of native event
});

// ---------------------------------------------------------------------------
// mergeChangeListenerOrphans
// ---------------------------------------------------------------------------
console.log('\nmergeChangeListenerOrphans');

test('merges orphaned API events into ChangeListener trace by timing', () => {
  const tracesMap = new Map();
  tracesMap.set('t-cl', [
    { kind: 'handler:start', componentType: 'ChangeListener', perfTs: 300 },
    { kind: 'handler:complete', perfTs: 400 },
  ]);
  const orphans = [
    { kind: 'api:start', instanceId: 'ds1', perfTs: 180, url: '/api/users' },
    { kind: 'api:complete', instanceId: 'ds1', perfTs: 250, url: '/api/users' },
    { kind: 'state:changes', perfTs: 500 }, // unrelated
  ];
  const remaining = TN.mergeChangeListenerOrphans(tracesMap, orphans);
  assert.strictEqual(tracesMap.get('t-cl').length, 4); // 2 original + 2 merged
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].perfTs, 500);
});

// ---------------------------------------------------------------------------
// rehomeByTimeWindow
// ---------------------------------------------------------------------------
console.log('\nrehomeByTimeWindow');

test('moves orphans into interaction traces by handler window', () => {
  const tracesMap = new Map();
  tracesMap.set('i-1', [
    { kind: 'handler:start', perfTs: 100 },
    { kind: 'handler:complete', perfTs: 300 },
  ]);
  const orphans = [
    { kind: 'api:start', url: '/api/users', perfTs: 200 },    // in window
    { kind: 'state:changes', eventName: 'DataSource:users', perfTs: 350, diffJson: [{ path: 'items' }] }, // in window+buffer
    { kind: 'api:start', url: '/api/users', perfTs: 900 },    // outside window
  ];
  const remaining = TN.rehomeByTimeWindow(tracesMap, orphans);
  assert.strictEqual(tracesMap.get('i-1').length, 4); // 2 original + 2 rehomed
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].perfTs, 900);
});

test('moves events from source trace into interaction traces', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', [
    { kind: 'handler:start', perfTs: 10 },
    { kind: 'api:start', url: '/api/users', perfTs: 150 }, // should move
  ]);
  tracesMap.set('i-1', [
    { kind: 'handler:start', perfTs: 100 },
    { kind: 'handler:complete', perfTs: 300 },
  ]);
  const orphans = [];
  TN.rehomeByTimeWindow(tracesMap, orphans, { sourceTraceId: 'startup-abc' });
  assert.strictEqual(tracesMap.get('startup-abc').length, 1); // api:start moved out
  assert.strictEqual(tracesMap.get('i-1').length, 3); // api:start moved in
});

// ---------------------------------------------------------------------------
// mergeOrphanedPollingToStartup
// ---------------------------------------------------------------------------
console.log('\nmergeOrphanedPollingToStartup');

test('merges polling orphans to startup, keeps non-polling', () => {
  const tracesMap = new Map();
  tracesMap.set('startup-abc', []);
  const orphans = [
    { kind: 'handler:start', eventName: 'loaded' },           // polling
    { kind: 'api:start', url: '/api/status' },                 // polling
    { kind: 'state:changes', eventName: 'DataSource:serverInfo' }, // polling
    { kind: 'api:start', url: '/api/users' },                  // NOT polling
  ];
  const remaining = TN.mergeOrphanedPollingToStartup(tracesMap, orphans);
  assert.strictEqual(tracesMap.get('startup-abc').length, 3);
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(remaining[0].url, '/api/users');
});

// ---------------------------------------------------------------------------
// rehomeOrphanedValueChanges
// ---------------------------------------------------------------------------
console.log('\nrehomeOrphanedValueChanges');

test('re-homes value:change to nearest interaction trace', () => {
  const traceArray = [
    { traceId: 'unknown', events: [{ kind: 'value:change', perfTs: 105, component: 'TextBox' }], firstPerfTs: 105 },
    { traceId: 'i-1', events: [{ kind: 'interaction', perfTs: 100 }], firstPerfTs: 100 },
    { traceId: 'i-2', events: [{ kind: 'interaction', perfTs: 500 }], firstPerfTs: 500 },
  ];
  TN.rehomeOrphanedValueChanges(traceArray, e => e.perfTs || 0);
  // value:change at 105 should move to i-1 (closest at 100) not i-2 (at 500)
  assert.strictEqual(traceArray[1].events.length, 2);
  assert.strictEqual(traceArray[0].events.length, 0);
});

// ---------------------------------------------------------------------------
// filterPollingFromInteractions
// ---------------------------------------------------------------------------
console.log('\nfilterPollingFromInteractions');

test('filters polling events from i- traces, keeps others', () => {
  const tracesMap = new Map();
  tracesMap.set('i-1', [
    { kind: 'handler:start', eventName: 'click' },
    { kind: 'state:changes', eventName: 'DataSource:serverInfo' }, // polling
    { kind: 'api:start', url: '/api/status' },                     // polling
    { kind: 'api:complete', url: '/api/users' },                    // not polling
  ]);
  tracesMap.set('startup-abc', [
    { kind: 'state:changes', eventName: 'DataSource:serverInfo' }, // kept in startup
  ]);
  TN.filterPollingFromInteractions(tracesMap);
  assert.strictEqual(tracesMap.get('i-1').length, 2); // click handler + users api
  assert.strictEqual(tracesMap.get('startup-abc').length, 1); // untouched
});

// ---------------------------------------------------------------------------
// coalesceValueChanges
// ---------------------------------------------------------------------------
console.log('\ncoalesceValueChanges');

test('keeps only last value:change per component', () => {
  const events = [
    { kind: 'value:change', component: 'TextBox1', displayLabel: 'a' },
    { kind: 'value:change', component: 'TextBox1', displayLabel: 'ab' },
    { kind: 'value:change', component: 'TextBox1', displayLabel: 'abc' },
    { kind: 'value:change', component: 'Slider1', displayLabel: '50' },
    { kind: 'handler:start' }, // non value:change, ignored
  ];
  const result = TN.coalesceValueChanges(events);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result.find(e => e.component === 'TextBox1').displayLabel, 'abc');
  assert.strictEqual(result.find(e => e.component === 'Slider1').displayLabel, '50');
});

// ---------------------------------------------------------------------------
// dedupByFingerprint
// ---------------------------------------------------------------------------
console.log('\ndedupByFingerprint');

test('deduplicates events by fingerprint, counts occurrences', () => {
  const events = [
    { kind: 'api:start', method: 'GET', url: '/api/status' },
    { kind: 'api:start', method: 'GET', url: '/api/status' },
    { kind: 'api:start', method: 'GET', url: '/api/status' },
    { kind: 'api:start', method: 'POST', url: '/api/users' },
  ];
  const { unique, dedupedCount } = TN.dedupByFingerprint(events, e => `${e.method}|${e.url}`);
  assert.strictEqual(unique.length, 2);
  assert.strictEqual(dedupedCount, 2);
  const statusEntry = unique.find(u => u.entry.url === '/api/status');
  assert.strictEqual(statusEntry.count, 3);
});

test('skips events where keyFn returns null', () => {
  const events = [
    { kind: 'api:start', url: '/a' },
    { kind: 'handler:start' },
  ];
  const { unique } = TN.dedupByFingerprint(events, e => e.url ? e.url : null);
  assert.strictEqual(unique.length, 1);
});

// ---------------------------------------------------------------------------
// preprocessTraces (full pipeline)
// ---------------------------------------------------------------------------
console.log('\npreprocessTraces (full pipeline)');

test('full pipeline: groups, merges bootstrap, filters polling', () => {
  TN.resetRequestIdCounter();
  const entries = [
    // Startup trace
    { kind: 'handler:start', traceId: 'startup-1', perfTs: 10 },
    { kind: 'handler:complete', traceId: 'startup-1', perfTs: 20 },
    // Bootstrap orphan (before startup)
    { kind: 'state:changes', perfTs: 5, eventName: 'init' },
    // Interaction trace
    { kind: 'handler:start', traceId: 'i-1', perfTs: 100 },
    { kind: 'handler:complete', traceId: 'i-1', perfTs: 300 },
    // Polling in interaction (should be filtered)
    { kind: 'state:changes', traceId: 'i-1', perfTs: 150, eventName: 'DataSource:serverInfo' },
    // API pair
    { kind: 'api:start', traceId: 'i-1', method: 'PUT', url: '/api/users', instanceId: 'ds1', perfTs: 120 },
    { kind: 'api:complete', method: 'PUT', url: '/api/users', instanceId: 'ds1', perfTs: 250 },
    // Polling-only trace (should merge to startup)
    { kind: 'handler:start', traceId: 't-poll', eventName: 'loaded', perfTs: 50 },
    { kind: 'handler:complete', traceId: 't-poll', eventName: 'loaded', perfTs: 60 },
  ];

  const result = TN.preprocessTraces(entries);
  const { tracesMap, orphans } = result;

  // Polling-only trace merged into startup
  assert(!tracesMap.has('t-poll'));

  // Bootstrap orphan merged into startup
  const startup = tracesMap.get('startup-1');
  assert(startup);
  assert(startup.some(e => e.perfTs === 5)); // bootstrap

  // Interaction trace has API pair but no polling
  const interaction = tracesMap.get('i-1');
  assert(interaction);
  assert(!interaction.some(e => e.eventName === 'DataSource:serverInfo')); // filtered
  assert(interaction.some(e => e.kind === 'api:complete' && e.url === '/api/users')); // API rehomed

  // API pair matched
  const apiStart = entries.find(e => e.kind === 'api:start' && e.url === '/api/users');
  const apiComplete = entries.find(e => e.kind === 'api:complete' && e.url === '/api/users');
  assert.strictEqual(apiStart._requestId, apiComplete._requestId);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
