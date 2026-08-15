#!/usr/bin/env bash
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin feat/codex-log-guard-protect feat/codex-log-guard-reclaim

echo "Protect: $(git rev-parse origin/feat/codex-log-guard-protect)"
echo "Reclaim: $(git rev-parse origin/feat/codex-log-guard-reclaim)"

git checkout -B feat/codex-log-guard-reclaim origin/feat/codex-log-guard-reclaim
set +e
git merge --no-commit --no-ff origin/feat/codex-log-guard-protect
merge_status=$?
set -e

echo "merge_status=${merge_status}"
echo "--- conflicted paths ---"
git diff --name-only --diff-filter=U || true
echo "--- status ---"
git status --short
echo "--- conflict marker context ---"
while IFS= read -r file; do
  [ -n "$file" ] || continue
  echo "===== ${file} ====="
  grep -n -C 10 -E '^(<<<<<<<|=======|>>>>>>>)' "$file" || true
done < <(git diff --name-only --diff-filter=U)

if [ "$merge_status" -eq 0 ]; then
  echo "Merge is clean; no manual resolution needed."
  exit 0
fi
exit 1
