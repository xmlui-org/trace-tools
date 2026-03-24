/**
 * trace-normalize.js — Shared trace preprocessing for xs-diff viewer and distill-trace.
 *
 * Operates on raw log entries (the common denominator between the viewer and distiller).
 * Centralizes: event classification, API pair matching, trace grouping, orphan re-homing,
 * polling detection/filtering, and value coalescing.
 *
 * Works in both Node.js (CommonJS) and browser (<script> tag sets window.TraceNormalize).
 */

// ---------------------------------------------------------------------------
// Predicates — reusable event classification
// ---------------------------------------------------------------------------

/**
 * Returns true for events that are polling noise (status checks, serverInfo, etc.).
 * These should typically be filtered from interaction traces or merged into startup.
 */
function isPollingEvent(e) {
  // serverInfo state changes
  if (e.kind === 'state:changes' && e.eventName === 'DataSource:serverInfo') return true;
  // status/license API calls
  if ((e.kind === 'api:start' || e.kind === 'api:complete') &&
      e.url && (e.url.includes('/status') || e.url.includes('/license'))) return true;
  // loaded handlers for serverInfo
  if ((e.kind === 'handler:start' || e.kind === 'handler:complete') &&
      e.eventName === 'loaded' && e.componentLabel === 'serverInfo') return true;
  // AppState polling changes (stats, status, logs, sessions)
  if (e.kind === 'state:changes' && e.eventName && e.eventName.startsWith('AppState:')) {
    return !!(e.diffJson && e.diffJson.every(function(d) {
      return d.path === 'stats' || (d.path && d.path.startsWith('stats.')) ||
             d.path === 'status' || d.path === 'logs' || d.path === 'sessions';
    }));
  }
  return false;
}

/**
 * Returns true for events that represent user-triggered actions (not polling).
 * Used to decide which orphaned events should be re-homed to interaction traces.
 */
function isUserActionEvent(e) {
  // API events (non-status, non-license polling)
  if (e.kind === 'api:start' || e.kind === 'api:complete' || e.kind === 'api:error') {
    if (e.url && (e.url.includes('/status') || e.url.includes('/license'))) return false;
    return true;
  }
  // State changes for user data (not serverInfo/polling)
  if (e.kind === 'state:changes') {
    if (e.eventName === 'DataSource:serverInfo') return false;
    if (e.eventName && e.eventName.startsWith('AppState:')) {
      var isPolling = e.diffJson && e.diffJson.every(function(d) {
        return d.path === 'stats' || (d.path && d.path.startsWith('stats.')) ||
               d.path === 'status' || d.path === 'logs' || d.path === 'sessions';
      });
      if (isPolling) return false;
    }
    return true;
  }
  // Component variable changes (e.g., items array in Users component)
  if (e.kind === 'component:vars:change') {
    if (e.diff && e.diff.some(function(d) { return d.path === 'serverStatus'; })) return false;
    return true;
  }
  return false;
}

/**
 * Returns true for events that look like orphaned polling (should merge into startup).
 */
