#!/bin/bash
# Example app-level test runner — copy this into your app repo and customize
#
# Define APP_DIR, optionally override reset_fixtures(), then source test-base.sh.
# Run ./test.sh help to see all commands.

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
TRACE_TOOLS="$APP_DIR/trace-tools"

# ---------------------------------------------------------------------------
# reset_fixtures — override this for your app's server state setup
# ---------------------------------------------------------------------------
# Example:
#   reset_fixtures() {
#     rm -rf "$SERVER_ROOT/shares/Documents"
#     cp -r "$APP_DIR/traces/fixtures/shares/Documents" "$SERVER_ROOT/shares/Documents"
#   }

source "$TRACE_TOOLS/test-base.sh"
