<!-- Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. -->
<!-- SPDX-License-Identifier: MIT-0 -->

# Releasing LaunchBridge

Steps for maintainers who publish a LaunchBridge release. Users verify releases as described in [Verifying a release](README.md#verifying-a-release).

## One-time setup: the release signing key

Release tags are signed with a dedicated SSH key, used for nothing else.

1. Create the key, protected with a passphrase (or use a hardware-backed key with `-t ed25519-sk`):

   ```bash
   ssh-keygen -t ed25519 -C launchbridge-release -f ~/.ssh/launchbridge_release
   ```

2. Add `~/.ssh/launchbridge_release.pub` to the releasing GitHub account as a **signing key** (Settings → SSH and GPG keys → New SSH key → Key type: Signing key).
3. Publish the public key and its fingerprint in `README.md` ("Verifying a release"): replace `<release-signing-public-key>` with the `ssh-ed25519 AAAA…` part of `~/.ssh/launchbridge_release.pub`, and `<release-signing-key-fingerprint>` with the `SHA256:…` value from:

   ```bash
   ssh-keygen -lf ~/.ssh/launchbridge_release.pub
   ```

4. Create the allowed-signers file used to check tags:

   ```bash
   mkdir -p ~/.config/launchbridge
   echo "launchbridge-release namespaces=\"git\" $(cut -d' ' -f1,2 ~/.ssh/launchbridge_release.pub)" \
     > ~/.config/launchbridge/allowed_signers
   ```

5. In the GitHub repository, add a tag ruleset for `v*` that restricts who can create, update and delete release tags.

If the key is lost or exposed, create a new one, replace the public key and fingerprint in `README.md`, remove the old key from GitHub, and say so in the next release notes.

## Before a release

Run these from a clean clone of the commit you intend to release:

```bash
npm run setup
npm test
uv run --no-project --python 3.12 \
  --with numpy==2.5.5 --with boto3==1.44.11 --with munkres==1.1.4 \
  --with pydantic==2.14.4 --with pytest==9.2.0 --with pyyaml==6.0.4 \
  --with mcp==2.3.0 --with plotly==7.1.0 --with pandas==3.1.1 --with pathspec==1.1.1 --with chardet==7.7.0 \
  pytest tests/unit
./run_lint.sh --check
git grep -n -E "<org>|<release-signing" -- . ':!RELEASING.md'   # must print nothing
```

The `--with` pins come from `project_dependencies/constraints.txt` (`plotly`, which is not in it, matches the operational-metrics dashboard install); update them when it changes.

Check the Python dependencies' licences against `licensecheck.toml`, from the repository root (`licensecheck` reads the policy from there); this must exit 0:

```bash
uvx --from licensecheck==2026.0.8 licensecheck -r project_dependencies/constraints.txt --zero
```

`licensecheck` resolves each package's latest PyPI release, not the pin, so also check the exact pinned versions in a scratch environment; this must exit 0 too:

```bash
LC_VENV=$(mktemp -d)
uv venv -q --python 3.12 "$LC_VENV"
grep '==' project_dependencies/constraints.txt > "$LC_VENV/pins.txt"
uv pip install -q --python "$LC_VENV/bin/python" --no-deps -r "$LC_VENV/pins.txt"
uvx --from pip-licenses==5.5.5 pip-licenses --python "$LC_VENV/bin/python" --partial-match \
  --fail-on "GPL;AGPL;LGPL;GNU General Public;GNU Affero;GNU Lesser;SSPL"
```

Packages for another platform (the Windows-only ones in `constraints.txt`) are skipped there; check them on that platform when they change.

CI runs on Linux only, so check a global install by hand on Windows before a release that changes the installer or lb-setup's scripts. Use PowerShell, a user without Administrator rights, a clone of the release with `git submodule update --init` and `npm ci` run in it (not `npm run setup`: npm runs scripts with `cmd.exe` on Windows, which has no `unset`, and its `npm link` would replace your own `launchbridge` command), and a scratch project (`mkdir $env:TEMP\lb-check; cd $env:TEMP\lb-check; git init`). The steps install globally, so run them with a throwaway profile, which leaves your own global install alone: in the PowerShell window you run them in, point `USERPROFILE` at a new folder, which the installer and lb-setup's scripts then take as your home folder, `XDG_CONFIG_HOME` (LaunchBridge keeps its records under it when it is set) at the `.config` folder in it, and `launchbridge` at the release clone's installer (put the clone's path in place of `<release clone>`):

```powershell
mkdir $env:TEMP\lb-profile
$env:USERPROFILE = "$env:TEMP\lb-profile"
$env:XDG_CONFIG_HOME = "$env:USERPROFILE\.config"
function launchbridge { node "<release clone>\install_script\index.js" @args }
```

