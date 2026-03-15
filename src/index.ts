import * as core from "@actions/core";
import { deployWeb } from "./web";
import { buildAndSignIos } from "./ios";

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