function isOrphanedPollingEvent(e) {
  // "loaded" handlers (from DataSource polling)
  if ((e.kind === 'handler:start' || e.kind === 'handler:complete') && e.eventName === 'loaded') {
    return true;
  }
  // Status polling API events
  if ((e.kind === 'api:start' || e.kind === 'api:complete') &&
      e.url && e.url.includes('/status')) {
    return true;
  }
  // DataSource:serverInfo state changes
  if (e.kind === 'state:changes' && e.eventName === 'DataSource:serverInfo') {
    return true;
  }
  // AppState polling changes
  if (e.kind === 'state:changes' && e.eventName && e.eventName.startsWith('AppState:')) {
    return !!(e.diffJson && e.diffJson.every(function(d) {
      return d.path === 'stats' || (d.path && d.path.startsWith('stats.')) ||
             d.path === 'status' || d.path === 'logs' || d.path === 'sessions';
    }));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Default sort key: prefer perfTs, fall back to ts, then 0.
 */
function defaultSortKey(entry) {
  if (!entry) return 0;
  if (entry.perfTs !== undefined) return entry.perfTs;
  return entry.ts || 0;
}

// ---------------------------------------------------------------------------
// API pair matching
// ---------------------------------------------------------------------------

var _requestIdCounter = 0;

/** Reset counter (for testing) */
function resetRequestIdCounter() {
  _requestIdCounter = 0;
}

/**
 * Match api:complete/api:error events to their api:start by method+url+timing.
 * Assigns _requestId to both sides and inherits traceId from the matched start.
 * Mutates entries in place.
 */
function matchApiPairs(entries) {
  var pendingRequests = new Map();

  entries.forEach(function(e) {
    if (e.kind === 'api:start') {
      if (!e._requestId) e._requestId = 'req-' + (++_requestIdCounter);
      var key = e.instanceId || 'unknown';
      if (!pendingRequests.has(key)) pendingRequests.set(key, []);
      pendingRequests.get(key).push({
        requestId: e._requestId,
        perfTs: e.perfTs,
        method: (e.method || 'GET').toUpperCase(),
        url: e.url,
        traceId: e.traceId,
      });
    }
  });

  var completions = entries
    .filter(function(e) {
      return (e.kind === 'api:complete' || e.kind === 'api:error') && !e._requestId;
    })
    .sort(function(a, b) { return (a.perfTs || 0) - (b.perfTs || 0); });

  completions.forEach(function(e) {
    var key = e.instanceId || 'unknown';
    var queue = pendingRequests.get(key);
    if (!queue || queue.length === 0) return;

    var method = (e.method || 'GET').toUpperCase();
    var completePerfTs = e.perfTs || Infinity;
    var completeTraceId = e.traceId;

    // Find best match: same method+url, started before completion, most recent
    var bestIdx = -1, bestTs = -1;
    queue.forEach(function(r, idx) {
      if (r.method === method && r.url === e.url) {
        if (completeTraceId && r.traceId && r.traceId !== completeTraceId) return;
        if (r.perfTs <= completePerfTs && r.perfTs > bestTs) {
          bestIdx = idx;
          bestTs = r.perfTs;
        }
      }
    });

    if (bestIdx === -1) {
      // Fallback: most recent pending with compatible traceId
      var fallbackIdx = -1, fallbackTs = -1;
      queue.forEach(function(r, idx) {
        var ok = !completeTraceId || !r.traceId || r.traceId === completeTraceId;
        if (ok && r.perfTs > fallbackTs) { fallbackIdx = idx; fallbackTs = r.perfTs; }
      });
      if (fallbackIdx === -1) fallbackIdx = 0;
      bestIdx = fallbackIdx;
    }

    var matched = queue.splice(bestIdx, 1)[0];
    e._requestId = matched.requestId;
    e.traceId = matched.traceId || undefined;
  });
}

// ---------------------------------------------------------------------------
// Trace grouping
// ---------------------------------------------------------------------------

/**
 * Group entries by traceId.
 * Returns { tracesMap: Map<traceId, entry[]>, orphans: entry[] }.
 */
function groupByTraceId(entries) {
  var tracesMap = new Map();
  var orphans = [];
  entries.forEach(function(entry) {
    if (entry.traceId) {
      if (!tracesMap.has(entry.traceId)) tracesMap.set(entry.traceId, []);
      tracesMap.get(entry.traceId).push(entry);
    } else {
      orphans.push(entry);
    }
  });
  return { tracesMap: tracesMap, orphans: orphans };
}

/**
 * Find the startup trace ID in a tracesMap. Creates a synthetic one if missing.
 * Returns the ID (string).
 */
function findOrCreateStartupTraceId(tracesMap) {
  var keys = Array.from(tracesMap.keys());
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].startsWith('startup-')) return keys[i];
  }
  var id = 'startup-synthetic';
  tracesMap.set(id, []);
  return id;
}

