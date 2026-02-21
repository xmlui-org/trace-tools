#!/bin/bash
# Shared test runner logic — sourced by app-level test.sh scripts
#
# Before sourcing, the app script must define:
#   APP_DIR          — absolute path to the app repo root
#
# The app script may optionally define/override:
#   TRACE_TOOLS      — path to trace-tools (default: $APP_DIR/trace-tools)
#   CAPTURE_SCRIPTS  — path to capture scripts (default: $APP_DIR/traces/capture-scripts)
#   reset_fixtures() — function to reset server state (default: no-op)

# Defaults for anything the app didn't set
TRACE_TOOLS="${TRACE_TOOLS:-$APP_DIR/trace-tools}"
CAPTURE_SCRIPTS="${CAPTURE_SCRIPTS:-$APP_DIR/traces/capture-scripts}"
BASELINES="$APP_DIR/traces/baselines"
CAPTURES="$APP_DIR/traces/captures"
FIXTURES="$APP_DIR/traces/fixtures"
VIDEOS="$APP_DIR/traces/videos"

# Parse --video flag from any position
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--video" ]; then
    export PLAYWRIGHT_VIDEO=on
  else
    ARGS+=("$arg")
  fi
done
set -- "${ARGS[@]}"

# Ensure captures directory exists so cp doesn't fail when saving captures
mkdir -p "$CAPTURES"

if [ ! -d "$TRACE_TOOLS" ]; then
  echo "trace-tools not found. Run:"
  echo "  git clone https://github.com/xmlui-org/trace-tools.git"
  echo "  cd trace-tools && npm install && npx playwright install chromium"
  exit 1
fi

