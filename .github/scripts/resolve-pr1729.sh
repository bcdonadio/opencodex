#!/usr/bin/env bash
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin feat/codex-log-guard-inspect feat/codex-log-guard-protect

protect_before="$(git rev-parse origin/feat/codex-log-guard-protect)"
inspect_before="$(git rev-parse origin/feat/codex-log-guard-inspect)"
echo "Protect: ${protect_before}"
echo "Inspect:  ${inspect_before}"

git checkout -B feat/codex-log-guard-protect origin/feat/codex-log-guard-protect
set +e
git merge --no-commit --no-ff origin/feat/codex-log-guard-inspect
merge_status=$?
set -e
if [ "$merge_status" -eq 0 ]; then
  echo "Unexpected clean merge; refusing scripted conflict assumptions."
  exit 1
fi

expected_conflicts="$(cat <<'EOF'
docs-site/src/content/docs/guides/codex-log-guard.md
gui/src/components/storage-workspace/StorageWorkspace.tsx
gui/src/i18n/log-guard-labels.ts
src/cli/codex-log-guard-doctor.ts
src/cli/observe.ts
src/server/management/context.ts
src/server/management/storage-log-guard-routes.ts
EOF
)"
actual_conflicts="$(git diff --name-only --diff-filter=U | sort)"
if [ "$actual_conflicts" != "$(printf '%s\n' "$expected_conflicts" | sort)" ]; then
  echo "Conflict set changed; refusing automatic resolution."
  printf '%s\n' "$actual_conflicts"
  exit 1
fi

# These files were introduced independently by Inspect and Protect. Protect is
# intentionally a strict superset of the Inspect-only surface.
git checkout --ours -- \
  docs-site/src/content/docs/guides/codex-log-guard.md \
  gui/src/i18n/log-guard-labels.ts \
  src/cli/codex-log-guard-doctor.ts \
  src/server/management/storage-log-guard-routes.ts

# Retain auto-merged surrounding parent changes and choose Protect only inside
# conflicts for shared files.
python3 - <<'PY'
from pathlib import Path

def keep_ours_conflicts(path: str) -> None:
    p = Path(path)
    lines = p.read_text().splitlines(keepends=True)
    out: list[str] = []
    i = 0
    conflicts = 0
    while i < len(lines):
        if not lines[i].startswith("<<<<<<< HEAD"):
            out.append(lines[i])
            i += 1
            continue
        conflicts += 1
        i += 1
        while i < len(lines) and not lines[i].startswith("======="):
            out.append(lines[i])
            i += 1
        if i >= len(lines):
            raise RuntimeError(f"unterminated ours section in {path}")
        i += 1
        while i < len(lines) and not lines[i].startswith(">>>>>>>"):
            i += 1
        if i >= len(lines):
            raise RuntimeError(f"unterminated theirs section in {path}")
        i += 1
    if conflicts == 0:
        raise RuntimeError(f"expected conflicts in {path}")
    p.write_text("".join(out))

keep_ours_conflicts("gui/src/components/storage-workspace/StorageWorkspace.tsx")
keep_ours_conflicts("src/cli/observe.ts")
PY

# ManagementContext gained unrelated startup/restart seams on current Inspect.
# Start from that parent version and add only Protect's dependency seam.
git checkout --theirs -- src/server/management/context.ts
python3 - <<'PY'
from pathlib import Path
p = Path("src/server/management/context.ts")
text = p.read_text()
import_anchor = 'import type { NativeProfileApiDeps } from "../../codex/native-profile-api";\n'
import_line = 'import type { CodexLogGuardProtectionDeps } from "../../codex/log-guard/protection";\n'
if import_line not in text:
    if import_anchor not in text:
        raise RuntimeError("ManagementContext import anchor changed")
    text = text.replace(import_anchor, import_anchor + import_line, 1)

field_anchor = '  nativeProfileApi?: NativeProfileApiDeps;\n'
field_block = '''  /**
   * Log Guard mutation seam. Production leaves this unset and therefore uses the
   * owner-verified process enumerator, trusted L namespace and real config store.
   * Route tests inject all three so they cannot depend on local Codex processes
   * or create lock/config state outside the fixture.
   */
  codexLogGuardProtectionDeps?: CodexLogGuardProtectionDeps;
'''
if "codexLogGuardProtectionDeps?:" not in text:
    if field_anchor not in text:
        raise RuntimeError("ManagementContext field anchor changed")
    text = text.replace(field_anchor, field_anchor + field_block, 1)
p.write_text(text)
PY

resolved_files=(
  docs-site/src/content/docs/guides/codex-log-guard.md
  gui/src/components/storage-workspace/StorageWorkspace.tsx
  gui/src/i18n/log-guard-labels.ts
  src/cli/codex-log-guard-doctor.ts
  src/cli/observe.ts
  src/server/management/context.ts
  src/server/management/storage-log-guard-routes.ts
)

git add "${resolved_files[@]}"

if git diff --name-only --diff-filter=U | grep -q .; then
  echo "Unresolved conflicts remain:"
  git diff --name-only --diff-filter=U
  exit 1
fi
for file in "${resolved_files[@]}"; do
  if grep -n -E '^(<<<<<<<|=======|>>>>>>>)' "$file"; then
    echo "Conflict markers remain in ${file}."
    exit 1
  fi
done
git diff --check --cached

bun install --frozen-lockfile
(cd gui && bun install --frozen-lockfile)

bun test \
  tests/api-codex-log-guard-protection.test.ts \
  tests/api-codex-log-guard.test.ts \
  tests/cli-codex-log-guard-protection.test.ts \
  tests/cli-codex-log-guard.test.ts \
  tests/codex-app-server-processes.test.ts \
  tests/codex-log-guard-doctor-protection.test.ts \
  tests/codex-log-guard-doctor.test.ts \
  tests/codex-log-guard-lock.test.ts \
  tests/codex-log-guard-processes.test.ts \
  tests/codex-log-guard-protection.test.ts \
  tests/codex-log-guard-status-zero-write.test.ts

bun run typecheck
bun run privacy:scan
(
  cd gui
  bun test tests/storage-log-guard.test.tsx tests/storage-log-guard-protection.test.tsx
  bun run lint
  bun x tsc -b
)

# Refuse to overwrite either branch if it moved while verification ran.
git fetch origin feat/codex-log-guard-inspect feat/codex-log-guard-protect
test "$(git rev-parse origin/feat/codex-log-guard-protect)" = "$protect_before" || {
  echo "Protect moved during verification; refusing push."
  exit 1
}
test "$(git rev-parse origin/feat/codex-log-guard-inspect)" = "$inspect_before" || {
  echo "Inspect moved during verification; refusing push."
  exit 1
}

git commit -m "merge: sync Inspect into Protect"
git push origin HEAD:feat/codex-log-guard-protect