// ---------------------------------------------------------------------------
// Orphan merging / re-homing
// ---------------------------------------------------------------------------

/**
 * Merge bootstrap orphans (events before/at startup) into the startup trace.
 * Returns the remaining (non-bootstrap) orphans.
 */
function mergeBootstrapOrphans(tracesMap, orphans, sortKeyFn) {
  sortKeyFn = sortKeyFn || defaultSortKey;
  var startupTraceId = findOrCreateStartupTraceId(tracesMap);
  var startupEntries = tracesMap.get(startupTraceId);
  var timestamps = startupEntries.map(function(e) { return sortKeyFn(e) || Infinity; });
  var startupMinTs = Math.min.apply(null, timestamps.length > 0 ? timestamps : [Infinity]);

  var remaining = [];
  orphans.forEach(function(e) {
    var ts = sortKeyFn(e);
    if (ts === 0 || ts <= startupMinTs + 100) {
      e._bootstrap = true;
      startupEntries.push(e);
    } else {
      remaining.push(e);
    }
  });
  return remaining;
}

/**
 * Identify traces where ALL handlers are "loaded" (polling) with no native events,
 * and merge their non-interaction events into startup.
 */
function mergePollingTraces(tracesMap) {
  var startupTraceId = findOrCreateStartupTraceId(tracesMap);
  var startupEntries = tracesMap.get(startupTraceId);
  var toMerge = [];

  tracesMap.forEach(function(entries, traceId) {
    if (traceId === startupTraceId) return;
    var handlers = entries.filter(function(e) { return e.kind === 'handler:start'; });
    var hasNative = entries.some(function(e) { return e.kind && e.kind.startsWith('native:'); });
    var hasInteraction = entries.some(function(e) { return e.kind === 'interaction'; });
    // All-loaded-handler traces (DataSource polling)
    if (handlers.length > 0 && !hasNative &&
        handlers.every(function(h) { return h.eventName === 'loaded'; })) {
      toMerge.push(traceId);
      return;
    }
    // Traces with only method:call on "state" and no handlers/interactions/native events
    // These are AppState initialization calls (state.update) from DataSource loaded handlers
    if (handlers.length === 0 && !hasNative && !hasInteraction) {
      var allMethodCalls = entries.every(function(e) {
        return e.kind === 'method:call' && e.componentLabel === 'state';
      });
      if (allMethodCalls && entries.length > 0) {
        toMerge.push(traceId);
        return;
      }
    }
  });

  toMerge.forEach(function(traceId) {
    tracesMap.get(traceId).forEach(function(e) {
      if (e.kind !== 'interaction') startupEntries.push(e);
    });
    tracesMap.delete(traceId);
  });

  // Remove synthetic startup if it ended up empty
  if (startupTraceId === 'startup-synthetic' && startupEntries.length === 0) {
    tracesMap.delete(startupTraceId);
  }
}

/**
 * Merge orphaned API events into ChangeListener traces they triggered.
 * When a DataSource refetch triggers a ChangeListener, the API events are orphaned
 * while the ChangeListener gets a t- trace. Merges them by timing proximity.
 * Returns updated orphans array.
 */
