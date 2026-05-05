import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateAscJwt, getOrCreateCertificate } from "./asc";
import { exec, execAndCapture } from "./helpers";

const KEYCHAIN_NAME = "openci-macos-build.keychain";
const KEYCHAIN_PASSWORD = "openci_temp_password";

export async function buildSignAndNotarizeMacos(): Promise<void> {
  const workingDirectory = core.getInput("working-directory") || ".";
  const buildArgs = core.getInput("build-args") || "";
  const certPrivateKey = core.getInput("certificate-private-key", { required: true }).replace(/\\n/g, "\n");
  const ascKeyId = core.getInput("asc-key-id", { required: true });
  const ascIssuerId = core.getInput("asc-issuer-id", { required: true });
  const ascPrivateKey = core.getInput("asc-private-key", { required: true }).replace(/\\n/g, "\n");
  const entitlementsPath = core.getInput("macos-entitlements-path") || "macos/Runner/Release.entitlements";
  const appPathInput = core.getInput("macos-app-path") || "";
  const artifactNameInput = core.getInput("artifact-name") || "";
  const outputDirectory = core.getInput("output-directory") || "build/openci-artifacts";
  const buildNumberInput = core.getInput("build-number") || "";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openci-macos-"));
  const apiKeyDest = path.join(os.homedir(), "private_keys", `AuthKey_${ascKeyId}.p8`);

  try {
    console.log("OpenCI macOS Build, Sign & Notarize");
    console.log(`   Working directory: ${workingDirectory}`);
    console.log("");

    core.startGroup("Step 1: Generating App Store Connect JWT");
    const ascKeyPath = path.join(tmpDir, "AuthKey.p8");
    fs.writeFileSync(ascKeyPath, ascPrivateKey);
    const jwt = generateAscJwt(ascKeyId, ascIssuerId, ascKeyPath);
    console.log("  JWT generated");
    core.endGroup();

    core.startGroup("Step 2: Setting up Developer ID Application certificate");
    const certKeyPath = path.join(tmpDir, "cert_key.pem");
    fs.writeFileSync(certKeyPath, certPrivateKey);
    const cert = await getOrCreateCertificate(jwt, certKeyPath, tmpDir, "DEVELOPER_ID_APPLICATION");
    console.log(`  Certificate ID: ${cert.certificateId}`);
    core.endGroup();

    core.startGroup("Step 3: Setting up temporary keychain");
    await setupKeychain();
    await importCertificate(cert.p12Base64, cert.password, tmpDir);
    const signingIdentity = await findDeveloperIdIdentity();
    console.log(`  Signing identity: ${signingIdentity}`);
    core.endGroup();

    core.startGroup("Step 4: Building macOS app");
    const buildNumberArg = buildNumberInput ? `--build-number=${shellQuote(buildNumberInput)}` : "";
    await exec(`flutter build macos --release ${buildNumberArg} ${buildArgs}`.trim(), { cwd: workingDirectory });
    const appPath = appPathInput
      ? path.resolve(workingDirectory, appPathInput)
      : path.resolve(findBuiltAppPath(workingDirectory));
    console.log(`  App built: ${appPath}`);
    core.endGroup();

    core.startGroup("Step 5: Code signing app");
    const resolvedEntitlementsPath = path.resolve(workingDirectory, entitlementsPath);
    await signApp(appPath, signingIdentity, resolvedEntitlementsPath);
    await exec(`codesign --verify --deep --strict --verbose=2 ${shellQuote(appPath)}`);
    console.log("  App signed and verified");
    core.endGroup();

    core.startGroup("Step 6: Notarizing app");
    fs.mkdirSync(path.dirname(apiKeyDest), { recursive: true });
    fs.copyFileSync(ascKeyPath, apiKeyDest);
    const appName = path.basename(appPath, ".app");
    const artifactBaseName = sanitizeArtifactName(artifactNameInput || `${appName}-macos`);
    const notarizationZipPath = path.join(tmpDir, `${artifactBaseName}-notary.zip`);
    await createZip(appPath, notarizationZipPath);
    await exec(
      [
        "xcrun notarytool submit",
        shellQuote(notarizationZipPath),
        "--key",
        shellQuote(apiKeyDest),
        "--key-id",
        shellQuote(ascKeyId),
        "--issuer",
        shellQuote(ascIssuerId),
        "--wait",
      ].join(" ")
    );
    await exec(`xcrun stapler staple ${shellQuote(appPath)}`);
    await exec(`spctl --assess --type execute --verbose ${shellQuote(appPath)}`);
    console.log("  App notarized and stapled");
    core.endGroup();

    core.startGroup("Step 7: Packaging artifact");
    const outputDir = path.resolve(workingDirectory, outputDirectory);
    fs.mkdirSync(outputDir, { recursive: true });
    const finalZipPath = path.join(outputDir, `${artifactBaseName}.zip`);
    await createZip(appPath, finalZipPath);
    core.setOutput("artifact-path", finalZipPath);
    console.log(`  Artifact: ${finalZipPath}`);
    core.endGroup();

    core.startGroup("Cleanup");
    await cleanupKeychain();
    fs.rmSync(apiKeyDest, { force: true });
    console.log("  Temporary keychain and API key removed");
    core.endGroup();

    console.log("");
    console.log("macOS Build, Sign & Notarize complete!");
    console.log(`   Artifact: ${finalZipPath}`);
  } finally {
    await cleanupKeychain();
    fs.rmSync(apiKeyDest, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function setupKeychain(): Promise<void> {
  await exec(`security delete-keychain ${shellQuote(KEYCHAIN_NAME)}`, { silent: true }).catch(() => {});
  await exec(`security create-keychain -p ${shellQuote(KEYCHAIN_PASSWORD)} ${shellQuote(KEYCHAIN_NAME)}`);
  await exec(`security unlock-keychain -p ${shellQuote(KEYCHAIN_PASSWORD)} ${shellQuote(KEYCHAIN_NAME)}`);
  await exec(`security set-keychain-settings -t 3600 -u ${shellQuote(KEYCHAIN_NAME)}`);
  await exec(`security list-keychains -d user -s ${shellQuote(KEYCHAIN_NAME)} login.keychain-db`);
}

async function importCertificate(
  p12Base64: string,
  password: string,
  tmpDir: string
): Promise<void> {
  const p12Path = path.join(tmpDir, "developer-id.p12");
  fs.writeFileSync(p12Path, Buffer.from(p12Base64, "base64"));
  await exec(
    `security import ${shellQuote(p12Path)} -k ${shellQuote(KEYCHAIN_NAME)} -P ${shellQuote(password)} -T /usr/bin/codesign -T /usr/bin/security`
  );
  await exec(
    `security set-key-partition-list -S "apple-tool:,apple:,codesign:" -k ${shellQuote(KEYCHAIN_PASSWORD)} ${shellQuote(KEYCHAIN_NAME)}`
  );
  fs.rmSync(p12Path, { force: true });
}

async function cleanupKeychain(): Promise<void> {
  await exec("security default-keychain -s login.keychain-db", { silent: true }).catch(() => {});
  await exec("security list-keychains -d user -s login.keychain-db", { silent: true }).catch(() => {});
  await exec(`security delete-keychain ${shellQuote(KEYCHAIN_NAME)}`, { silent: true }).catch(() => {});
}

async function findDeveloperIdIdentity(): Promise<string> {
  const output = await execAndCapture(`security find-identity -v -p codesigning ${shellQuote(KEYCHAIN_NAME)}`);
  const match = output.match(/"([^"]*Developer ID Application[^"]*)"/);
  if (!match?.[1]) {
    throw new Error(`Developer ID Application signing identity not found in ${KEYCHAIN_NAME}`);
  }
  return match[1];
}

function findBuiltAppPath(workingDirectory: string): string {
  const releaseDir = path.join(workingDirectory, "build", "macos", "Build", "Products", "Release");
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`macOS release build directory not found: ${releaseDir}`);
  }
  const apps = fs
    .readdirSync(releaseDir)
    .filter((entry) => entry.endsWith(".app"))
    .sort();
  if (apps.length === 0) {
    throw new Error(`No .app bundle found in ${releaseDir}`);
  }
  return path.join(releaseDir, apps[0]);
}

async function signApp(
  appPath: string,
  signingIdentity: string,
  entitlementsPath: string
): Promise<void> {
  if (!fs.existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${appPath}`);
  }
  if (!fs.existsSync(entitlementsPath)) {
    throw new Error(`macOS entitlements file not found: ${entitlementsPath}`);
  }
  await exec(
    [
      "codesign",
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      shellQuote(entitlementsPath),
      "--sign",
      shellQuote(signingIdentity),
      shellQuote(appPath),
    ].join(" ")
  );
}

async function createZip(appPath: string, zipPath: string): Promise<void> {
  fs.rmSync(zipPath, { force: true });
  await exec(
    `ditto -c -k --keepParent ${shellQuote(appPath)} ${shellQuote(zipPath)}`
  );
}

function sanitizeArtifactName(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "macos-app";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
