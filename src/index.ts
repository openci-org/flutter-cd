import * as core from "@actions/core";
import { deployWeb } from "./web";
import { buildAndSignIos } from "./ios";
import { buildSignAndNotarizeMacos } from "./macos";

async function run(): Promise<void> {
  try {
    const platform = core.getInput("platform", { required: true });

    switch (platform) {
      case "web":
        await deployWeb();
        break;
      case "ios":
        await buildAndSignIos();
        break;
      case "macos":
        await buildSignAndNotarizeMacos();
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
