#!/usr/bin/env bash
# Checks an `npm test` log (scripts/run-tests.js -> node --test TAP output) against
# the known-failure list. Shared by release.yml (job test) and server-tests.yml
# (job server-tests).
#
# Usage: check-test-summary.sh <log-file> <npm-exit-code> [<known-failures-file>]
#   default known-failures file: $GITHUB_WORKSPACE/.github/known-test-failures.txt,
#   falling back to .github/known-test-failures.txt next to this script.
#
# Fails if the runner refused, the summary is missing/malformed, anything is
# cancelled, a test fails that is not listed BY NAME in the known-failures file, or
# the fail count exceeds the number of listed names. Warns (never fails) for each
# listed test that now passes.

# Every rejection below is an explicit check; don't let -e/pipefail end the
# script silently (e.g. grep -c finding 0 matches) without an ::error::.
set +e -u
reject() { echo "::error::$1"; exit 1; }

[ "$#" -ge 2 ] && [ "$#" -le 3 ] \
  || reject "usage: check-test-summary.sh <log-file> <npm-exit-code> [<known-failures-file>]"
LOG=$1
NPM_EXIT=$2
if [ "$#" -eq 3 ]; then
  KNOWN_FILE=$3
elif [ -n "${GITHUB_WORKSPACE:-}" ] && [ -f "$GITHUB_WORKSPACE/.github/known-test-failures.txt" ]; then
  KNOWN_FILE=$GITHUB_WORKSPACE/.github/known-test-failures.txt
else
  KNOWN_FILE=$(dirname "$0")/../known-test-failures.txt
fi

echo "npm test exit code: ${NPM_EXIT:-<missing>}"
case "${NPM_EXIT:-}" in
  0|1) ;;
  *) reject "npm test exit code is '${NPM_EXIT:-<missing>}' - only 0 or 1 is a test result (130/137/143 = killed by a signal)" ;;
esac
[ -f "$KNOWN_FILE" ] || reject "known-failures file $KNOWN_FILE is missing"
[ -s "$LOG" ] || reject "test log $LOG is missing or empty"

