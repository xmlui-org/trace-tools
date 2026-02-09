#!/bin/bash
# Analyze XMLUI trace files

usage() {
  echo "Usage: $0 [OPTIONS] <trace.json> [<trace2.json>]"
  echo ""
  echo "Analyze a captured XMLUI trace file."
  echo ""
  echo "Options:"
  echo "  --show-journey     Show step-by-step user journey"
  echo "  --playwright       Generate Playwright test code"
  echo "  --run              Generate and run the Playwright test"
  echo "  --compare-raw      Compare two traces step-by-step"
  echo "  --compare-semantic Compare two traces by outcomes (APIs, forms)"
  echo "  --test-name N      Test name for Playwright (default: user-journey)"
  echo "  -h, --help         Show this help message"
  echo ""
  echo "Examples:"
  echo "  $0 trace.json                              # Basic summary"
  echo "  $0 --show-journey trace.json               # Include journey details"
  echo "  $0 --playwright trace.json                 # Generate Playwright test"
  echo "  $0 --run trace.json                        # Generate and run test"
  echo "  $0 --compare-raw before.json after.json    # Step-by-step comparison"
  echo "  $0 --compare-semantic before.json after.json  # Outcome comparison"
}

SHOW_JOURNEY=""
PLAYWRIGHT=""
RUN=""
COMPARE_RAW=""
COMPARE_SEMANTIC=""
TEST_NAME="user-journey"
TRACE_FILES=()

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      usage
      exit 0
      ;;
    --show-journey)
      SHOW_JOURNEY="--show-journey"
      shift
      ;;
    --playwright)
      PLAYWRIGHT="1"
      shift
      ;;
    --run)
      RUN="1"
      shift
      ;;
    --compare-raw)
      COMPARE_RAW="1"
      shift
      ;;
    --compare-semantic)
      COMPARE_SEMANTIC="1"
      shift
      ;;
    --test-name)
      TEST_NAME="$2"
      shift 2
      ;;
    *)
      TRACE_FILES+=("$1")
      shift
      ;;
  esac
done

if [ ${#TRACE_FILES[@]} -eq 0 ]; then
  usage
  exit 1
fi

cd "$(dirname "$0")"

if [ -n "$COMPARE_RAW" ]; then
  if [ ${#TRACE_FILES[@]} -lt 2 ]; then
    echo "Error: --compare-raw requires two trace files"
    exit 1
  fi
  node ./compare-traces.js "${TRACE_FILES[0]}" "${TRACE_FILES[1]}"
elif [ -n "$COMPARE_SEMANTIC" ]; then
  if [ ${#TRACE_FILES[@]} -lt 2 ]; then
    echo "Error: --compare-semantic requires two trace files"
    exit 1
  fi
  node ./compare-traces.js --semantic $SHOW_JOURNEY "${TRACE_FILES[0]}" "${TRACE_FILES[1]}"
elif [ -n "$RUN" ]; then
  # Generate test in trace-tools (matches playwright.config.ts testDir)
  TEST_FILE="./generated-${TEST_NAME}.spec.ts"
  BASELINE="${TRACE_FILES[0]}"
  node ./generate-playwright.js "$BASELINE" "$TEST_NAME" > "$TEST_FILE"
  echo "Generated: $TEST_FILE"
  echo ""

  # Run test and capture output (suppress verbose output)
  TEST_OUTPUT=$(mktemp)
  npx playwright test "$TEST_FILE" > "$TEST_OUTPUT" 2>&1
  TEST_EXIT=$?

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "                    REGRESSION TEST REPORT"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  if [ $TEST_EXIT -eq 0 ]; then
    echo "✅ Test PASSED - Journey completed successfully"
  else
    echo "❌ Test FAILED - Regression detected!"
    echo ""
    # Extract and display the error context (the code snippet showing where it failed)
    grep -A 10 "Error:" "$TEST_OUTPUT" | head -15
  fi
  echo ""

  # Compare traces
  if [ -f "captured-trace.json" ]; then
    TRACE_TIME=$(stat -f %m captured-trace.json 2>/dev/null || stat -c %Y captured-trace.json 2>/dev/null)
    NOW=$(date +%s)
    AGE=$((NOW - TRACE_TIME))

    if [ $AGE -gt 60 ]; then
      echo "⚠️  Captured trace is ${AGE}s old (test may have failed before capture)"
      echo ""
    fi

    node ./compare-traces.js --semantic "$BASELINE" captured-trace.json
  else
    echo "⚠️  No captured trace found for comparison"
  fi

  echo ""
  echo "═══════════════════════════════════════════════════════════════"

  rm -f "$TEST_OUTPUT"
  exit $TEST_EXIT
elif [ -n "$PLAYWRIGHT" ]; then
  node ./generate-playwright.js "${TRACE_FILES[0]}" "$TEST_NAME"
else
  node ./summarize.js $SHOW_JOURNEY "${TRACE_FILES[0]}"
fi