function mergeChangeListenerOrphans(tracesMap, orphans) {
  var orphanedApiEvents = orphans.filter(function(e) {
    return (e.kind === 'api:start' || e.kind === 'api:complete' || e.kind === 'api:error') &&
           e.instanceId && typeof e.perfTs === 'number';
  });

  if (orphanedApiEvents.length === 0) return orphans;

  // Group orphaned API events by instanceId
  var orphanedByInstance = new Map();
  orphanedApiEvents.forEach(function(e) {
    if (!orphanedByInstance.has(e.instanceId)) orphanedByInstance.set(e.instanceId, []);
    orphanedByInstance.get(e.instanceId).push(e);
  });

  // For each t- trace with a ChangeListener, check if orphaned API events triggered it
  tracesMap.forEach(function(traceEntries, traceId) {
    if (!traceId.startsWith('t-')) return;

    var hasChangeListener = traceEntries.some(function(e) {
      return e.kind === 'handler:start' && e.componentType === 'ChangeListener';
    });
    if (!hasChangeListener) return;

    var perfTimestamps = traceEntries
      .filter(function(e) { return typeof e.perfTs === 'number'; })
      .map(function(e) { return e.perfTs; });
    var traceMinTs = Math.min.apply(null, perfTimestamps.length > 0 ? perfTimestamps : [Infinity]);
    if (!isFinite(traceMinTs)) return;

    orphanedByInstance.forEach(function(apiEvents, instanceId) {
      var apiComplete = apiEvents.find(function(e) { return e.kind === 'api:complete'; });
      if (!apiComplete) return;

      var timeDiff = traceMinTs - apiComplete.perfTs;
      if (timeDiff >= 0 && timeDiff <= 100) {
        apiEvents.forEach(function(e) {
          e._mergedFromOrphan = true;
          traceEntries.push(e);
        });
        orphanedByInstance.delete(instanceId);
      }
    });
  });

  return orphans.filter(function(e) { return !e._mergedFromOrphan; });
}

/**
 * Re-home orphaned events into interaction traces whose handler execution
 * window contains them. Works for both startup-attributed and truly orphaned events.
 *
 * opts.buffer — ms after handler:complete to still match (default 500)
 * opts.filter — predicate for which events to move (default isUserActionEvent)
 * opts.sourceTraceId — if provided, also move matching events FROM this trace
 *
 * Returns updated orphans array (events not re-homed).
 */
function rehomeByTimeWindow(tracesMap, orphans, opts) {
  opts = opts || {};
  var buffer = opts.buffer !== undefined ? opts.buffer : 500;
  var filter = opts.filter || isUserActionEvent;
  var sourceTraceId = opts.sourceTraceId || null;

  // Build interaction windows
  var windows = [];
  tracesMap.forEach(function(entries, traceId) {
    if (!traceId.startsWith('i-')) return;
    var starts = entries.filter(function(e) {
      return e.kind === 'handler:start' && typeof e.perfTs === 'number';
    });
    var completes = entries.filter(function(e) {
      return e.kind === 'handler:complete' && typeof e.perfTs === 'number';
    });
    if (starts.length === 0 || completes.length === 0) return;
    windows.push({
      traceId: traceId,
      entries: entries,
      startTs: Math.min.apply(null, starts.map(function(e) { return e.perfTs; })),
      endTs: Math.max.apply(null, completes.map(function(e) { return e.perfTs; })),
    });
  });

  if (windows.length === 0) return orphans;

  // Move matching events from source trace (e.g., startup) into interaction traces
  if (sourceTraceId && tracesMap.has(sourceTraceId)) {
    var sourceEntries = tracesMap.get(sourceTraceId);
    var movedFromSource = [];

    sourceEntries.forEach(function(e) {
      if (typeof e.perfTs !== 'number' || !filter(e)) return;
      for (var i = 0; i < windows.length; i++) {
        var win = windows[i];
        if (e.perfTs >= win.startTs && e.perfTs <= win.endTs + buffer) {
          e._movedFromStartup = true;
          win.entries.push(e);
          movedFromSource.push(e);
          break;
        }
      }
    });

    if (movedFromSource.length > 0) {
      var movedSet = new Set(movedFromSource);
      tracesMap.set(sourceTraceId, sourceEntries.filter(function(e) { return !movedSet.has(e); }));
    }
  }

  // Move matching orphans into interaction traces
  var moved = new Set();
  orphans.forEach(function(e) {
    if (typeof e.perfTs !== 'number' || !filter(e)) return;
    for (var i = 0; i < windows.length; i++) {
      var win = windows[i];
      if (e.perfTs >= win.startTs && e.perfTs <= win.endTs + buffer) {
        e._mergedByTimeWindow = true;
        win.entries.push(e);
        moved.add(e);
        break;
      }
    }
  });

  return orphans.filter(function(e) { return !moved.has(e); });
}

