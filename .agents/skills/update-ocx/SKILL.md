---
name: update-ocx
description: Use when the local OpenCodex checkout and its global-node-tools installation must be refreshed from upstream while the active Codex session depends on that proxy.
---

# Update OCX

Refresh the current OpenCodex branch from `upstream/main`, build a local npm
tarball without linking it, publish it through `global-node-tools`, repair the
supervised proxy, verify the effective immutable release, then commit and push.

## CONNECTION-SEVERING TRAP — NEVER SPLIT THE HANDOFF

**The OpenCodex proxy being replaced may be carrying this exact Codex session.**

`global-node-tools` publishes immutable releases and moves its managed
`current` link. The systemd unit does not follow that link dynamically:
`ExecStart` contains the immutable release path selected when
`ocx service install` last wrote the unit.

If package installation is terminal/tool call A and service repair is terminal/
tool call B, the session can disappear after A and before B is ever dispatched.
The shell must already own both operations before package publication begins.

The only permitted handoff shape is **one shell invocation** containing both
commands, separated by a literal semicolon:

```bash
global-node-tools install --bypass '<absolute-artifact-path>'; install_rc=$?; ocx service install; service_rc=$?; printf 'install_rc=%s\nservice_rc=%s\n' "$install_rc" "$service_rc"; handoff_rc=0; if [ "$install_rc" -ne 0 ]; then handoff_rc=1; fi; if [ "$service_rc" -ne 0 ]; then handoff_rc=1; fi; exit "$handoff_rc"
```

Replace the placeholder with the literal absolute content-addressed artifact
path before dispatching the whole line in one terminal/tool call.

**Never:**

- Put the two commands in separate terminal/tool calls.
- Use `&&`; service repair must run even when package installation returns
  nonzero.
- Enable `set -e` around the handoff.
- Insert `ocx --version`, logging, status, or any other command between package
  installation and `ocx service install`.
- Stop, restart, uninstall, or kill `opencodex-proxy.service` separately.
- Invent an explicit rollback install. The PATH-selected `ocx service install`
  repairs the service against the effective managed `current` release whether
  the target publication succeeded or failed.
- Treat a disconnected tool call as proof of failure. Its outcome is unknown
  until read back.

| Red flag | Why it is unsafe |
| --- | --- |
| Install now, repair in the next call | The connection can vanish before the repair is dispatched. |
| `install ... && ocx service install` | A failed install skips the repair. Use the exact semicolon command above. |
| `set -e` | A nonzero install exits the shell before repair. |
| Verify the version between operations | That recreates the severed-session window. |
| Stop the service first | It deliberately drops the session before a replacement is ready. |
| Blindly reinstall after reconnect | Disconnect does not reveal which transaction steps completed. |
| Check only `current` or `ocx --version` | Neither proves what immutable path the live service executes. |

## 1. Preflight

1. Read the repository instructions and use `lcm-memory`. Identify the primary
   worktree with `git worktree list --porcelain`; when operating in another
   local worktree, read `<primary-worktree>/AGENTS.local.md` if it exists.
2. Require a named current branch. Refuse detached HEAD and direct operation on
   `main`, `dev`, or `preview` unless the user explicitly overrides that branch
   boundary.
3. By default, require an empty index and no tracked modifications. Record and
   preserve unrelated untracked files.
4. The clean-tracked-worktree rule is a safety default, not an invariant. A
   direct user instruction may choose scoped stashing, selected commit-first
   handling, named paths to preserve, or another approach. Apply that choice
   only to its stated scope. Never infer an override from urgency, and never
   stage, commit, stash, restore, or delete unrelated paths.
5. Inspect and record:
   - current branch, `HEAD`, and its `origin` destination;
   - `global-node-tools status`, managed `current`, and managed `previous`;
   - `ocx --version` and `readlink -f "$(command -v ocx)"`;
   - systemd `ActiveState`, `SubState`, `MainPID`, and `ExecStart`;
   - `ocx service status` and the live `/readyz` body and port.
