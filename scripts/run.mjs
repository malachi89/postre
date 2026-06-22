#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
const action = process.argv[2] || "start";
const validActions = ["install", "start", "stop", "uninstall"];

if (!validActions.includes(action)) {
  console.error(`Usage: node scripts/run.mjs [${validActions.join("|")}]`);
  console.error(`  install   - Install as a background service (LaunchAgent / Scheduled Task)`);
  console.error(`  start     - Start the runner (default)`);
  console.error(`  stop      - Stop the runner`);
  console.error(`  uninstall - Remove the background service`);
  process.exit(1);
}

if (platform === "darwin") {
  const script = join(scriptsDir, `${action}-macos.sh`);
  if (!existsSync(script)) {
    console.error(`Script not found: ${script}`);
    process.exit(1);
  }
  execFileSync("bash", [script], { stdio: "inherit" });
} else if (platform === "win32") {
  const script = join(scriptsDir, `${action}-windows.ps1`);
  if (!existsSync(script)) {
    console.error(`Script not found: ${script}`);
    process.exit(1);
  }
  execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" });
} else {
  console.error(`Unsupported platform: ${platform}`);
  console.error("PostRE Local supports macOS and Windows.");
  process.exit(1);
}
