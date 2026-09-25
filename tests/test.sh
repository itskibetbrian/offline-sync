#!/usr/bin/env bash
set -uo pipefail
mkdir -p /logs/verifier
cd /tests
set +e
CTRF_FLAG=""
# NOTE: never pipe `pytest --help` into `grep -q` here. Under `pipefail`,
# grep -q closes the pipe at the first match, pytest dies with SIGPIPE, the
# detection fails, and the run falls back to the synthetic one-entry report.
# Capture to a file first, then grep the file.
if pytest --help >/tmp/pytest_help.txt 2>&1 && grep -q -- '--ctrf' /tmp/pytest_help.txt; then
  CTRF_FLAG="--ctrf=/logs/verifier/ctrf.json"
fi
rm -f /tmp/pytest_help.txt
if [ -n "$CTRF_FLAG" ]; then
  pytest -v "$CTRF_FLAG"
else
  pytest -v
fi
CODE=$?
set -e
if [ ! -f /logs/verifier/ctrf.json ]; then
  if [ "$CODE" -eq 0 ]; then R="passed"; else R="failed"; fi
  printf '{"reportFormat":"CTRF","version":"0.0.0","summary":{"tests":1,"passed":%s,"failed":%s},"results":[{"name":"pytest","status":"%s"}]}' \
    "$([ "$CODE" -eq 0 ] && echo 1 || echo 0)" "$([ "$CODE" -eq 0 ] && echo 0 || echo 1)" "$R" \
    > /logs/verifier/ctrf.json
fi
if [ "$CODE" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
echo "reward=$(cat /logs/verifier/reward.txt)"
exit 0
