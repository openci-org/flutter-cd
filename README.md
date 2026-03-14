# Flutter CD

Build and deploy Flutter applications.

## Usage

```yaml
- uses: open-ci-io/flutter-cd@v1
  with:
    platform: "web"
    working-directory: "apps/dashboard"
    firebase-service-account: ${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `platform` | Target platform (web, android, ios, macos) | Yes | - |
| `working-directory` | Flutter project directory | No | `.` |
| `build-args` | Additional arguments for flutter build | No | `""` |
| `firebase-service-account` | GCP service account JSON for Firebase deploy | No | `""` |

## What it does

### Web (`platform: web`)

1. Builds the Flutter web app (`flutter build web`)
2. Finds `firebase.json` in the repository
3. Copies build output to the Firebase public directory
4. Installs `firebase-tools` if not available (auto-installs Node.js if needed)
5. Deploys to Firebase Hosting

## License

MIT