6. Require the proxy to be active and ready before a session-preserving update.

Use the exact Bun version pinned by the repository, not an arbitrary shell
default. Resolve it from the active immutable release:

```bash
gnt_bin="$(readlink -f "$(command -v global-node-tools)")"
gnt_home="$(cd "$(dirname "$gnt_bin")/.." && pwd -P)"
before_current="$(readlink -f "$gnt_home/current")"
before_previous="$(readlink -f "$gnt_home/previous")"
before_pid="$(systemctl --user show opencodex-proxy.service -p MainPID --value)"
bun_bin="$before_current/node_modules/bun/bin/bun.exe"
pinned_bun="$(node -p 'require("./package.json").dependencies.bun')"
test -x "$bun_bin"
test "$("$bun_bin" --version)" = "$pinned_bun"
export PATH="$before_current/node_modules/.bin:$PATH"
hash -r
test "$(readlink -f "$(command -v bun)")" = "$bun_bin"
test "$(bun --version)" = "$pinned_bun"
```

## 2. Merge upstream

Fetch and inspect the divergence. If `upstream/main` is already an ancestor of
`HEAD`, stop as an up-to-date no-op before building or installing anything.
Otherwise create a merge commit with GPG signing and DCO signoff even when the
history could fast-forward:

```bash
git fetch upstream main
if git merge-base --is-ancestor upstream/main HEAD; then
  printf 'Already contains upstream/main; nothing to update.\n'
  exit 0
fi
pre_merge_head="$(git rev-parse HEAD)"
git merge --no-ff --no-edit --signoff --gpg-sign upstream/main
```

Resolve conflicts semantically. Preserve intentional local behavior and never
use a blanket ours/theirs resolution. If the merge stopped for conflicts,
stage only resolved paths and finish it with:

```bash
git commit --no-edit --gpg-sign --signoff
```

Require `HEAD` to differ from `pre_merge_head`, require `upstream/main` to be an
ancestor of the result, and require `HEAD` to be the new two-parent merge
commit. Verify its signature and `Signed-off-by` trailer.

## 3. Build and inspect the tarball — no repository test suite

Do **not** run `bun run prepush`, `bun run test`, the full test suite, standalone
typecheck/lint gates, `privacy:scan`, or GUI doctor. The user selected the
build, package-integrity, and live-runtime checks below as the acceptance gate.

Install only from the lockfile, build the GUI/package, and pack without linking:

```bash
bun install --frozen-lockfile
mkdir -p .tmp
npm run build:gui
npm pack --pack-destination .tmp --json > .tmp/update-ocx-pack.json
tarball="$(node -e 'const fs=require("node:fs"),path=require("node:path");const [p]=JSON.parse(fs.readFileSync(".tmp/update-ocx-pack.json","utf8"));if(!p)process.exit(2);process.stdout.write(path.resolve(".tmp",p.filename))')"
test -f "$tarball"
```

Never use `npm link`, `bun link`, or a repository-linking installer.

Inspect the pack JSON and tarball. Require exactly one package with the expected
name and version, plus all of these files:

```text
package/package.json
package/gui/dist/index.html
package/src/server/responses/collaboration.ts
```

Require the packed `package.json` version to match the checkout. Compare the
packed collaboration source byte-for-byte with the checkout so the local
override is proven present. Confirm project skills, unrelated untracked files,
and repository-only material are absent from the package.

## 4. Publish the SHA-512 artifact

Copy the verified tarball directly into the managed artifact directory. The
filename digest is part of the integrity contract:

```bash
digest="$(sha512sum "$tarball" | awk '{print $1}')"
artifact="$gnt_home/artifacts/$(basename "${tarball%.tgz}").sha512-$digest.tgz"
install -m 0600 "$tarball" "$artifact"
test "$(sha512sum "$artifact" | awk '{print $1}')" = "$digest"
stat -c 'artifact=%n mode=%a size=%s' "$artifact"
```

Require a 128-character lowercase hexadecimal digest and mode `0600`. Do not
install from the mutable `.tmp` tarball or through a symlink.

