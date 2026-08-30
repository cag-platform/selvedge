# Selvedge for Mac

The native menu-bar bridge for Apple project work. It pairs through the signed-in Selvedge website, creates the machine credential locally, stores it in Keychain, starts at login, reports Xcode/Codex/Claude Code readiness, and runs the existing bounded Apple worker without a Terminal window.

Build the internal preview on an Apple Silicon Mac:

```sh
scripts/build-mac-app.sh
```

The preview archive is written to `dist/mac/Selvedge-for-Mac.zip`. Its worker is a self-contained Node Single Executable Application, so the customer does not install Node. The local preview is ad-hoc signed; a public release still requires an Apple Developer ID Application signature, notarization, and an update feed.

Public releases are produced by `.github/workflows/release-mac.yml` from tags named `mac-v*`. The repository must first receive the Developer ID certificate, certificate/keychain passwords, Apple ID, app-specific password, Team ID, and signing identity as GitHub Actions secrets named in that workflow.
