/**
 * Parse XMLUI Inspector trace export into structured data
 */

function parseTrace(traceText) {
  const traces = [];
  let currentTrace = null;
  let currentEvent = null;

  const lines = traceText.split('\n');

  for (const line of lines) {
    // New trace starts with "--- Trace N:"
    const traceMatch = line.match(/^--- Trace (\d+): (.+?) \((\d+)ms\) ---$/);
    if (traceMatch) {
      if (currentTrace) traces.push(currentTrace);
      currentTrace = {
        index: parseInt(traceMatch[1]),
        summary: traceMatch[2],
        durationMs: parseInt(traceMatch[3]),
        traceId: null,
        events: []
      };
      currentEvent = null;
      continue;
    }

    // TraceId line
    const traceIdMatch = line.match(/^\s+traceId: (.+)$/);
    if (traceIdMatch && currentTrace) {
      currentTrace.traceId = traceIdMatch[1];
      continue;
    }

    // Event lines start with [type]
    const eventMatch = line.match(/^\s+\[([^\]]+)\]\s+(.+)$/);
    if (eventMatch && currentTrace) {
      const [, kind, rest] = eventMatch;

      // Parse the event based on kind
      const event = { kind, raw: rest };

      // Extract perfTs if present
      const perfTsMatch = rest.match(/\(perfTs ([\d.]+)/);
      if (perfTsMatch) {
        event.perfTs = parseFloat(perfTsMatch[1]);
      }

      // Parse interaction events
      if (kind === 'interaction') {
        const interactionMatch = rest.match(/^(\w+)\s+"([^"]+)"/);
        if (interactionMatch) {
          event.action = interactionMatch[1];
          event.target = interactionMatch[2];
        }
      }

      // Parse handler events
      if (kind.startsWith('handler:')) {
        const handlerMatch = rest.match(/^(\w+)(?:\s+"([^"]+)")?/);
        if (handlerMatch) {
          event.handlerType = handlerMatch[1];
          event.handlerName = handlerMatch[2];
        }
        // Extract file
        const fileMatch = rest.match(/file ([^\)]+)\)/);
        if (fileMatch) {
          event.file = fileMatch[1];
        }
      }

      // Parse navigate events
      if (kind === 'navigate') {
        const navMatch = rest.match(/^(.+?) → (.+?)\s+\(/);
        if (navMatch) {
          event.from = navMatch[1];
          event.to = navMatch[2];
        }
      }

      // Parse API events
      // Formats:
      //   GET /ListFolder [req-3]
      //   [200] (13.6ms) GET /ListFolder [req-3]
      //   (20.4ms) GET /ListFolder [req-10]
      //   ×2 GET /ListFolder [req-8]
      //   (7.2ms) ×2 GET /ListFolder [req-8]
      if (kind.startsWith('api:')) {
        // Remove multiplier anywhere it appears
        const cleanRest = rest.replace(/×\d+\s+/g, '');
        const apiMatch = cleanRest.match(/^(?:\[(\d+)\]\s+)?(?:\(([\d.]+)ms\)\s+)?(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/);
        if (apiMatch) {
          event.status = apiMatch[1] ? parseInt(apiMatch[1]) : null;
          event.durationMs = apiMatch[2] ? parseFloat(apiMatch[2]) : null;
          event.method = apiMatch[3];
          event.endpoint = apiMatch[4];
        }
      }

      // Parse state changes
      if (kind === 'state:changes') {
        const stateMatch = rest.match(/^(\w+(?::\w+)?)/);
        if (stateMatch) {
          event.stateName = stateMatch[1];
        }
      }

      // Parse modal events (confirmation dialogs)
      if (kind === 'modal:show') {
        const titleMatch = rest.match(/^"([^"]+)"/);
        if (titleMatch) {
          event.title = titleMatch[1];
        }
      }
      if (kind === 'modal:confirm') {
        const valueMatch = rest.match(/value=([^\s,]+)/);
        if (valueMatch) {
          event.value = valueMatch[1];
        }
        const labelMatch = rest.match(/button="([^"]+)"/);
        if (labelMatch) {
          event.buttonLabel = labelMatch[1];
        }
      }

      currentTrace.events.push(event);
      currentEvent = event;
      continue;
    }

    // Indented content belongs to current event (args, state details, etc.)
    if (currentEvent && line.match(/^\s{6,}/)) {
      const trimmed = line.trim();

      // Handler args - can be on same line or formatted across multiple lines
      if (trimmed.startsWith('args:')) {
        const argsJson = trimmed.replace(/^args:\s*/, '');
        if (argsJson.startsWith('[') || argsJson.startsWith('{')) {
          try {
            currentEvent.args = JSON.parse(argsJson);
          } catch (e) {
            // Might be truncated, try to extract what we can
            currentEvent.argsRaw = argsJson;
            // Try to extract displayName if present
            const displayNameMatch = argsJson.match(/"displayName":"([^"]+)"/);
            if (displayNameMatch) {
              currentEvent.displayName = displayNameMatch[1];
            }
            const nameMatch = argsJson.match(/"name":"([^"]+)"/);
            if (nameMatch) {
              currentEvent.itemName = nameMatch[1];
            }
          }
        } else {
          currentEvent.argsRaw = argsJson;
        }
      }

      // State change details
      if (trimmed.includes(' → ')) {
        if (!currentEvent.changes) currentEvent.changes = [];
        currentEvent.changes.push(trimmed);
      }

      // Code snippet
      if (trimmed.startsWith('code:') || trimmed.startsWith('.xs:') || trimmed.startsWith('arrow:')) {
        currentEvent.code = trimmed;
      }
    }
  }

  if (currentTrace) traces.push(currentTrace);

  return traces;
}

// Export for use as module
if (typeof module !== 'undefined') {
  module.exports = { parseTrace };
}

// CLI usage
if (require.main === module) {
  const fs = require('fs');
  const input = fs.readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
  const parsed = parseTrace(input);
  console.log(JSON.stringify(parsed, null, 2));
}
