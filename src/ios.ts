import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "./helpers";
import {
  generateAscJwt,
  preflightCheck,
  getOrCreateCertificate,
  createProvisioningProfile,
  type ProfileResult,
} from "./asc";

const KEYCHAIN_NAME = "openci-build.keychain";
const KEYCHAIN_PASSWORD = "openci_temp_password";

export async function buildAndSignIos(): Promise<void> {
  const workingDirectory = core.getInput("working-directory") || ".";
  const buildArgs = core.getInput("build-args") || "";
  const { bundleId, teamId: appleTeamId } = parsePbxproj(workingDirectory);
  const scheme = core.getInput("scheme") || "Runner";
  const certPrivateKey = core.getInput("certificate-private-key", { required: true }).replace(/\\n/g, "\n");
  const ascKeyId = core.getInput("asc-key-id", { required: true });
  const ascIssuerId = core.getInput("asc-issuer-id", { required: true });
  const ascPrivateKey = core.getInput("asc-private-key", { required: true }).replace(/\\n/g, "\n");
  const buildNumberInput = core.getInput("build-number") || "";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openci-ios-"));

  try {
    console.log("🚀 OpenCI iOS Sign & Build");
    console.log(`   Bundle ID: ${bundleId}`);
    console.log(`   Apple Team ID: ${appleTeamId}`);
    console.log(`   Scheme: ${scheme}`);
    console.log("");

    // ── Step 1: Generate ASC JWT ────────────────────────────
    core.startGroup("Step 1: Generating App Store Connect JWT");
    const ascKeyPath = path.join(tmpDir, "AuthKey.p8");
    fs.writeFileSync(ascKeyPath, ascPrivateKey);
    const jwt = await generateAscJwt(ascKeyId, ascIssuerId, ascKeyPath);
    console.log("  ✅ JWT generated");
    core.endGroup();

    // ── Step 2: Preflight check ─────────────────────────────
    core.startGroup("Step 2: Preflight version check");
    const parsed = parseVersion(workingDirectory);
    const version = parsed.version;
    const buildNumber = buildNumberInput || parsed.buildNumber;
    console.log(`   Version: ${version}+${buildNumber}`);
    await preflightCheck(jwt, bundleId, version, buildNumber);
    core.endGroup();

    // ── Step 3: Get or create distribution certificate ──────
    core.startGroup("Step 3: Setting up distribution certificate");
    const certKeyPath = path.join(tmpDir, "cert_key.pem");
    fs.writeFileSync(certKeyPath, certPrivateKey);
    const cert = await getOrCreateCertificate(jwt, certKeyPath, tmpDir);
    console.log(`  Certificate ID: ${cert.certificateId}`);
    core.endGroup();

    // ── Step 4: Create provisioning profile ─────────────────
    core.startGroup("Step 4: Creating provisioning profile");
    const profile = await createProvisioningProfile(jwt, cert.certificateId, bundleId, "IOS_APP_STORE");
    console.log(`  ✅ Profile created`);
    console.log(`     Name: ${profile.name}`);
    console.log(`     UUID: ${profile.uuid}`);
    core.endGroup();

    // ── Step 5: Setup keychain ──────────────────────────────
    core.startGroup("Step 5: Setting up temporary keychain");
    await setupKeychain();
    console.log("  ✅ Keychain created");
    core.endGroup();

    // ── Step 6: Import certificate ──────────────────────────
    core.startGroup("Step 6: Importing certificate");
    await importCertificate(cert.p12Base64, cert.password, tmpDir);
    console.log("  ✅ Certificate imported");
    core.endGroup();

    // ── Step 7: Install provisioning profile ────────────────
    core.startGroup("Step 7: Installing provisioning profile");
    await installProvisioningProfile(profile, bundleId);
    console.log(`  ✅ Profile installed (UUID: ${profile.uuid})`);
    core.endGroup();

    // ── Step 8: Edit xcodeproj ──────────────────────────────
    core.startGroup("Step 8: Configuring Xcode project for manual signing");
    editXcodeProject(workingDirectory, bundleId, appleTeamId, profile);
    console.log("  ✅ Xcode project updated for manual signing");
    core.endGroup();

    // ── Step 9: Generate ExportOptions.plist ────────────────
    core.startGroup("Step 9: Generating ExportOptions.plist");
    const exportOptionsPath = path.resolve(workingDirectory, "ExportOptions.plist");
    generateExportOptions(exportOptionsPath, appleTeamId, bundleId, profile.uuid);
    console.log("  ✅ ExportOptions.plist generated");
    core.endGroup();

    // ── Step 10: Flutter build IPA ──────────────────────────
    core.startGroup("Step 10: Building IPA");
    console.log("  ⏳ This may take several minutes...");
    const buildNumberArg = buildNumberInput ? `--build-number=${buildNumber}` : "";
    const privateKeysDir = path.join(os.homedir(), "private_keys");
    fs.mkdirSync(privateKeysDir, { recursive: true });
    const apiKeyDest = path.join(privateKeysDir, `AuthKey_${ascKeyId}.p8`);
    fs.copyFileSync(ascKeyPath, apiKeyDest);

    // Step 10a: Archive only (flutter build ipa may fail on export, that's OK)
    const archivePath = path.join(workingDirectory, "build", "ios", "archive", "Runner.xcarchive");
    try {
      await exec(
        `flutter build ipa --release --export-options-plist="${exportOptionsPath}" ${buildNumberArg} ${buildArgs}`.trim(),
        { cwd: workingDirectory }
      );
    } catch (_e) {
      // flutter build ipa may fail during export step, check if archive exists
      if (!fs.existsSync(archivePath)) {
        throw new Error("Xcode archive was not created. The build step failed.");
      }
      console.log("  ⚠️  flutter build ipa export failed, falling back to manual xcodebuild export");
    }

    // Step 10b: If IPA wasn't created, export manually with API key auth
    const ipaDir = path.join(workingDirectory, "build", "ios", "ipa");
    const ipaExists = fs.existsSync(ipaDir) && fs.readdirSync(ipaDir).filter(f => f.endsWith(".ipa")).length > 0;

    if (!ipaExists) {
      console.log("  🔄 Exporting archive with xcodebuild + API key auth...");
      fs.mkdirSync(ipaDir, { recursive: true });
      await exec(
        [
          `xcodebuild -exportArchive`,
          `-archivePath "${archivePath}"`,
          `-exportOptionsPlist "${exportOptionsPath}"`,
          `-exportPath "${ipaDir}"`,
          `-allowProvisioningUpdates`,
          `-authenticationKeyPath "${apiKeyDest}"`,
          `-authenticationKeyID "${ascKeyId}"`,
          `-authenticationKeyIssuerID "${ascIssuerId}"`,
        ].join(" "),
        { cwd: workingDirectory }
      );

      // Verify IPA was created after manual export
      if (fs.readdirSync(ipaDir).filter(f => f.endsWith(".ipa")).length === 0) {
        throw new Error("IPA file was not created even after manual xcodebuild export.");
      }
    }

    console.log("  ✅ IPA built and exported");
    core.endGroup();

    // ── Cleanup ─────────────────────────────────────────────
    core.startGroup("Cleanup");
    await cleanupKeychain();
    fs.rmSync(apiKeyDest, { force: true });
    console.log("  ✅ Temporary keychain and API key removed");
    core.endGroup();

    console.log("");
    console.log("🎉 iOS Sign & Build complete!");
    console.log(`   IPA: ${path.join(workingDirectory, "build", "ios", "ipa")}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════
// Keychain
// ══════════════════════════════════════════════════════════════

async function setupKeychain(): Promise<void> {
  await exec(`security delete-keychain "${KEYCHAIN_NAME}"`, { silent: true }).catch(() => {});
  await exec(`security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_NAME}"`);
  await exec(`security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_NAME}"`);
  await exec(`security set-keychain-settings -t 3600 -u "${KEYCHAIN_NAME}"`);
  await exec(`security list-keychains -d user -s "${KEYCHAIN_NAME}" login.keychain-db`);
}

async function importCertificate(
  p12Base64: string,
  password: string,
  tmpDir: string
): Promise<void> {
  const p12Path = path.join(tmpDir, "import.p12");
  fs.writeFileSync(p12Path, Buffer.from(p12Base64, "base64"));
  await exec(
    `security import "${p12Path}" -k "${KEYCHAIN_NAME}" -P "${password}" -T /usr/bin/codesign -T /usr/bin/security`
  );
  await exec(
    `security set-key-partition-list -S "apple-tool:,apple:,codesign:" -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN_NAME}"`
  );
  fs.rmSync(p12Path, { force: true });
}

async function cleanupKeychain(): Promise<void> {
  await exec("security default-keychain -s login.keychain-db", { silent: true }).catch(() => {});
  await exec("security list-keychains -d user -s login.keychain-db", { silent: true }).catch(() => {});
  await exec(`security delete-keychain "${KEYCHAIN_NAME}"`, { silent: true }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
// Provisioning Profile
// ══════════════════════════════════════════════════════════════

async function installProvisioningProfile(
  profile: ProfileResult,
  bundleId: string
): Promise<void> {
  const profileDir = path.join(
    os.homedir(),
    "Library/MobileDevice/Provisioning Profiles"
  );
  fs.mkdirSync(profileDir, { recursive: true });

  const files = fs.readdirSync(profileDir);
  for (const file of files) {
    if (!file.endsWith(".mobileprovision")) continue;
    const filePath = path.join(profileDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      if (content.includes("OpenCI") && content.includes(bundleId)) {
        console.log(`  🗑️  Removing old local profile: ${file}`);
        fs.rmSync(filePath, { force: true });
      }
    } catch {}
  }

  const destPath = path.join(profileDir, `${profile.uuid}.mobileprovision`);
  fs.writeFileSync(destPath, Buffer.from(profile.profileContent, "base64"));
}

// ══════════════════════════════════════════════════════════════
// Xcode Project
// ══════════════════════════════════════════════════════════════

function editXcodeProject(
  workingDirectory: string,
  bundleId: string,
  appleTeamId: string,
  profile: ProfileResult
): void {
  const pbxprojPath = path.join(
    workingDirectory,
    "ios/Runner.xcodeproj/project.pbxproj"
  );
  if (!fs.existsSync(pbxprojPath)) {
    throw new Error(`project.pbxproj not found at ${pbxprojPath}`);
  }

  let content = fs.readFileSync(pbxprojPath, "utf-8");

  content = content.replaceAll(
    "CODE_SIGN_STYLE = Automatic;",
    "CODE_SIGN_STYLE = Manual;"
  );
  content = content.replace(
    /DEVELOPMENT_TEAM = [^;]*;/g,
    `DEVELOPMENT_TEAM = ${appleTeamId};`
  );
  content = content
    .replaceAll(
      'CODE_SIGN_IDENTITY = "Apple Development";',
      'CODE_SIGN_IDENTITY = "Apple Distribution";'
    )
    .replaceAll(
      'CODE_SIGN_IDENTITY = "iPhone Developer";',
      'CODE_SIGN_IDENTITY = "Apple Distribution";'
    )
    .replaceAll(
      '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer";',
      '"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";'
    );

  content = content.replaceAll(
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};`,
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${profile.name}";\n\t\t\t\tPROVISIONING_PROFILE = "${profile.uuid}";`
  );

  fs.writeFileSync(pbxprojPath, content);
}

// ══════════════════════════════════════════════════════════════
// ExportOptions.plist
// ══════════════════════════════════════════════════════════════

function generateExportOptions(
  outputPath: string,
  teamId: string,
  bundleId: string,
  profileUuid: string,
): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>${teamId}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>provisioningProfiles</key>
    <dict>
        <key>${bundleId}</key>
        <string>${profileUuid}</string>
    </dict>
    <key>signingCertificate</key>
    <string>Apple Distribution</string>
    <key>destination</key>
    <string>upload</string>
    <key>stripSwiftSymbols</key>
    <true/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>`;
  fs.writeFileSync(outputPath, plist);
}

// ══════════════════════════════════════════════════════════════
// Xcode project parsing
// ══════════════════════════════════════════════════════════════

function parsePbxproj(workingDirectory: string): { bundleId: string; teamId: string } {
  const pbxprojPath = path.join(
    workingDirectory,
    "ios/Runner.xcodeproj/project.pbxproj"
  );
  if (!fs.existsSync(pbxprojPath)) {
    throw new Error("project.pbxproj not found. Is this a Flutter iOS project?");
  }

  const content = fs.readFileSync(pbxprojPath, "utf-8");

  const bundleMatches = content.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g);
  if (!bundleMatches || bundleMatches.length === 0) {
    throw new Error("PRODUCT_BUNDLE_IDENTIFIER not found in project.pbxproj");
  }
  const bundleIds = [...new Set(
    bundleMatches
      .map((m) => m.replace("PRODUCT_BUNDLE_IDENTIFIER = ", "").replace(";", "").trim())
      .filter((id) => !id.includes("$(") && !id.includes("Tests"))
  )];
  if (bundleIds.length === 0) {
    throw new Error("No valid PRODUCT_BUNDLE_IDENTIFIER found in project.pbxproj");
  }

  const teamMatches = content.match(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/g);
  if (!teamMatches || teamMatches.length === 0) {
    throw new Error(
      "DEVELOPMENT_TEAM not found in project.pbxproj. Open the project in Xcode and set your team first."
    );
  }
  const teamIds = [...new Set(
    teamMatches.map((m) => m.replace("DEVELOPMENT_TEAM = ", "").replace(";", "").trim())
  )];

  console.log(`  📦 Auto-detected bundle ID: ${bundleIds[0]}`);
  console.log(`  👥 Auto-detected team ID: ${teamIds[0]}`);

  return { bundleId: bundleIds[0], teamId: teamIds[0] };
}

// ══════════════════════════════════════════════════════════════
// Version parsing
// ══════════════════════════════════════════════════════════════

function parseVersion(workingDirectory: string): { version: string; buildNumber: string } {
  const pubspecPath = path.join(workingDirectory, "pubspec.yaml");
  if (!fs.existsSync(pubspecPath)) {
    throw new Error("pubspec.yaml not found");
  }

  const content = fs.readFileSync(pubspecPath, "utf-8");
  const match = content.match(/^version:\s*(\S+)/m);
  if (!match) {
    throw new Error("version not found in pubspec.yaml");
  }

  const raw = match[1];
  const [version, buildNumber] = raw.includes("+") ? raw.split("+") : [raw, "1"];
  return { version, buildNumber };
}
