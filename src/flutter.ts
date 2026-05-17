import * as core from "@actions/core";
import { exec } from "./helpers";

export type SwiftPackageManagerMode = "inherit" | "enabled" | "disabled";

export function parseSwiftPackageManagerMode(value: string): SwiftPackageManagerMode {
  const normalized = value.trim().toLowerCase();

  if (normalized === "" || normalized === "inherit" || normalized === "auto") {
    return "inherit";
  }
  if (normalized === "enabled" || normalized === "enable" || normalized === "true") {
    return "enabled";
  }
  if (normalized === "disabled" || normalized === "disable" || normalized === "false") {
    return "disabled";
  }

  throw new Error(
    `Unsupported swift-package-manager: ${value}. Use "inherit", "enabled", or "disabled".`
  );
}

export async function configureSwiftPackageManager(
  mode: SwiftPackageManagerMode,
  workingDirectory: string
): Promise<boolean> {
  if (mode === "inherit") {
    console.log("  Swift Package Manager: inherit current Flutter setting");
    return false;
  }

  const configCommand =
    mode === "enabled"
      ? "flutter config --enable-swift-package-manager"
      : "flutter config --no-enable-swift-package-manager";

  console.log(`  Swift Package Manager: ${mode}`);
  await exec(configCommand);
  await exec("flutter pub get", { cwd: workingDirectory });
  return true;
}

export function buildNoPubArg(pubGetAlreadyRan: boolean, buildArgs: string): string {
  if (!pubGetAlreadyRan || buildArgs.includes("--no-pub")) {
    return "";
  }
  return "--no-pub";
}
