# Releasing

How a build reaches a machine that is not this one (plan WP 1.12).

Everything here is the same on every release. What is *not* the same is
the first one: the two accounts below take days to weeks to obtain, and
nothing can be signed or notarized until they exist.

---

## 1. What has to exist first

### Apple Developer Program — required for macOS

Without it there is no Developer ID certificate, and without that
certificate macOS Gatekeeper refuses the app on any machine but the one
that built it. Enrollment is $99 a year and takes anywhere from a day to
several weeks; an organization enrollment also needs a D-U-N-S number,
which is its own wait.

**Status: enrolled.** The Developer ID Application certificate was
issued on 2026-09-12 to `Victor ZHANG (LWM57544W2)` — the surname in
capitals, as Apple wrote it, and the identity secret has to match it.
Without the certificate secrets, `release.yml` produces an unsigned macOS
bundle and says so in a workflow warning; the `.dmg` will open only
after a right-click → Open, and only on machines where somebody chooses
to trust it.

The steps, for the next certificate (they expire after five years):

1. In the Apple Developer portal, create a **Developer ID Application**
   certificate (G2 Sub-CA) from a signing request made in Keychain Access
   on the Mac that will export it, and download it.
2. On a Mac without Xcode, `security find-identity -v -p codesigning`
   then reports *0 valid identities*: the certificate is issued by
   Apple's **G2** intermediate, and macOS ships only the 2012 one. Install
   `DeveloperIDG2CA.cer` from <https://www.apple.com/certificateauthority/>
   and the identity turns valid.
3. Export it from Keychain Access (login → My Certificates) as a `.p12`
   with a password.
4. In App Store Connect → Users and Access → Integrations → App Store
   Connect API, create a key with the **Developer** role and download the
   `.p8`. Note the Key ID and the Issuer ID; the `.p8` can be downloaded
   once and never again.

### Windows code signing — not wired

The plan asks for it. It is deliberately not in `release.yml`: Azure
Trusted Signing is configured through a `bundle.windows.signCommand`
naming an endpoint, an account and a certificate profile, and none of
those three values can be guessed. `release.yml` builds Windows
unsigned. See "Adding Windows signing" at the end.

---

## 2. Repository secrets

| Secret | What it is | Needed for |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the updater key, whole file | **every** release |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password, empty here | every release |
| `APPLE_CERTIFICATE` | the `.p12`, base64 | signing macOS |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password | signing macOS |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` | signing macOS |
| `APPLE_API_KEY` | the App Store Connect **Key ID** | notarizing |
| `APPLE_API_ISSUER` | the App Store Connect **Issuer ID** | notarizing |
| `APPLE_API_KEY_BASE64` | the `.p8`, base64 | notarizing |

### The updater key

Generated once, on 2026-09-09, and it lives **outside this repository**:

```
~/.config/mdreader/updater.key       the private half, mode 600
~/.config/mdreader/updater.key.pub   the public half
```

The public half is already in `apps/desktop/src-tauri/tauri.conf.json`
under `plugins.updater.pubkey`, which is how every installed copy knows
what a genuine update looks like.

**If the private half is lost, no future release can update an installed
app.** The pubkey would have to change, which every already-installed
copy would reject — those copies would have to be reinstalled by hand.
Back it up somewhere that is not this laptop.

Setting the secrets, once `gh` is authenticated against the repository:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.config/mdreader/updater.key
printf '' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # --body "" waits on stdin
gh secret set APPLE_CERTIFICATE < <(base64 -i DeveloperID.p12)
gh secret set APPLE_API_KEY_BASE64 < <(base64 -i AuthKey_XXXXXXXXXX.p8)
```

---

## 3. Cutting a release

```bash
pnpm release:version 0.2.0     # the three files that carry the version
cargo check --workspace        # so Cargo.lock follows
pnpm check && pnpm test        # including the test that the three agree
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag starts `release.yml`, which:

1. builds a universal macOS `.app` and `.dmg`, an x64 and an arm64 `.msi`,
   and a Linux `.AppImage` and `.deb`;
2. signs each updater artifact with the updater key, and the macOS bundle
   with the Developer ID certificate, then notarizes and staples it;
3. builds `latest.json` from the `.sig` files that came out of the build,
   rather than from a list of names somebody maintains;
4. creates the GitHub release **as a draft**.

The tag is the whole trigger, and the workflow checks: both jobs are
skipped unless the ref is a `v*` tag. `workflow_dispatch` is still there,
for re-running a tag whose build fell over, but it has to be aimed at the
tag rather than at a branch — everything downstream reads the ref as a
version, so a branch would sign a build as `main` and draft a release
called `main`.

Then, by hand:

- Download the `.dmg` and open it on a machine that did not build it.
  This is the only check that catches a signing or notarization problem,
  because the machine that built it trusts it either way.
- Write the release notes.
- **Publish the draft.** That is the moment
  `releases/latest/download/latest.json` starts resolving and every
  running copy of the app is offered the update.

### The two names macOS goes out under

The macOS bundle is universal, but `darwin-universal` is not a name the
updater ever asks for. It looks itself up as `{os}-{arch}`, and on macOS
the arch is the machine's own: `darwin-aarch64` or `darwin-x86_64`. A
manifest carrying only `darwin-universal` therefore updates no Mac at
all, and does it silently — a target the updater cannot find reads to the
app as "there is nothing new".

So `latest.json` carries the one universal bundle under **both** of those
keys, pointing at the same file and the same signature. The workflow
matrix and the command line still say `darwin-universal`, because that is
honestly what was built; the two names are made where the manifest is
written, in `tools/release/manifest.mjs`. It is worth a glance at the
`cat latest.json` in the workflow log: a published manifest with a
`darwin-universal` key in it is one that updates no Mac.

### Backing one out

Delete the release, or mark it a draft again. `latest` then resolves to
the release before it. An app that has already downloaded the update will
still install it — the download is on disk by then.

---

## 4. What the app does with all this

- On launch, ten seconds in, and every six hours after that, the window
  asks the endpoint whether there is something newer. If there is not, or
  if the network is not there, it says nothing.
- If there is, the status bar grows one cell: *Version 0.2.0 is
  available*. Pressing it downloads; pressing it again restarts.
- **Check for Updates…** in the palette does the same thing on demand and
  reports back either way. It is also on the Settings tab, next to the
  version.
- A restart flushes whatever is pending first, so an autosave still on
  its timer is not lost to the relaunch.

---

## 5. Adding Windows signing

When a certificate exists, add an overlay beside
`unsigned.conf.json` — say `signed.windows.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"
    }
  }
}
```

install `trusted-signing-cli` in the Windows leg of `release.yml`, pass
`--config src-tauri/signed.windows.conf.json` to `tauri build`, and give
the job `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`.
An OV certificate on a hardware token cannot be used from CI at all and
would mean signing releases by hand.

---

## 6. If the repository moves

The updater endpoint in `tauri.conf.json` names
`github.com/victor-eu/markdown`. It is baked into every build, so a copy
of the app installed before a move will keep asking the old address.
Change it *before* the first published release, not after.
