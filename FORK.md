# Fork notes

This repository is a local fork of
[zkforge/dsh-claude-desktop-theme](https://github.com/zkforge/dsh-claude-desktop-theme)
(the DeepSeek Harness Claude-desktop-style theme). The first commit is the
verbatim upstream 0.10.6 source; every later commit is one local change.

## What changed, commit by commit

| Commit | Change |
|---|---|
| `chore: import upstream ...` | Upstream 0.10.6 source snapshot (baseline). |
| `feat(balance): read the signed-in account wallet ...` | `src/host/balance.ts` falls back to DSH's account service (`ctx.get('deepseekAccount').getBalance()`) when no API key is configured. |
| `feat(composer): three-line composer ...` | Three-line editable floor, no send button, no in-field placeholder, no context ring, 24px transcript leading, and `composer-autoscroll.ts` follows the tail after Enter. |
| `feat(sidebar): three navigation rows ...` | Only New session / Search / More stay in the column; workspace grouping by default; native per-row status marks kept; `host-rules.ts` resolves host selectors for the running build and tightens the navigation gap. |
| `feat(account): put the balance on the account row ...` | Balance moved into the footer as a capsule, hit areas separated, feedback button and theme-drawn chevron removed. |
| `feat(account): trim the balance hover panel` | Heading, total summary and ledger note deleted from the hover panel. |
| `feat(account): archived-only switch in the More submenu` | A check row in the account menu's More submenu flips the host's archived-row filter between `only` and the default hide. It reads and writes through the view-options driver (`ArchivedViewPort`), so the host's browser store stays the single source; the empty state's "show all sessions" now returns to the default instead of leaving archived rows inline. |
| `feat(sidebar): keep empty workspaces visible by default` | `view.showEmptyGroups` now defaults on, so a Workspace keeps its heading before its first Session and when the current filter leaves it empty. The switch is authoritative: with it off, empty Workspaces leave the column and a column with no history gives way to the welcome prompt. The empty state itself is decided by visible Session rows, so a filter that matches nothing still offers "show all sessions". |
| `chore(build): give the fork its own package identity` | `dsh-claude-desktop-theme-fork`, bundle row renamed, `scripts/build-fork.mjs` (esbuild only, no `.d.ts`). |

## Install locally

The fork is linked into the DSH `desktop` profile, not installed from npm:

```
~/.dsh/profiles/desktop/package.json
  dependencies: "dsh-claude-desktop-theme-fork": "link:E:/.../dsh-claude-theme-fork"
  dsh.profile.bundles: [..., "dsh-claude-desktop-theme-fork"]
  node_modules/dsh-claude-desktop-theme-fork -> junction to this directory
```

Build first (`node scripts/build-fork.mjs`), then restart DSH Desktop.

## Maintaining it

**After a DSH update.** Host CSS-module class names are hashed per build, so
every selector the theme authors can miss. Re-resolve the prefix table from the
new `app.asar`, rebuild, restart:

```sh
node scripts/host-prefixes.mjs --windows "<DSH>/resources/app.asar"          # inspect
node scripts/host-prefixes.mjs --windows "<DSH>/resources/app.asar" --write  # write
node scripts/build-fork.mjs
```

**After an upstream release.** The upstream default branch is `main`:

```sh
git fetch upstream
git log --oneline HEAD..upstream/main      # what is new
git merge upstream/main                    # conflicts land in the files above
node scripts/build-fork.mjs
```

**Building.** `scripts/build-fork.mjs` runs the upstream esbuild pipeline but
skips the `tsc` declaration pass; a link install only consumes `lib/index.js`
and `lib/client.js`. `npm run build` (upstream) still works if the devDependencies
are installed.

## Rolling back

Restore the profile manifest backup (`package.json.bak-before-fork`), remove the
`node_modules/dsh-claude-desktop-theme-fork` junction, and restart. The npm
package can then be installed again from the registry.
