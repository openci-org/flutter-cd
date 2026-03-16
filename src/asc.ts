import * as fs from "fs";
import { exec, execAndCapture } from "./helpers";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1";

// ══════════════════════════════════════════════════════════════
// ASC JWT
// ══════════════════════════════════════════════════════════════

export async function generateAscJwt(
  keyId: string,
  issuerId: string,
  privateKeyPath: string
): Promise<string> {
  const b64url = (s: string) =>
    Buffer.from(s).toString("base64url");

  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: issuerId,
      iat: now,
      exp: now + 1200,
      aud: "appstoreconnect-v1",
    })
  );

  const signInput = `${header}.${payload}`;
  const signature = await execAndCapture(
    `printf '%s' '${signInput}' | openssl dgst -sha256 -sign "${privateKeyPath}" -binary | openssl base64 -e -A | tr '+/' '-_' | tr -d '='`
  );

  return `${signInput}.${signature.trim()}`;
}

// ══════════════════════════════════════════════════════════════
// ASC API
// ══════════════════════════════════════════════════════════════

export async function ascApi(
  jwt: string,
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: object
): Promise<any> {
  const url = `${ASC_API_BASE}${endpoint}`;
  const args = [
    "curl",
    "-sf",
    "-X", method,
    "-H", `"Authorization: Bearer ${jwt}"`,
    "-H", '"Content-Type: application/json"',
  ];

  if (body) {
    const bodyJson = JSON.stringify(JSON.stringify(body));
    args.push("-d", bodyJson);
  }

  args.push(`"${url}"`);

  const output = await execAndCapture(args.join(" "));
  if (!output.trim()) return null;
  return JSON.parse(output);
}

// ══════════════════════════════════════════════════════════════
// Certificate - using persistent private key
// ══════════════════════════════════════════════════════════════

interface CertificateResult {
  certificateId: string;
  p12Base64: string;
  password: string;
}

/**
 * Try to find an existing valid DISTRIBUTION certificate.
 * If found, download and create a p12 with the provided private key.
 * If not found, create a new one using CSR from the provided key.
 */
export async function getOrCreateCertificate(
  jwt: string,
  certPrivateKeyPath: string,
  tmpDir: string
): Promise<CertificateResult> {
  const password = "openci";

  const existingCerts = await ascApi(
    jwt,
    "/certificates?filter[certificateType]=DISTRIBUTION"
  );
  const certs = existingCerts?.data ?? [];

  const validCerts = certs.filter((cert: any) => {
    const expDate = new Date(cert.attributes.expirationDate);
    return expDate > new Date();
  });

  if (validCerts.length > 0) {
    console.log(`  Found ${validCerts.length} valid certificate(s), trying to reuse...`);

    for (const cert of validCerts) {
      try {
        const p12 = await buildP12FromCert(
          cert.attributes.certificateContent,
          certPrivateKeyPath,
          tmpDir,
          password
        );
        console.log(`  ✅ Reusing existing certificate (ID: ${cert.id})`);
        return { certificateId: cert.id, p12Base64: p12, password };
      } catch {
        console.log(`  ⚠️  Certificate ${cert.id} doesn't match this private key, skipping`);
      }
    }

    console.log("  No matching certificate found, creating new...");
  } else {
    console.log("  No valid certificates found, creating new...");
  }

  return createNewCertificate(jwt, certPrivateKeyPath, tmpDir, password);
}