1. **Copy install.** Run `launchbridge --scope global --agent claude,kiro --skills all --method copy --yes` from any folder. It exits 0, the skills are under `$env:USERPROFILE\.claude\skills` and `$env:USERPROFILE\.kiro\skills`, the record is in `$env:USERPROFILE\.config\launchbridge\global\manifest.json`, and the folder it ran in is unchanged.
2. **Symlink install, Developer Mode off.** `launchbridge --scope global --agent claude --skills lb-setup --method symlink --yes` exits 0: `$env:USERPROFILE\.claude\skills\lb-setup` is a junction to the clone's `skills\lb-setup` (`(Get-Item $env:USERPROFILE\.claude\skills\lb-setup).LinkType` prints `Junction`), the clone has no `skills\lb-setup\assets`, and `$env:USERPROFILE\.config\launchbridge\global\generated\` holds regular files.
3. **Back to copy.** `launchbridge --scope global --agent claude --skills lb-setup --method copy --yes` exits 0, `lb-setup` is a real folder again, and the clone's `skills\lb-setup` is still all there.
4. **Preparing the project.** With `$S = "$env:USERPROFILE\.claude\skills\lb-setup\scripts"`, run `python -I "$S\bootstrap_workspace.py" mode "$env:TEMP\lb-check"` (prints `"mode": "global"`), then `python -I "$S\bootstrap_workspace.py" init "$env:TEMP\lb-check"` (exits 0, creates `.lb_workspace\` and `CLAUDE.md`), then `python -I "$S\venv_identity.py" deps "$env:TEMP\lb-check"` and `python -I "$S\verify_integrity.py" --global "$env:TEMP\lb-check"` (both exit 0). Run `init` a second time: it exits 0 and prints `"resets": {}`. `python -I "$S\bootstrap_workspace.py" check "$env:USERPROFILE"` exits 1, and `mode` exits 1 for `"$env:USERPROFILE"` and for `"$env:USERPROFILE\.claude"`.
5. **Update.** `launchbridge update` from any folder reports the global install as up to date and exits 0.
6. **Uncommitted change.** Add a line to the clone's `skills\lb-setup\SKILL.md`. `launchbridge update` exits 0, says it kept lb-setup at the version the global install recorded and names `skills/lb-setup/SKILL.md`, and the line is not in `$env:USERPROFILE\.claude\skills\lb-setup\SKILL.md`. Undo the change with `git checkout -- skills/lb-setup/SKILL.md` in the clone.

Afterwards, remove both folders with `cd $env:TEMP; cmd /c rmdir /s /q lb-profile; cmd /c rmdir /s /q lb-check` (`rmdir /s` removes a junction without following it into the clone), and close the window, which drops the `launchbridge` function too. Your own global install and `launchbridge` command are as they were.

Then set the release version, the same in every file:

- `version.txt` (first token on the first line; the installer reads it)
- `package.json`
- `package-lock.json` (run `npm install --package-lock-only` after changing `package.json`)
- the example release tag (`v<version>`) in `QUICKSTART_INSTALL.md`'s clone steps and in `README.md`'s Verifying a release

Commit the version change. The release tag points at this commit.

## Tag and verify

Create a signed, annotated tag with the release key:

```bash
git -c gpg.format=ssh -c user.signingkey=~/.ssh/launchbridge_release.pub \
  tag -s v<version> -m "LaunchBridge <version>"
```

Verify it before pushing, exactly as users will:

```bash
git -c gpg.ssh.allowedSignersFile=~/.config/launchbridge/allowed_signers verify-tag v<version>
```

It must print `Good "git" signature for launchbridge-release`. Never push an unsigned or unverified `v*` tag; if verification fails, delete the local tag (`git tag -d v<version>`) and fix the cause first. Then push the tag:

```bash
git push origin v<version>
```

## GitHub release and SBOMs

Generate the CycloneDX SBOMs for the tagged commit (the frozen Python set and the installer's runtime npm dependencies from `package-lock.json`):

```bash
git checkout v<version>
./install_script/make-sbom.sh sbom
```

Create the release from the signed tag and attach **both** SBOMs:

```bash
gh release create v<version> --verify-tag \
  --title "LaunchBridge <version>" --notes-file <release-notes.md> \
  sbom/python.cdx.json sbom/npm.cdx.json
```

The release notes must include:

- the release signing key fingerprint (`SHA256:…`), matching `README.md`
- what changed, including removed skills and any upgrade steps for existing installs
- any known dependency advisory that is not yet fixed, with why it is or is not reachable

After publishing, check that the release page lists `python.cdx.json` and `npm.cdx.json`, and that `git verify-tag` passes on a fresh clone.