Immediately before the handoff, refresh and record `before_current`,
`before_previous`, and `before_pid`.

## 5. Perform the indivisible handoff

**STOP AND CHECK THE TOOL-CALL BOUNDARY.** The following must be dispatched as
one complete terminal/tool call. Do not run the first command until the second
command is already part of that same submitted shell program:

```bash
global-node-tools install --bypass '<absolute-artifact-path>'; install_rc=$?; ocx service install; service_rc=$?; printf 'install_rc=%s\nservice_rc=%s\n' "$install_rc" "$service_rc"; handoff_rc=0; if [ "$install_rc" -ne 0 ]; then handoff_rc=1; fi; if [ "$service_rc" -ne 0 ]; then handoff_rc=1; fi; exit "$handoff_rc"
```

Both return codes must be zero before the target update can succeed.

Do not answer or automate a GitHub-star prompt. If OpenCodex emits an agent
deferral, ask the user exactly once near the top of the next response:

```text
Star lidge-jun/opencodex? Yes / No
```

## 6. Recover after a disconnected or ambiguous handoff

Inspect before retrying. Read back the managed `current` and `previous` links,
release metadata, transaction status, `ocx --version`, resolved executable,
service state, PID, `ExecStart`, process command line, and `/readyz`.

- If the target release was published but the service still executes an older
  immutable path, run only `ocx service install`, then verify again.
- If the target is already live and ready, perform no mutation.
- Retry package installation only when managed release metadata proves the
  target transaction did not complete.
- Never claim failure or success solely because the original tool response was
  lost.

## 7. Verify the effective release

Require all of the following:

1. Managed `current` changed and managed `previous` equals `before_current`.
2. `readlink -f "$(command -v ocx)"` resolves through the new release and
   `ocx --version` matches the packed version.
3. The new `release.json` records operation `install`, `bypass: true`, and the
   expected direct `@bitkyc08/opencodex` version.
4. The managed `package-lock.json` has lockfile version 3, points at the exact
   content-addressed artifact, and records SHA-512 integrity.
5. systemd reports `active/running` with a nonzero PID.
6. systemd `ExecStart` and `/proc/<MainPID>/cmdline` both contain the new
   immutable release path.
7. `/readyz` reports service `opencodex`, the expected version, the configured
   port, and status `ready`.
8. The installed collaboration source is byte-identical to the checkout.
9. Unrelated worktree state matches the preflight inventory and any explicit
   user-selected worktree override.

Symlink readback or a CLI version alone is not completion. The live process path
and readiness response are the effective-behavior proof.

## 8. Commit and push every successful update

After, and only after, live verification succeeds:

1. Stage only intended paths. Never use `git add -A` or `git add .` in a dirty
   worktree.
2. Commit actual remaining intended changes with `--gpg-sign --signoff`. The
   signed merge commit already counts as the update commit when it contains all
   repository changes; never manufacture an empty commit.
3. Verify signatures, DCO trailers, `git diff --check`, upstream ancestry, and
   the user-selected worktree-state contract.
4. Push the current branch to `origin` with `git push --no-verify`, never with
   force. `--no-verify` bypasses only the deliberately waived local pre-push
   hook; it does not weaken remote/ref verification or permit a force push.
5. Query `refs/heads/<current-branch>` with `git ls-remote` and require its SHA
   to equal local `HEAD`.

Do not commit or push when installation or live verification failed. A direct
user instruction may override Git handling for that invocation; apply it only
to the scope the user named.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Shell Bun differs from `package.json` | Use the bundled Bun from the active immutable release. |
| `.tmp` tarball passed to the controller | Copy it to the SHA-512 artifact store first. |
| Package manifest looks plausible | Also compare the locally modified packaged source byte-for-byte. |
| Service command reports success | Prove systemd, `/proc`, and `/readyz` agree on the new release. |
| Connection drops during handoff | Reconnect and inspect; do not blindly rerun. |
| Existing tracked changes are present | Refuse by default or follow only the user's explicit scoped override. |
