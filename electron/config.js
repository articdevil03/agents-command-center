import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const smokeReadyFile = process.env.CC_SMOKE_READY_FILE;
export const smokeStopFile = process.env.CC_SMOKE_STOP_FILE;