async function createNewCertificate(
  jwt: string,
  certPrivateKeyPath: string,
  tmpDir: string,
  password: string
): Promise<CertificateResult> {
  const csrPemPath = `${tmpDir}/csr.pem`;
  const csrDerPath = `${tmpDir}/csr.der`;

  await exec(
    `openssl req -new -key "${certPrivateKeyPath}" -out "${csrPemPath}" -subj "/CN=OpenCI Distribution/C=JP/O=OpenCI"`,
    { silent: true }
  );

  await exec(
    `openssl req -in "${csrPemPath}" -outform DER -out "${csrDerPath}"`,
    { silent: true }
  );
  const csrBase64 = (await execAndCapture(`base64 -i "${csrDerPath}"`)).replace(/\n/g, "");

  let certResponse: any;
  try {
    certResponse = await ascApi(jwt, "/certificates", "POST", {
      data: {
        type: "certificates",
        attributes: {
          certificateType: "DISTRIBUTION",
          csrContent: csrBase64,
        },
      },
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("409") || msg.includes("CONFLICT")) {
      console.log("  ⚠️  Certificate limit reached, deleting oldest...");
      const existing = await ascApi(
        jwt,
        "/certificates?filter[certificateType]=DISTRIBUTION"
      );
      const allCerts = existing?.data ?? [];
      if (allCerts.length > 0) {
        const oldest = allCerts[allCerts.length - 1];
        console.log(`  🗑️  Deleting: ${oldest.id}`);
        await ascApi(jwt, `/certificates/${oldest.id}`, "DELETE").catch(() => {});
        certResponse = await ascApi(jwt, "/certificates", "POST", {
          data: {
            type: "certificates",
            attributes: {
              certificateType: "DISTRIBUTION",
              csrContent: csrBase64,
            },
          },
        });
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const certId = certResponse.data.id as string;
  const certContent = certResponse.data.attributes.certificateContent as string;

  const p12 = await buildP12FromCert(certContent, certPrivateKeyPath, tmpDir, password);
  console.log(`  ✅ New certificate created (ID: ${certId})`);

  return { certificateId: certId, p12Base64: p12, password };
}

async function buildP12FromCert(
  certContentBase64: string,
  privateKeyPath: string,
  tmpDir: string,
  password: string
): Promise<string> {
  const certDerPath = `${tmpDir}/cert.der`;
  const certPemPath = `${tmpDir}/cert.pem`;
  const p12Path = `${tmpDir}/cert.p12`;

  fs.writeFileSync(certDerPath, Buffer.from(certContentBase64, "base64"));
  await exec(
    `openssl x509 -inform DER -in "${certDerPath}" -out "${certPemPath}"`,
    { silent: true }
  );

  // Verify the key matches the certificate
  const certModulus = await execAndCapture(
    `openssl x509 -noout -modulus -in "${certPemPath}"`,
  );
  const keyModulus = await execAndCapture(
    `openssl rsa -noout -modulus -in "${privateKeyPath}"`,
  );
  if (certModulus.trim() !== keyModulus.trim()) {
    // Cleanup temp files
    fs.rmSync(certDerPath, { force: true });
    fs.rmSync(certPemPath, { force: true });
    throw new Error("Certificate does not match the provided private key");
  }

  // Create .p12 (try without -legacy first for LibreSSL, then with -legacy for OpenSSL 3.x)
  try {
    await exec(
      `openssl pkcs12 -export -out "${p12Path}" -inkey "${privateKeyPath}" -in "${certPemPath}" -password "pass:${password}" -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1`,
      { silent: true }
    );
  } catch {
    await exec(
      `openssl pkcs12 -export -out "${p12Path}" -inkey "${privateKeyPath}" -in "${certPemPath}" -password "pass:${password}" -legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1`,
      { silent: true }
    );
  }

  const p12Base64 = (await execAndCapture(`base64 -i "${p12Path}"`)).replace(/\n/g, "");

  // Cleanup
  fs.rmSync(certDerPath, { force: true });
  fs.rmSync(certPemPath, { force: true });
  fs.rmSync(p12Path, { force: true });

  return p12Base64;
}

// ══════════════════════════════════════════════════════════════
// Provisioning Profile
// ══════════════════════════════════════════════════════════════

export interface ProfileResult {
  id: string;
  name: string;
  profileContent: string;
  uuid: string;
}

export async function createProvisioningProfile(
  jwt: string,
  certificateId: string,
  bundleIdentifier: string,
  profileType: string
): Promise<ProfileResult> {
  const bundleIdResponse = await ascApi(
    jwt,
    `/bundleIds?filter[identifier]=${bundleIdentifier}`
  );
  const bundleIds = bundleIdResponse?.data ?? [];
  if (bundleIds.length === 0) {
    throw new Error(
      `Bundle ID not found: ${bundleIdentifier}. Register it in Apple Developer Portal first.`
    );
  }
  const bundleIdResourceId = bundleIds[0].id as string;

  const allProfiles = await ascApi(jwt, "/profiles?limit=200");
  const profiles = allProfiles?.data ?? [];
  for (const profile of profiles) {
    const name = profile.attributes?.name ?? "";
    if (name.startsWith("OpenCI ") && name.includes(bundleIdentifier)) {
      console.log(`  🗑️  Deleting stale profile: ${name}`);
      await ascApi(jwt, `/profiles/${profile.id}`, "DELETE").catch(() => {});
    }
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .substring(0, 19);
  const label = profileType === "IOS_APP_STORE" ? "AppStore" : "AdHoc";
  const profileName = `OpenCI ${label} ${bundleIdentifier} ${timestamp}`;

  const response = await ascApi(jwt, "/profiles", "POST", {
    data: {
      type: "profiles",
      attributes: { name: profileName, profileType },
      relationships: {
        bundleId: {
          data: { type: "bundleIds", id: bundleIdResourceId },
        },
        certificates: {
          data: [{ type: "certificates", id: certificateId }],
        },
      },
    },
  });

  return {
    id: response.data.id,
    name: response.data.attributes.name,
    profileContent: response.data.attributes.profileContent,
    uuid: response.data.attributes.uuid,
  };
}
