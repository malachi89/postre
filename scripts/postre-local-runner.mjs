import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(repoRoot, "scripts");
const logPath = join(repoRoot, "postre-local-runner.log");
const serverLogPath = join(repoRoot, "postre-local-server.log");
const runnerPidPath = join(repoRoot, "postre-local-runner.pid");
const serverPidPath = join(repoRoot, "postre-local-server.pid");
const envPath = join(repoRoot, ".env");
const npmCommand = resolveNpmCommand();
const setupRetryMs = 30000;
const pollMs = 5000;
const restartDebounceMs = 1500;

let serverProcess = null;
let serverStopping = false;
let shuttingDown = false;
let setupRunning = false;
let pendingRefresh = null;
let refreshTimer = null;
let lastFingerprint = getFingerprint();
let gitRefWatcher = null;

mkdirSync(scriptsDir, { recursive: true });
const runnerLog = createWriteStream(logPath, { flags: "a" });
const serverLog = createWriteStream(serverLogPath, { flags: "a" });

main().catch((error) => {
  log(`Fatal runner error: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  if (!claimRunnerPid()) {
    return;
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => cleanupPidFile(runnerPidPath, process.pid));

  log("PostRE local runner starting.");
  log(`Repository: ${repoRoot}`);
  await stopStaleServerFromPidFile();
  await setupUntilSuccess({ install: true, prisma: true, db: true }, "initial setup");
  if (shuttingDown) {
    return;
  }

  startServer();
  installWatchers();
  setInterval(checkForPolledChanges, pollMs).unref();
}

function claimRunnerPid() {
  const existingPid = readPid(runnerPidPath);
  if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) {
    log(`Another PostRE local runner is already active with PID ${existingPid}.`);
    return false;
  }

  writeFileSync(runnerPidPath, `${process.pid}\n`, "utf8");
  return true;
}

async function setupUntilSuccess(flags, label) {
  while (!shuttingDown) {
    try {
      await runSetup(flags, label);
      return;
    } catch (error) {
      log(`${label} failed: ${formatError(error)}`);
      log(`Retrying in ${Math.round(setupRetryMs / 1000)} seconds.`);
      await delay(setupRetryMs);
    }
  }
}

async function runSetup(flags, label) {
  setupRunning = true;
  try {
    ensureEnvFile();
    log(`Running ${label}.`);

    if (flags.install) {
      await runCommand(npmCommand, ["install"]);
    }

    if (flags.install || flags.prisma || flags.db) {
      await runCommand(npmCommand, ["run", "prisma:generate"]);
    }

    if (flags.db) {
      await runCommand(npmCommand, ["run", "db:push"]);
      await runCommand(npmCommand, ["run", "db:seed"]);
    }

    log(`${label} complete.`);
  } finally {
    setupRunning = false;
  }
}

function ensureEnvFile() {
  const expectedLine = 'DATABASE_URL="file:./dev.db"';

  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${expectedLine}\n`, "utf8");
    log("Created .env with the local SQLite DATABASE_URL.");
    return;
  }

  const current = readFileSync(envPath, "utf8");
  if (!current.includes("DATABASE_URL=")) {
    const prefix = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
    writeFileSync(envPath, `${prefix}${expectedLine}\n`, "utf8");
    log("Added local SQLite DATABASE_URL to .env.");
  }
}

