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
// Certificate
// ══════════════════════════════════════════════════════════════

interface CertificateResult {
  certificateId: string;
  p12Base64: string;
  password: string;
}

export async function validateCertificate(
  jwt: string,
  certId: string
): Promise<boolean> {
  try {
    const response = await ascApi(jwt, `/certificates/${certId}`);
    const expDate = new Date(response.data.attributes.expirationDate);
    return expDate > new Date();
  } catch {
    return false;
  }
}

export async function createCertificateWithP12(
  jwt: string,
  tmpDir: string
): Promise<CertificateResult> {
  const keyPath = `${tmpDir}/key.pem`;
  const csrPemPath = `${tmpDir}/csr.pem`;
  const csrDerPath = `${tmpDir}/csr.der`;
  const certDerPath = `${tmpDir}/cert.der`;
  const certPemPath = `${tmpDir}/cert.pem`;
  const p12Path = `${tmpDir}/cert.p12`;
  const password = "openci";

  // Generate RSA key and CSR
  await exec(
    `openssl req -new -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPemPath}" -subj "/CN=OpenCI Distribution/C=JP/O=OpenCI"`,
    { silent: true }
  );

  // Convert CSR PEM → DER → Base64
  await exec(
    `openssl req -in "${csrPemPath}" -outform DER -out "${csrDerPath}"`,
    { silent: true }
  );
  const csrBase64 = (await execAndCapture(`base64 -i "${csrDerPath}"`)).replace(/\n/g, "");

  // Check existing certificate count & create
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
      const certs = existing?.data ?? [];
      if (certs.length > 0) {
        const oldest = certs[certs.length - 1];
        console.log(`  🗑️  Deleting: ${oldest.id}`);
        await ascApi(jwt, `/certificates/${oldest.id}`, "DELETE").catch(
          () => {}
        );
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

  // Write DER cert & convert to PEM
  const fs = require("fs");
  fs.writeFileSync(certDerPath, Buffer.from(certContent, "base64"));
  await exec(
    `openssl x509 -inform DER -in "${certDerPath}" -out "${certPemPath}"`,
    { silent: true }
  );

  // Create .p12 (try without -legacy first for LibreSSL, then with -legacy for OpenSSL 3.x)
  try {
    await exec(
      `openssl pkcs12 -export -out "${p12Path}" -inkey "${keyPath}" -in "${certPemPath}" -password "pass:${password}" -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1`,
      { silent: true }
    );
  } catch {
    await exec(
      `openssl pkcs12 -export -out "${p12Path}" -inkey "${keyPath}" -in "${certPemPath}" -password "pass:${password}" -legacy -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1`,
      { silent: true }
    );
  }

  const p12Base64 = (await execAndCapture(`base64 -i "${p12Path}"`)).replace(/\n/g, "");

  return { certificateId: certId, p12Base64, password };
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
  bundleIdentifier: string
): Promise<ProfileResult> {
  // Get Bundle ID resource
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

  // Delete stale OpenCI profiles
  const allProfiles = await ascApi(jwt, "/profiles?limit=200");
  const profiles = allProfiles?.data ?? [];
  for (const profile of profiles) {
    const name = profile.attributes?.name ?? "";
    if (name.startsWith("OpenCI ") && name.includes(bundleIdentifier)) {
      console.log(`  🗑️  Deleting stale profile: ${name}`);
      await ascApi(jwt, `/profiles/${profile.id}`, "DELETE").catch(() => {});
    }
  }

  // Create new profile
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .substring(0, 19);
  const profileName = `OpenCI AppStore ${bundleIdentifier} ${timestamp}`;

  const response = await ascApi(jwt, "/profiles", "POST", {
    data: {
      type: "profiles",
      attributes: { name: profileName, profileType: "IOS_APP_STORE" },
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
