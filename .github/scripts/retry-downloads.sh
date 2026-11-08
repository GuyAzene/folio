#!/usr/bin/env bash
# Runs a command, and runs it again when it failed because one of GitHub's downloads answered
# with a server error (5xx), as GitHub's release downloads do now and then: five tries over about
# four minutes, then the job fails saying GitHub's downloads are down. Any other failure fails at
# once, so a check that fails is never tried again. What the command downloads is still checked
# against its checksums: Electron against its package's checksums.json, electron-builder's tools
# against electron-builder's own.
#
#   bash .github/scripts/retry-downloads.sh vp run desktop:package
log=$(mktemp)
for wait in 15 30 60 120 0; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if [ "$status" = 0 ]; then exit 0; fi
  # @electron/get and electron-builder say "HTTPError: Response code 504 (Gateway Time-out)".
  if ! grep -q -E "HTTPError: Response code 5[0-9]{2}" "$log"; then exit "$status"; fi
  if [ "$wait" = 0 ]; then break; fi
  echo "::warning::A download from GitHub failed with a server error; trying again in $wait seconds."
  sleep "$wait"
done
echo "::error::Downloads from GitHub failed with server errors five times over four minutes, so its release downloads are down. Re-run this job once they're back."
exit 1