function startServer() {
  if (serverProcess || shuttingDown) {
    return;
  }

  serverStopping = false;
  log("Starting PostRE dev server on http://localhost:5500.");
  writeLogLine(serverLog, "server", "Starting npm run dev.");

  serverProcess = spawn(npmCommand, ["run", "dev"], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: getChildEnv(),
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  writeFileSync(serverPidPath, `${serverProcess.pid}\n`, "utf8");

  serverProcess.stdout?.on("data", (chunk) => {
    serverLog.write(chunk);
  });

  serverProcess.stderr?.on("data", (chunk) => {
    serverLog.write(chunk);
  });

  serverProcess.on("close", (code, signal) => {
    const pid = serverProcess?.pid;
    serverProcess = null;
    cleanupPidFile(serverPidPath, pid);
    log(`PostRE dev server exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`);

    if (!serverStopping && !shuttingDown) {
      scheduleRefresh("server-exit", { install: false, prisma: false, db: false });
    }
  });
}

async function stopServer() {
  if (!serverProcess) {
    await stopStaleServerFromPidFile();
    return;
  }

  serverStopping = true;
  const pid = serverProcess.pid;
  log(`Stopping PostRE dev server PID ${pid}.`);
  killTree(pid);
  await waitForProcessExit(serverProcess, 8000);
  serverProcess = null;
  cleanupPidFile(serverPidPath, pid);
}

async function stopStaleServerFromPidFile() {
  const pid = readPid(serverPidPath);
  if (!pid || !isProcessAlive(pid)) {
    cleanupPidFile(serverPidPath, pid);
    return;
  }

  log(`Stopping stale PostRE server PID ${pid}.`);
  killTree(pid);
  await waitForPidExit(pid, 8000);
  cleanupPidFile(serverPidPath, pid);
}

function scheduleRefresh(reason, flags = classifyReason(reason)) {
  if (shuttingDown) {
    return;
  }

  pendingRefresh = mergeRefresh(pendingRefresh, { reasons: [reason], flags });

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void runPendingRefresh();
  }, restartDebounceMs);
}

async function runPendingRefresh() {
  if (!pendingRefresh || setupRunning || shuttingDown) {
    if (pendingRefresh && !shuttingDown) {
      scheduleRefresh("setup-busy", pendingRefresh.flags);
    }
    return;
  }

  const refresh = pendingRefresh;
  pendingRefresh = null;
  const label = `refresh after ${Array.from(new Set(refresh.reasons)).join(", ")}`;

  log(`Preparing ${label}.`);
  await stopServer();
  await setupUntilSuccess(refresh.flags, label);

  if (!shuttingDown) {
    startServer();
  }
}

function classifyReason(reason) {
  if (reason === "package" || reason === "git" || reason === "setup-busy") {
    return { install: true, prisma: true, db: true };
  }

  if (reason === "schema") {
    return { install: false, prisma: true, db: true };
  }

  return { install: false, prisma: false, db: false };
}

function mergeRefresh(current, next) {
  if (!current) {
    return next;
  }

  return {
    reasons: [...current.reasons, ...next.reasons],
    flags: {
      install: current.flags.install || next.flags.install,
      prisma: current.flags.prisma || next.flags.prisma,
      db: current.flags.db || next.flags.db
    }
  };
}

function installWatchers() {
  watchFile(join(repoRoot, "package.json"), "package");
  watchFile(join(repoRoot, "package-lock.json"), "package");
  watchFile(join(repoRoot, "prisma", "schema.prisma"), "schema");
  watchFile(join(repoRoot, ".git", "HEAD"), "git", refreshGitRefWatcher);
  refreshGitRefWatcher();
  watchDirectory(join(repoRoot, "src"), "source", true);
}

function refreshGitRefWatcher() {
  gitRefWatcher?.close();
  gitRefWatcher = null;

  const refPath = getCurrentGitRefPath();
  if (refPath) {
    gitRefWatcher = watchFile(refPath, "git");
  }
}

function watchFile(path, reason, afterChange) {
  try {
    const watcher = watch(path, { persistent: false }, () => {
      if (afterChange) {
        afterChange();
      }
      scheduleRefresh(reason);
    });
    return watcher;
  } catch (error) {
    log(`Could not watch ${path}: ${formatError(error)}`);
    return null;
  }
}

function watchDirectory(path, reason, recursive) {
  try {
    watch(path, { recursive, persistent: false }, (_event, filename) => {
      if (filename && String(filename).includes("~")) {
        return;
      }
      scheduleRefresh(reason);
    });
  } catch (error) {
    log(`Could not watch ${path}: ${formatError(error)}`);
  }
}