# Known failures: one exact test name per line; blank lines and '#' comments ignored.
KNOWN=()
declare -A IS_KNOWN=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  [[ "$line" == \#* ]] && continue
  [ -z "${IS_KNOWN[$line]+x}" ] || reject "duplicate name in $KNOWN_FILE: '$line'"
  IS_KNOWN[$line]=1
  KNOWN+=("$line")
done < "$KNOWN_FILE"
echo "known failures listed: ${#KNOWN[@]} ($KNOWN_FILE)"

# The runner must have reset the test DB and started the tests.
grep -Eq '^\[run-tests\] .+ reset as .+' "$LOG" \
  || reject "no '[run-tests] ... reset as ...' line - the test runner refused or setup failed"
FILES=$(sed -nE 's/^\[run-tests\] running ([0-9]+) test file\(s\)$/\1/p' "$LOG" | tail -n 1)
[ -n "$FILES" ] && [ "$FILES" -gt 0 ] \
  || reject "no '[run-tests] running <N> test file(s)' line with N > 0 - the test runner refused or setup failed"

# Exactly one top-level TAP plan line, immediately followed by the summary block.
PLAN_COUNT=$(grep -cE '^1\.\.[0-9]+$' "$LOG")
[ "$PLAN_COUNT" -eq 1 ] || reject "expected exactly one top-level TAP plan line '1..<n>', found $PLAN_COUNT"
PLAN_LINE=$(grep -nE '^1\.\.[0-9]+$' "$LOG" | cut -d: -f1)

# Read the block that follows the plan: '# key value' lines in node's order.
KEYS=""
declare -A VAL=()
while IFS= read -r line; do
  if [[ "$line" =~ ^#\ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\ (.*)$ ]]; then
    KEYS="$KEYS ${BASH_REMATCH[1]}"
    VAL[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
  else
    break
  fi
done < <(tail -n +"$((PLAN_LINE + 1))" "$LOG")
ORDER=$(echo "$KEYS" | tr ' ' '\n' | grep -E '^(tests|pass|fail|cancelled|skipped|todo)$' | tr '\n' ' ')
[ "$ORDER" = "tests pass fail cancelled skipped todo " ] \
  || reject "malformed summary: expected '# tests/pass/fail/cancelled/skipped/todo' right after the TAP plan, got [${KEYS# }]"
for k in tests pass fail cancelled skipped todo; do
  [[ "${VAL[$k]}" =~ ^[0-9]+$ ]] || reject "malformed summary: '# $k ${VAL[$k]}' is not a non-negative integer"
  N=$(grep -cE "^# $k [0-9]+$" "$LOG")
  [ "$N" -eq 1 ] || reject "malformed summary: '# $k' appears $N times (expected one final summary block)"
done
# Nothing TAP-shaped may follow the block (it must be the final one).
if tail -n +"$((PLAN_LINE + 1))" "$LOG" | grep -Eq '^(not )?ok [0-9]+ |^# Subtest: |^1\.\.[0-9]+$|^TAP version'; then
  reject "malformed summary: TAP output continues after the final summary block"
fi

T=${VAL[tests]} P=${VAL[pass]} F=${VAL[fail]} C=${VAL[cancelled]} S=${VAL[skipped]} D=${VAL[todo]}
echo "summary: tests=$T pass=$P fail=$F cancelled=$C skipped=$S todo=$D (files=$FILES, known failures listed=${#KNOWN[@]})"
[ "$T" -eq $((P + F + C + S + D)) ] \
  || reject "malformed summary: tests ($T) != pass + fail + cancelled + skipped + todo ($((P + F + C + S + D)))"
[ "$C" -eq 0 ] || reject "$C test(s) cancelled (timeout or a crashed test file)"
if [ "$NPM_EXIT" -eq 0 ] && [ "$F" -ne 0 ]; then
  reject "npm test exited 0 but the summary reports $F failure(s)"
fi
if [ "$NPM_EXIT" -eq 1 ] && [ "$F" -lt 1 ]; then
  reject "npm test exited 1 but the summary reports 0 failures (crash after the summary?)"
fi

# Failing names: every 'not ok N - <name>' line at any indentation (subtests and
# file-level entries). An unescaped ' # ' starts a directive; '# TODO' lines are
# not failures. TAP escapes '\\' and '\#' are undone (\x01 is a placeholder).
FAILED=()
declare -A IS_FAILED=()
while IFS= read -r line; do
  name=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*not ok [0-9]+ - //; s/\\\\/\x01/g')
  directive=""
  if [[ "$name" =~ ^(.*[^\\])\ \#\ (.*)$ ]]; then
    name=${BASH_REMATCH[1]}
    directive=${BASH_REMATCH[2]}
  fi
  [[ "$directive" =~ ^[Tt][Oo][Dd][Oo]([[:space:]]|$) ]] && continue
  name=$(printf '%s' "$name" | sed -E 's/\\#/#/g; s/\x01/\\/g')
  [ -n "${IS_FAILED[$name]+x}" ] && continue
  IS_FAILED[$name]=1
  FAILED+=("$name")
done < <(grep -E '^[[:space:]]*not ok [0-9]+ - ' "$LOG")

echo "::group::Failing tests (${#FAILED[@]} distinct name(s), summary fail count $F)"
for name in "${FAILED[@]}"; do echo "$name"; done
echo "::endgroup::"

UNEXPECTED=()
for name in "${FAILED[@]}"; do
  [ -n "${IS_KNOWN[$name]+x}" ] || UNEXPECTED+=("$name")
done
for name in "${KNOWN[@]}"; do
  [ -n "${IS_FAILED[$name]+x}" ] \
    || echo "::warning::known failure '$name' now passes - remove it from .github/known-test-failures.txt"
done

if [ "${#UNEXPECTED[@]}" -gt 0 ]; then
  for name in "${UNEXPECTED[@]}"; do echo "::error::unexpected test failure (not in the known-failures list): $name"; done
  reject "${#UNEXPECTED[@]} test failure(s) not in $KNOWN_FILE (npm test exit code $NPM_EXIT)"
fi
[ "$F" -le "${#KNOWN[@]}" ] \
  || reject "$F test failure(s) exceed the ${#KNOWN[@]} known failure name(s) listed in $KNOWN_FILE (npm test exit code $NPM_EXIT)"

if [ "$F" -gt 0 ]; then
  ACCEPTED=""
  for name in "${FAILED[@]}"; do ACCEPTED="${ACCEPTED:+$ACCEPTED; }$name"; done
  echo "::warning::$F known test failure(s) accepted: $ACCEPTED (npm test exit code $NPM_EXIT)"
elif [ "${#KNOWN[@]}" -eq 0 ]; then
  echo "::notice::all tests passed; no known failures listed"
else
  echo "all tests passed"
fi
