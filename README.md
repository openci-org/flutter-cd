# Flutter CD

Build and deploy Flutter applications.

Zero external dependencies — uses only standard macOS tools (`openssl`, `curl`, `security`, `xcodebuild`, `python3`).

## Usage

### Web — Production Deploy

```yaml
- uses: open-ci-io/flutter-cd@v1
  with:
    platform: "web"
    working-directory: "apps/dashboard"
    firebase-service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
```

### Web — Preview Deploy (for PRs)

```yaml
- uses: open-ci-io/flutter-cd@v1
  with:
    platform: "web"
    working-directory: "apps/dashboard"
    firebase-service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
    preview: "true"
```

### iOS — Build & Upload to TestFlight

```yaml
- uses: open-ci-io/flutter-cd@v1
  with:
    platform: "ios"
    working-directory: "apps/dashboard"
    bundle-id: "org.openci.dashboard.prod"
    apple-team-id: "XXXXXXXXXX"
    asc-key-id: ${{ secrets.ASC_KEY_ID }}
    asc-issuer-id: ${{ secrets.ASC_ISSUER_ID }}
    asc-private-key: ${{ secrets.ASC_PRIVATE_KEY }}
```

### iOS — Reuse Existing Certificate

On the first run, a distribution certificate is created automatically. To reuse it on subsequent runs, pass the cached certificate:

```yaml
- uses: open-ci-io/flutter-cd@v1
  with:
    platform: "ios"
    working-directory: "apps/dashboard"
    bundle-id: "org.openci.dashboard.prod"
    apple-team-id: "XXXXXXXXXX"
    asc-key-id: ${{ secrets.ASC_KEY_ID }}
    asc-issuer-id: ${{ secrets.ASC_ISSUER_ID }}
    asc-private-key: ${{ secrets.ASC_PRIVATE_KEY }}
    distribution-certificate-p12: ${{ secrets.OPENCI_DISTRIBUTION_CERTIFICATE_P12 }}
    distribution-certificate-id: ${{ secrets.OPENCI_DISTRIBUTION_CERTIFICATE_ID }}
    distribution-certificate-password: ${{ secrets.OPENCI_DISTRIBUTION_CERTIFICATE_PASSWORD }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `platform` | Target platform (`web`, `ios`) | Yes | - |
| `working-directory` | Flutter project directory | No | `.` |
| `build-args` | Additional arguments for `flutter build` | No | `""` |
| `firebase-service-account` | GCP service account JSON for Firebase deploy (web) | No | `""` |
| `preview` | Deploy to Firebase Hosting preview channel (web) | No | `"false"` |
| `asc-key-id` | App Store Connect API Key ID (ios) | No | `""` |
| `asc-issuer-id` | App Store Connect API Issuer ID (ios) | No | `""` |
| `asc-private-key` | ASC API Private Key content, .p8 PEM (ios) | No | `""` |
| `bundle-id` | iOS Bundle Identifier (ios) | No | `""` |
| `apple-team-id` | Apple Developer Team ID (ios) | No | `""` |
| `scheme` | Xcode scheme name (ios) | No | `"Runner"` |
| `upload-to-testflight` | Upload IPA to TestFlight after export (ios) | No | `"true"` |
| `distribution-certificate-p12` | Base64-encoded .p12 certificate for reuse (ios) | No | `""` |
| `distribution-certificate-id` | ASC certificate ID for reuse (ios) | No | `""` |
| `distribution-certificate-password` | P12 password (ios) | No | `"openci"` |

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

## License

MIT