function checkForPolledChanges() {
  const next = getFingerprint();
  const changed = [];

  for (const key of Object.keys(next)) {
    if (next[key] !== lastFingerprint[key]) {
      changed.push(key);
    }
  }

  lastFingerprint = next;

  if (changed.includes("git")) {
    refreshGitRefWatcher();
    scheduleRefresh("git");
  } else if (changed.includes("package")) {
    scheduleRefresh("package");
  } else if (changed.includes("schema")) {
    scheduleRefresh("schema");
  }
}

function getFingerprint() {
  return {
    git: getGitHeadValue(),
    package: `${fileSignature(join(repoRoot, "package.json"))}|${fileSignature(join(repoRoot, "package-lock.json"))}`,
    schema: fileSignature(join(repoRoot, "prisma", "schema.prisma"))
  };
}

function getGitHeadValue() {
  try {
    const head = readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) {
      return head;
    }

    const ref = head.slice(5).trim();
    const refPath = join(repoRoot, ".git", ...ref.split("/"));
    if (existsSync(refPath)) {
      return `${ref}:${readFileSync(refPath, "utf8").trim()}`;
    }

    return `${ref}:${readPackedRef(ref)}`;
  } catch {
    return "unknown";
  }
}

function getCurrentGitRefPath() {
  try {
    const head = readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) {
      return null;
    }

    const ref = head.slice(5).trim();
    const refPath = join(repoRoot, ".git", ...ref.split("/"));
    return existsSync(refPath) ? refPath : null;
  } catch {
    return null;
  }
}

function readPackedRef(ref) {
  try {
    const packedRefs = readFileSync(join(repoRoot, ".git", "packed-refs"), "utf8");
    const line = packedRefs.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
    return line ? line.split(" ")[0] : "missing";
  } catch {
    return "missing";
  }
}

function fileSignature(path) {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: getChildEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    log(`Running: ${command} ${args.join(" ")}`);

    child.stdout?.on("data", (chunk) => {
      runnerLog.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      runnerLog.write(chunk);
    });

    child.on("error", rejectCommand);
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand();
      } else {
        rejectCommand(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function resolveNpmCommand() {
  if (process.platform === "win32") {
    return "npm";
  }

  const npmBesideNode = join(dirname(process.execPath), "npm");
  return existsSync(npmBesideNode) ? npmBesideNode : "npm";
}

function getChildEnv() {
  const nodeDir = dirname(process.execPath);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const existingPath = process.env[pathKey] ?? "";
  const commonPath = process.platform === "win32" ? "" : ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  return {
    ...process.env,
    [pathKey]: `${nodeDir}${process.platform === "win32" ? ";" : ":"}${existingPath}${commonPath}`,
    PORT: "5500"
  };
}

function killTree(pid) {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        if (isProcessAlive(pid)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Process already exited.
          }
        }
      }, 5000).unref();
    }
  } catch (error) {
    log(`Could not stop process tree ${pid}: ${formatError(error)}`);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(path) {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function cleanupPidFile(path, expectedPid) {
  try {
    const currentPid = readPid(path);
    if (!expectedPid || currentPid === expectedPid) {
      unlinkSync(path);
    }
  } catch {
    // Nothing to clean up.
  }
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveWait) => {
    const timeout = setTimeout(resolveWait, timeoutMs);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveWait();
    });
  });
}

async function waitForPidExit(pid, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(250);
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`PostRE local runner shutting down after ${signal}.`);
  await stopServer();
  cleanupPidFile(runnerPidPath, process.pid);
  process.exit(0);
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function log(message) {
  writeLogLine(runnerLog, "runner", message);
}

function writeLogLine(stream, label, message) {
  const line = `[${new Date().toISOString()}] [${label}] ${message}\n`;
  stream.write(line);
  if (process.env.POSTRE_RUNNER_CONSOLE === "1") {
    console.log(line.trimEnd());
  }
}

function formatError(error) {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}
