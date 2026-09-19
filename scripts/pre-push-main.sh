#!/usr/bin/env bash
# lefthook pre-push entry: run integration tests only when the push updates
# refs/heads/main on the remote. Reads git's ref lines from stdin (requires
# lefthook's use_stdin: true). Branch deletions never trigger the suite.
set -euo pipefail

target_main=0
while read -r local_ref local_oid remote_ref remote_oid; do
	[ "$remote_ref" = "refs/heads/main" ] || continue
	# all-zero local oid means the remote branch is being deleted
	if [[ "$local_oid" =~ ^0+$ ]]; then
		continue
	fi
	target_main=1
done

if [ "$target_main" -ne 1 ]; then
	echo 'pre-push: push does not update main — skipping integration tests'
	exit 0
fi

echo 'pre-push: push updates main — running integration tests (boots its own wrangler dev)'
exec node scripts/integration.mjs