# Collect video from Playwright's test-results into traces/videos/
collect_video() {
  local name="$1"
  if [ -n "$PLAYWRIGHT_VIDEO" ]; then
    local video=$(ls -t "$TRACE_TOOLS"/test-results/*/video.webm 2>/dev/null | head -1)
    if [ -n "$video" ]; then
      mkdir -p "$VIDEOS"
      cp "$video" "$VIDEOS/$name.webm"
      echo "Video: traces/videos/$name.webm"
    fi
  fi
}

# Default no-op if app didn't define reset_fixtures
if ! type reset_fixtures &>/dev/null; then
  reset_fixtures() {
    echo "No fixture reset configured — override reset_fixtures() in your test.sh"
  }
fi

case "${1:-help}" in
  list)
    echo ""
    echo "Spec-based tests (capture-scripts):"
    HAS_SPECS=0
    for f in "$CAPTURE_SCRIPTS"/*.spec.ts; do
      [ -f "$f" ] || continue
      HAS_SPECS=1
      echo "  $(basename "$f" .spec.ts)"
    done
    [ $HAS_SPECS -eq 0 ] && echo "  (none)"

    echo ""
    echo "Baseline-based tests (recorded journeys):"
    HAS_BASELINES=0
    for f in "$BASELINES"/*.json; do
      [ -f "$f" ] || continue
      HAS_BASELINES=1
      name=$(basename "$f" .json)
      events=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('path').resolve(process.argv[1]),'utf8')).length)" "$f")
      echo "  $name ($events events)"
    done
    [ $HAS_BASELINES -eq 0 ] && echo "  (none)"
    echo ""
    ;;

  save)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: ./test.sh save <trace.json> <journey-name>"
      exit 1
    fi
    cp "$2" "$BASELINES/$3.json"
    echo "Saved baseline: $3"
    node "$TRACE_TOOLS/summarize.js" --show-journey "$BASELINES/$3.json"
    ;;

  fixtures)
    reset_fixtures
    ;;

  spec)
    if [ -z "$2" ]; then
      echo "Usage: ./test.sh spec <name> [--video]"
      echo "  Resets fixtures, runs capture-scripts/<name>.spec.ts directly. No baseline needed."
      echo ""
      echo "Available capture scripts:"
      for f in "$CAPTURE_SCRIPTS"/*.spec.ts; do
        [ -f "$f" ] || continue
        echo "  $(basename "$f" .spec.ts)"
      done
      exit 1
    fi
    SPEC="$CAPTURE_SCRIPTS/$2.spec.ts"
    if [ ! -f "$SPEC" ]; then
      echo "Capture script not found: $SPEC"
      exit 1
    fi

    # 1. Reset standard fixtures
    reset_fixtures

    # 2. Optional per-test hook for extra pre-conditions
    #    Create traces/fixtures/<name>.pre.sh to add/modify fixture state.
    HOOK="$FIXTURES/$2.pre.sh"
    if [ -f "$HOOK" ]; then
      echo "Running fixture hook: $HOOK"
      bash "$HOOK"
    fi

    # 3. Copy spec into trace-tools/ and run it
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "                    SPEC TEST: $2"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    cd "$TRACE_TOOLS"
    SPEC_COPY="$TRACE_TOOLS/spec-$2.spec.ts"
    cp "$SPEC" "$SPEC_COPY"
    TEST_OUTPUT=$(mktemp)
    npx playwright test "spec-$2.spec.ts" > "$TEST_OUTPUT" 2>&1
    TEST_EXIT=$?
    rm -f "$SPEC_COPY"

    # Show test stdout (console.log output from the spec)
    grep -v "^$" "$TEST_OUTPUT" | grep -v "Running " | grep -v "passed " | grep -v "^\[chromium\]" 2>/dev/null

    if [ $TEST_EXIT -eq 0 ]; then
      echo "PASS — Spec completed successfully"
    else
      echo "FAIL — Test failed (see below)"
      echo ""
      grep -A 10 "Error:" "$TEST_OUTPUT" | head -15
    fi

    if grep -q "XMLUI RUNTIME ERRORS\|BROWSER ERRORS" "$TEST_OUTPUT"; then
      echo ""
      grep -A 50 "XMLUI RUNTIME ERRORS\|BROWSER ERRORS" "$TEST_OUTPUT"
    fi

    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    collect_video "$2"
    rm -f "$TEST_OUTPUT"
    exit $TEST_EXIT
    ;;

  spec-all)
    PASS=0
    FAIL=0
    FAILED=()
    for f in "$CAPTURE_SCRIPTS"/*.spec.ts; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .spec.ts)
      echo "--- Spec: $name ---"
      "$0" spec "$name"
      if [ $? -eq 0 ]; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
        FAILED+=("$name")
      fi
      echo ""
    done
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Results: $PASS passed, $FAIL failed"
    if [ ${#FAILED[@]} -gt 0 ]; then
      echo "  Failed: ${FAILED[*]}"
    fi
    echo "═══════════════════════════════════════════════════════════════"
    [ $FAIL -eq 0 ]
    ;;

  run)
    if [ -z "$2" ]; then
      echo "Usage: ./test.sh run <journey-name> [--video]"
      echo "Available baselines:"
      ls "$BASELINES"/*.json 2>/dev/null | while read f; do echo "  $(basename "$f" .json)"; done
      exit 1
    fi
    BASELINE="$BASELINES/$2.json"
    if [ ! -f "$BASELINE" ]; then
      echo "Baseline not found: $2"
      echo "Save one first: ./test.sh save <trace.json> $2"
      exit 1
    fi

    # Reset server filesystem to known-good state before every run
    reset_fixtures

    # Resolve absolute paths before cd
    ABS_BASELINE="$(cd "$(dirname "$BASELINE")" && pwd)/$(basename "$BASELINE")"
    ABS_CAPTURES="$(cd "$(dirname "$CAPTURES")" && pwd)/$(basename "$CAPTURES")"

    # Generate test from baseline, run it, then discard
    cd "$TRACE_TOOLS"
    rm -f captured-trace.json
    TEST_OUTPUT=$(mktemp)
    TEST_FILE="$TRACE_TOOLS/generated-$2.spec.ts"
    node "$TRACE_TOOLS/generate-playwright.js" "$ABS_BASELINE" "$2" > "$TEST_FILE"
    echo "Generated: $TEST_FILE"
    npx playwright test "generated-$2.spec.ts" > "$TEST_OUTPUT" 2>&1
    TEST_EXIT=$?
    rm -f "$TEST_FILE"

    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "                    REGRESSION TEST: $2"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""

    if [ $TEST_EXIT -eq 0 ]; then
      echo "PASS — Journey completed successfully"
    else
      echo "FAIL — Selector error (see below)"
      echo ""
      grep -A 10 "Error:" "$TEST_OUTPUT" | head -15
    fi

    # Show XMLUI runtime errors and browser errors from test output
    if grep -q "XMLUI RUNTIME ERRORS\|BROWSER ERRORS" "$TEST_OUTPUT"; then
      echo ""
      grep -A 50 "XMLUI RUNTIME ERRORS\|BROWSER ERRORS" "$TEST_OUTPUT"
    fi
    echo ""

    # Compare traces semantically (APIs, forms, navigation)
    # Read app-specific ignore list (one endpoint per line)
    IGNORE_APIS=""
    IGNORE_FILE="$(dirname "$ABS_BASELINE")/ignore-apis.txt"
    if [ -f "$IGNORE_FILE" ]; then
      while IFS= read -r api; do
        [ -z "$api" ] || [[ "$api" == \#* ]] && continue
        IGNORE_APIS="$IGNORE_APIS --ignore-api $api"
      done < "$IGNORE_FILE"
    fi
    CAPTURED="captured-trace.json"
    if [ -f "$CAPTURED" ]; then
      cp "$CAPTURED" "$ABS_CAPTURES/$2.json"
      SEMANTIC_OUTPUT=$(node compare-traces.js --semantic $IGNORE_APIS "$ABS_BASELINE" "$CAPTURED" 2>&1)
      echo "$SEMANTIC_OUTPUT"
      echo ""
      if echo "$SEMANTIC_OUTPUT" | grep -qE "Traces match semantically|SEMANTIC_MATCH"; then
        echo "SEMANTIC: PASS — Same APIs, forms, and navigation"
      else
        echo "SEMANTIC: FAIL — Behavioral regression detected"
      fi
    else
      echo "No trace captured (test may have failed before any actions)"
    fi

    echo ""
    echo "═══════════════════════════════════════════════════════════════"

    collect_video "$2"
    rm -f "$TEST_OUTPUT"

    # Exit 0 if semantics match even if a selector failed
    if [ $TEST_EXIT -ne 0 ] && echo "$SEMANTIC_OUTPUT" | grep -qE "Traces match semantically|SEMANTIC_MATCH"; then
      exit 0
    fi
    exit $TEST_EXIT
    ;;

  run-all)
    PASS=0
    FAIL=0
    FAILED=()
    for f in "$BASELINES"/*.json; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .json)
      echo "--- Running: $name ---"
      "$0" run "$name"
      if [ $? -eq 0 ]; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
        FAILED+=("$name")
      fi
      echo ""
    done
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Results: $PASS passed, $FAIL failed"
    if [ ${#FAILED[@]} -gt 0 ]; then
      echo "  Failed: ${FAILED[*]}"
    fi
    echo "═══════════════════════════════════════════════════════════════"
    [ $FAIL -eq 0 ]
    ;;

  update)
    if [ -z "$2" ]; then
      echo "Usage: ./test.sh update <journey-name>"
      exit 1
    fi
    CAPTURED="$CAPTURES/$2.json"
    if [ ! -f "$CAPTURED" ]; then
      echo "No capture found for $2. Run the test first: ./test.sh run $2"
      exit 1
    fi
    cp "$CAPTURED" "$BASELINES/$2.json"
    echo "Updated baseline: $2"
    ;;

  compare)
    if [ -z "$2" ]; then
      echo "Usage: ./test.sh compare <journey-name>"
      exit 1
    fi
    BASELINE="$BASELINES/$2.json"
    CAPTURED="$CAPTURES/$2.json"
    if [ ! -f "$BASELINE" ]; then echo "No baseline: $2"; exit 1; fi
    if [ ! -f "$CAPTURED" ]; then echo "No capture: $2 (run the test first)"; exit 1; fi
    node "$TRACE_TOOLS/compare-traces.js" --semantic "$BASELINE" "$CAPTURED"
    ;;

  summary)
    if [ -z "$2" ]; then
      echo "Usage: ./test.sh summary <journey-name>"
      exit 1
    fi
    BASELINE="$BASELINES/$2.json"
    if [ ! -f "$BASELINE" ]; then echo "No baseline: $2"; exit 1; fi
    node "$TRACE_TOOLS/summarize.js" --show-journey "$BASELINE"
    ;;

  help|*)
    echo "Usage: ./test.sh <command> [args]"
    echo ""
    echo "Spec-based tests (no baseline required):"
    echo "  spec <name> [--video]          Reset fixtures, run capture-scripts/<name>.spec.ts"
    echo "  spec-all [--video]             Run all capture scripts"
    echo ""
    echo "Baseline-based tests (inspector-recorded journeys):"
    echo "  run <journey> [--video]        Reset fixtures, generate test from baseline, run, compare"
    echo "  run-all [--video]              Run all baselines"
    echo "  save <trace.json> <journey>    Save an exported trace as baseline"
    echo "  update <journey>               Promote latest capture to baseline"
    echo "  compare <journey>              Compare latest capture vs baseline"
    echo "  summary <journey>              Show journey summary"
    echo ""
    echo "Utilities:"
    echo "  list                           List specs and baselines"
    echo "  fixtures                       Reset server filesystem to known-good state"
    echo ""
    echo "Fixture hooks:"
    echo "  Override reset_fixtures() in your test.sh for app-specific server state setup."
    echo "  Create traces/fixtures/<name>.pre.sh for per-test pre-conditions."
    ;;
esac
