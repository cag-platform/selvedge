# Selvedge for Mac

The native menu-bar bridge for Apple project work. It pairs through the signed-in Selvedge website, creates the machine credential locally, stores it in Keychain, starts at login, reports Xcode/Codex/Claude Code readiness, and runs the existing bounded Apple worker without a Terminal window.

Build the internal preview on an Apple Silicon Mac:

```sh
scripts/build-mac-app.sh
```

The preview archive is written to `dist/mac/Selvedge-for-Mac.zip` and is ad-hoc signed for local testing. A public release still requires an Apple Developer ID Application signature, notarization, a bundled worker runtime that does not depend on a separately installed Node executable, and an update feed.