/**
 * Merge remaining orphaned polling events into startup trace.
 * Returns updated orphans array.
 */
function mergeOrphanedPollingToStartup(tracesMap, orphans) {
  var startupTraceId = null;
  tracesMap.forEach(function(_, tid) {
    if (tid.startsWith('startup-')) startupTraceId = tid;
  });
  if (!startupTraceId || !tracesMap.has(startupTraceId)) return orphans;

  var startupEntries = tracesMap.get(startupTraceId);
  var remaining = [];
  orphans.forEach(function(e) {
    if (isOrphanedPollingEvent(e)) {
      e._mergedToStartup = true;
      startupEntries.push(e);
    } else {
      remaining.push(e);
    }
  });
  return remaining;
}

/**
 * Re-home orphaned value:change events to the nearest interaction trace
 * by time distance. Used by the distiller where traces are { traceId, events[], firstPerfTs }.
 *
 * traceArray: array of { events: entry[], ... } with at least some having interactions
 * sortKeyFn: function to extract timestamp from an entry
 */
function rehomeOrphanedValueChanges(traceArray, sortKeyFn) {
  sortKeyFn = sortKeyFn || defaultSortKey;
  var orphanedVCs = [];

  // Collect value:change events from trace groups without interactions
  for (var i = 0; i < traceArray.length; i++) {
    var tg = traceArray[i];
    var hasInteraction = tg.events.some(function(e) { return e.kind === 'interaction'; });
    if (!hasInteraction) {
      var vcs = tg.events.filter(function(e) { return e.kind === 'value:change'; });
      for (var j = 0; j < vcs.length; j++) orphanedVCs.push(vcs[j]);
    }
  }

  // Re-home each orphan to nearest interaction trace by time distance
  for (var k = 0; k < orphanedVCs.length; k++) {
    var vc = orphanedVCs[k];
    var vcTs = sortKeyFn(vc);
    var bestTrace = null;
    var bestDist = Infinity;

    for (var m = 0; m < traceArray.length; m++) {
      var tg2 = traceArray[m];
      var hasInt = tg2.events.some(function(e) { return e.kind === 'interaction'; });
      if (!hasInt) continue;
      var firstTs = tg2.firstPerfTs !== undefined ? tg2.firstPerfTs :
        Math.min.apply(null, tg2.events.map(function(e) { return sortKeyFn(e) || Infinity; }));
      var dist = Math.abs(firstTs - vcTs);
      if (dist < bestDist) {
        bestTrace = tg2;
        bestDist = dist;
      }
    }

    if (bestTrace) {
      bestTrace.events.push(vc);
      // Remove from original group
      for (var n = 0; n < traceArray.length; n++) {
        var idx = traceArray[n].events.indexOf(vc);
        if (idx !== -1 && traceArray[n] !== bestTrace) {
          traceArray[n].events.splice(idx, 1);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter polling events out of interaction traces.
 */
function filterPollingFromInteractions(tracesMap) {
  tracesMap.forEach(function(entries, traceId) {
    if (traceId.startsWith('i-')) {
      tracesMap.set(traceId, entries.filter(function(e) { return !isPollingEvent(e); }));
    }
  });
}

// ---------------------------------------------------------------------------
// Coalescing / deduplication
// ---------------------------------------------------------------------------

/**
 * Coalesce value:change events per component, keeping only the last value.
 * Returns array of the last value:change per component.
 */
function coalesceValueChanges(events) {
  var byComponent = new Map();
  events.forEach(function(e) {
    if (e.kind === 'value:change') {
      byComponent.set(e.component, e);
    }
  });
  return Array.from(byComponent.values());
}

/**
 * Generic fingerprint-based dedup. Groups events by keyFn, returns
 * { unique: [{entry, count}], dedupedCount }.
 * keyFn should return a string key, or null to skip the event.
 */
function dedupByFingerprint(events, keyFn) {
  var seen = new Map();
  var dedupedCount = 0;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var key = keyFn(e);
    if (key === null) continue;
    if (seen.has(key)) {
      seen.get(key).count++;
      dedupedCount++;
    } else {
      seen.set(key, { entry: e, count: 1 });
    }
  }
  return { unique: Array.from(seen.values()), dedupedCount: dedupedCount };
}

// ---------------------------------------------------------------------------
// Full preprocessing pipeline (viewer-oriented)
// ---------------------------------------------------------------------------

/**
 * Run the full preprocessing pipeline used by the viewer's processAllEntries.
 * Takes raw entries (excluding standalone interactions) and returns
 * { tracesMap, orphans, startupTraceId }.
 *
 * sortKeyFn: function to extract sort timestamp from entries (default: defaultSortKey)
 */
function preprocessTraces(entries, sortKeyFn) {
  sortKeyFn = sortKeyFn || defaultSortKey;

  // Step 1: Match API pairs
  matchApiPairs(entries);

  // Step 2: Group by traceId
  var grouped = groupByTraceId(entries);
  var tracesMap = grouped.tracesMap;
  var orphans = grouped.orphans;

  // Step 3: Find/create startup trace and merge bootstrap orphans
  var startupTraceId = findOrCreateStartupTraceId(tracesMap);
  orphans = mergeBootstrapOrphans(tracesMap, orphans, sortKeyFn);

  // Step 4: Merge polling-only traces into startup
  mergePollingTraces(tracesMap);

  // Step 5: Merge orphaned API events into ChangeListener traces
  orphans = mergeChangeListenerOrphans(tracesMap, orphans);

  // Step 6: Time-window based re-homing (startup → interaction, orphans → interaction)
  // Re-check startupTraceId since mergePollingTraces may have cleaned up synthetic
  var currentStartupId = null;
  tracesMap.forEach(function(_, tid) {
    if (tid.startsWith('startup-')) currentStartupId = tid;
  });
  orphans = rehomeByTimeWindow(tracesMap, orphans, {
    buffer: 500,
    sourceTraceId: currentStartupId,
  });

  // Step 7: Merge remaining orphaned polling events into startup
  orphans = mergeOrphanedPollingToStartup(tracesMap, orphans);

  // Step 8: Filter polling events from interaction traces
  filterPollingFromInteractions(tracesMap);

  return {
    tracesMap: tracesMap,
    orphans: orphans,
    startupTraceId: currentStartupId,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

var _exports = {
  // Predicates
  isPollingEvent: isPollingEvent,
  isUserActionEvent: isUserActionEvent,
  isOrphanedPollingEvent: isOrphanedPollingEvent,
  // Timestamp
  defaultSortKey: defaultSortKey,
  // API matching
  matchApiPairs: matchApiPairs,
  resetRequestIdCounter: resetRequestIdCounter,
  // Grouping
  groupByTraceId: groupByTraceId,
  findOrCreateStartupTraceId: findOrCreateStartupTraceId,
  // Orphan merging / re-homing
  mergeBootstrapOrphans: mergeBootstrapOrphans,
  mergePollingTraces: mergePollingTraces,
  mergeChangeListenerOrphans: mergeChangeListenerOrphans,
  rehomeByTimeWindow: rehomeByTimeWindow,
  rehomeOrphanedValueChanges: rehomeOrphanedValueChanges,
  mergeOrphanedPollingToStartup: mergeOrphanedPollingToStartup,
  // Filtering
  filterPollingFromInteractions: filterPollingFromInteractions,
  // Coalescing / dedup
  coalesceValueChanges: coalesceValueChanges,
  dedupByFingerprint: dedupByFingerprint,
  // Pipeline
  preprocessTraces: preprocessTraces,
};

// Node.js CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
}

// Browser global
if (typeof window !== 'undefined') {
  window.TraceNormalize = _exports;
}
