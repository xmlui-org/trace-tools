/**
 * Parse XMLUI Inspector trace data into grouped traces.
 * Accepts a JSON array of event objects (from window._xsLogs / JSON export).
 */

function parseTrace(input) {
  const events = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? JSON.parse(input)
      : [];

  const traceMap = new Map();
  for (const e of events) {
    const tid = e.traceId || 'orphan';
    if (!traceMap.has(tid)) traceMap.set(tid, []);
    traceMap.get(tid).push(e);
  }

  const traces = [];
  for (const [traceId, traceEvents] of traceMap) {
    const perfTimes = traceEvents.filter(e => typeof e.perfTs === 'number').map(e => e.perfTs);
    const durationMs = perfTimes.length >= 2
      ? Math.round(Math.max(...perfTimes) - Math.min(...perfTimes))
      : 0;

    let summary = traceId.startsWith('startup') ? 'Startup' : '';
    if (!summary) {
      const interaction = traceEvents.find(e => e.kind === 'interaction');
      const handler = traceEvents.find(e => e.kind === 'handler:start');
      if (handler) {
        const comp = handler.componentLabel || handler.componentType || '';
        const event = handler.eventName || '';
        summary = comp ? `${comp} ${event}`.trim() : event;
      } else if (interaction) {
        summary = `${interaction.componentLabel || ''} ${interaction.interaction || 'click'}`.trim();
      } else {
        const first = traceEvents[0];
        summary = first?.kind || 'unknown';
      }
    }

    traces.push({ traceId, summary, durationMs, events: traceEvents });
  }

  traces.sort((a, b) => {
    const aTs = a.events[0]?.perfTs || 0;
    const bTs = b.events[0]?.perfTs || 0;
    return aTs - bTs;
  });

  return traces;
}

if (typeof module !== 'undefined') {
  module.exports = { parseTrace };
}

if (require.main === module) {
  const fs = require('fs');
  const input = fs.readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
  const parsed = parseTrace(input);
  console.log(JSON.stringify(parsed, null, 2));
}
