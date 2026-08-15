#!/usr/bin/env bash
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin feat/codex-log-guard-protect feat/codex-log-guard-reclaim

protect_before="$(git rev-parse origin/feat/codex-log-guard-protect)"
reclaim_before="$(git rev-parse origin/feat/codex-log-guard-reclaim)"
echo "Protect: ${protect_before}"
echo "Reclaim: ${reclaim_before}"

git checkout -B feat/codex-log-guard-reclaim origin/feat/codex-log-guard-reclaim
set +e
git merge --no-commit --no-ff origin/feat/codex-log-guard-protect
merge_status=$?
set -e
if [ "$merge_status" -eq 0 ]; then
  echo "Unexpected clean merge; refusing scripted conflict assumptions."
  exit 1
fi

actual_conflicts="$(git diff --name-only --diff-filter=U | sort)"
if [ "$actual_conflicts" != "src/server/management/context.ts" ]; then
  echo "Conflict set changed; refusing automatic resolution."
  printf '%s\n' "$actual_conflicts"
  exit 1
fi

# Current Protect contains newer startup/restart seams. Reclaim only needs to add
# its maintenance dependency and route-test seam on top of that parent version.
git checkout --theirs -- src/server/management/context.ts
python3 - <<'PY'
from pathlib import Path
p = Path("src/server/management/context.ts")
text = p.read_text()

import_anchor = 'import type { CodexLogGuardProtectionDeps } from "../../codex/log-guard/protection";\n'
maintenance_import = 'import type { CodexLogGuardMaintenanceDeps } from "../../codex/log-guard/maintenance";\n'
if maintenance_import not in text:
    if import_anchor not in text:
        raise RuntimeError("protection import anchor changed")
    text = text.replace(import_anchor, import_anchor + maintenance_import, 1)

field_anchor = '  codexLogGuardProtectionDeps?: CodexLogGuardProtectionDeps;\n'
maintenance_field = '''  /**
   * Log Guard maintenance seam. Production reuses the same fail-closed process
   * enumerator and L namespace as Protect; route tests keep all maintenance
   * state inside their temporary Codex home.
   */
  codexLogGuardMaintenanceDeps?: CodexLogGuardMaintenanceDeps;
'''
if "codexLogGuardMaintenanceDeps?:" not in text:
    if field_anchor not in text:
        raise RuntimeError("protection seam anchor changed")
    text = text.replace(field_anchor, field_anchor + maintenance_field, 1)

p.write_text(text)
PY

git add src/server/management/context.ts
if git diff --name-only --diff-filter=U | grep -q .; then
  echo "Unresolved conflicts remain:"
  git diff --name-only --diff-filter=U
  exit 1
fi
if grep -n -E '^(<<<<<<<|=======|>>>>>>>)' src/server/management/context.ts; then
  echo "Conflict markers remain in ManagementContext."
  exit 1
fi
git diff --check --cached -- src/server/management/context.ts

bun install --frozen-lockfile
(cd gui && bun install --frozen-lockfile)

bun test \
  tests/api-codex-log-guard-compact.test.ts \
  tests/api-codex-log-guard-protection.test.ts \
  tests/api-codex-log-guard.test.ts \
  tests/cli-codex-log-guard-compact.test.ts \
  tests/cli-codex-log-guard-protection.test.ts \
  tests/cli-codex-log-guard.test.ts \
  tests/codex-log-guard-doctor-protection.test.ts \
  tests/codex-log-guard-doctor.test.ts \
  tests/codex-log-guard-lock.test.ts \
  tests/codex-log-guard-maintenance-coderabbit.test.ts \
  tests/codex-log-guard-maintenance.test.ts \
  tests/codex-log-guard-processes.test.ts \
  tests/codex-log-guard-protection.test.ts \
  tests/codex-log-guard-status-zero-write.test.ts

bun run typecheck
bun run privacy:scan
(
  cd gui
  bun test \
    tests/storage-log-guard.test.tsx \
    tests/storage-log-guard-protection.test.tsx \
    tests/storage-log-guard-compact.test.tsx
  bun run lint
  bun x tsc -b
)

# Refuse to overwrite either branch if it moved during verification.
git fetch origin feat/codex-log-guard-protect feat/codex-log-guard-reclaim
test "$(git rev-parse origin/feat/codex-log-guard-protect)" = "$protect_before" || {
  echo "Protect moved during verification; refusing push."
  exit 1
}
test "$(git rev-parse origin/feat/codex-log-guard-reclaim)" = "$reclaim_before" || {
  echo "Reclaim moved during verification; refusing push."
  exit 1
}

git commit -m "merge: sync Protect into Reclaim"
git push origin HEAD:feat/codex-log-guard-reclaim
