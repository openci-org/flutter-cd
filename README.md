# Flutter CD

Build and deploy Flutter applications.

Zero external dependencies — uses only standard macOS tools (`openssl`, `curl`, `security`, `xcodebuild`, `python3`).

## Usage

### Web — Production Deploy

```yaml
- uses: openci-org/flutter-cd@v2.0.2
  with:
    platform: "web"
    working-directory: "apps/dashboard"
    firebase-service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
```

### Web — Preview Deploy (for PRs)

```yaml
- uses: openci-org/flutter-cd@v2.0.2
  with:
    platform: "web"
    working-directory: "apps/dashboard"
    firebase-service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
    preview: "true"
```

### iOS — Build & Upload to TestFlight

```yaml
- uses: openci-org/flutter-cd@v2.0.2
  with:
    platform: "ios"
    working-directory: "apps/dashboard"
    certificate-private-key: ${{ secrets.OPENCI_CERTIFICATE_PRIVATE_KEY }}
    asc-key-id: ${{ secrets.ASC_KEY_ID }}
    asc-issuer-id: ${{ secrets.ASC_ISSUER_ID }}
    asc-private-key: ${{ secrets.ASC_PRIVATE_KEY }}
```

### macOS — Build, Sign & Notarize

```yaml
- uses: openci-org/flutter-cd@v2.0.2
  with:
    platform: "macos"
    working-directory: "apps/dashboard"
    certificate-private-key: ${{ secrets.OPENCI_DEVELOPER_ID_PRIVATE_KEY }}
    asc-key-id: ${{ secrets.ASC_KEY_ID }}
    asc-issuer-id: ${{ secrets.ASC_ISSUER_ID }}
    asc-private-key: ${{ secrets.ASC_PRIVATE_KEY }}
    build-args: "--dart-define=SENTRY_DSN=${{ secrets.SENTRY_DSN }}"
    artifact-name: "OpenCI-dashboard-macos"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `platform` | Target platform (`web`, `ios`, `macos`) | Yes | - |
| `working-directory` | Flutter project directory | No | `.` |
| `build-args` | Additional arguments for `flutter build` | No | `""` |
| `firebase-service-account` | GCP service account JSON for Firebase deploy (web) | No | `""` |
| `preview` | Deploy to Firebase Hosting preview channel (web) | No | `"false"` |
| `certificate-private-key` | RSA private key PEM used to create/reuse signing certificates (ios, macos) | No | `""` |
| `asc-key-id` | App Store Connect API Key ID (ios, macos) | No | `""` |
| `asc-issuer-id` | App Store Connect API Issuer ID (ios, macos) | No | `""` |
| `asc-private-key` | ASC API Private Key content, .p8 PEM (ios, macos) | No | `""` |
| `scheme` | Xcode scheme name (ios) | No | `"Runner"` |
| `build-number` | Override the build number from pubspec.yaml (ios, macos) | No | `""` |
| `macos-app-path` | Path to the built `.app`, relative to `working-directory`; auto-detected when omitted (macos) | No | `""` |
| `macos-entitlements-path` | Path to the macOS entitlements plist, relative to `working-directory` (macos) | No | `macos/Runner/Release.entitlements` |
| `artifact-name` | Base name for the packaged artifact zip (macos) | No | `.app` name + `-macos` |
| `output-directory` | Directory for packaged artifacts, relative to `working-directory` (macos) | No | `build/openci-artifacts` |

## What it does

### Web (`platform: web`)

1. Builds the Flutter web app (`flutter build web`)
2. Finds `firebase.json` in the repository
3. Copies build output to the Firebase public directory
4. Installs `firebase-tools` if not available (auto-installs Node.js if needed)
5. Deploys to Firebase Hosting (live or preview channel)

### iOS (`platform: ios`)

1. Runs `flutter build ios --no-codesign` to compile the app
2. Handles code signing entirely via shell scripts (no external CLI dependencies):
   - **JWT**: Generates an ASC API token using `openssl`
   - **Certificate**: Creates a Distribution certificate via ASC API (CSR → certificate), or validates and reuses an existing one
   - **Provisioning Profile**: Creates an App Store provisioning profile via ASC API
   - **Keychain**: Sets up a temporary keychain and imports the certificate
   - **Xcode Config**: Modifies `project.pbxproj` for manual signing with `sed`
   - **Archive**: Builds with `xcodebuild archive`
   - **Export**: Exports IPA with `xcodebuild -exportArchive`
3. Uploads to TestFlight (if `upload-to-testflight` is `"true"`)
4. Cleans up temporary keychain and credentials

### macOS (`platform: macos`)

1. Creates or reuses a Developer ID Application certificate via App Store Connect
2. Imports the certificate into a temporary keychain
3. Runs `flutter build macos --release`
4. Signs the built `.app` with hardened runtime enabled
5. Packages the `.app` with `ditto`, submits it to Apple's notary service, and staples the ticket
6. Writes the final notarized zip to `output-directory` and exposes `artifact-path`

## License

MIT
