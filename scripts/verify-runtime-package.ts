import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "@liushuangls/open-connector-runtime";
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "sider-open-connector-runtime-"));

try {
  const packOutput = await runAndCapture(
    "npm",
    ["pack", "--workspace", packageName, "--json", "--silent", "--pack-destination", temporaryRoot],
    rootDir,
  );
  const [pack] = JSON.parse(packOutput) as [PackResult];
  assertPackContents(pack);

  const consumerDir = join(temporaryRoot, "consumer");
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "runtime-package-smoke-test", private: true, type: "module" }, null, 2)}\n`,
  );

  const tarballPath = join(temporaryRoot, pack.filename);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], consumerDir);

  const smokeTestOutput = await runAndCapture(
    process.execPath,
    ["--input-type=module", "--eval", smokeTestProgram()],
    consumerDir,
  );
  process.stdout.write(
    `Verified ${packageName}: ${pack.files.length} files, ${formatBytes(pack.size)} packed. ${smokeTestOutput.trim()}\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

interface PackFile {
  path: string;
  size: number;
}

interface PackResult {
  filename: string;
  files: PackFile[];
  size: number;
  unpackedSize: number;
}

function assertPackContents(pack: PackResult): void {
  const paths = new Set(pack.files.map((file) => file.path));
  const requiredPaths = [
    "LICENSE.txt",
    "NOTICE.md",
    "dist/catalog-store.js",
    "dist/catalog-store.d.ts",
    "dist/oauth/oauth-authorization-service.js",
    "dist/oauth/oauth-authorization-service.d.ts",
    "dist/providers/registry.generated.js",
    "migrations/postgresql/0010_runtime.sql",
  ];
  const missingPaths = requiredPaths.filter((path) => !paths.has(path));
  if (missingPaths.length > 0) {
    throw new Error(`Runtime package is missing required files: ${missingPaths.join(", ")}.`);
  }

  const forbiddenPaths = [...paths].filter(
    (path) =>
      path.startsWith("src/") ||
      path.startsWith("scripts/") ||
      path.startsWith("data/") ||
      path === ".env" ||
      path.startsWith(".env.") ||
      (path.endsWith(".ts") && !path.endsWith(".d.ts")),
  );
  if (forbiddenPaths.length > 0) {
    throw new Error(`Runtime package contains forbidden files: ${forbiddenPaths.slice(0, 10).join(", ")}.`);
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve();
        return;
      }

      reject(new Error(`${command} failed (${signal ?? `exit ${exitCode ?? 1}`}).`));
    });
  });
}

function runAndCapture(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve(Buffer.concat(stdout).toString());
        return;
      }

      const details = Buffer.concat(stderr).toString().trim();
      reject(new Error(`${command} failed (${signal ?? `exit ${exitCode ?? 1}`}).${details ? ` ${details}` : ""}`));
    });
  });
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function smokeTestProgram(): string {
  return String.raw`
import { loadCatalog } from "@liushuangls/open-connector-runtime/catalog-store";
import { ConnectionService } from "@liushuangls/open-connector-runtime/connection-service";
import { OAuthAuthorizationService } from "@liushuangls/open-connector-runtime/oauth/oauth-authorization-service";
import { ProviderLoader } from "@liushuangls/open-connector-runtime/providers/provider-loader";
import { executorModules } from "@liushuangls/open-connector-runtime/providers/registry";
import { ActionRunner } from "@liushuangls/open-connector-runtime/server/actions/action-runner";

const catalog = await loadCatalog(undefined, { executableServices: ["quickchart"] });
if (typeof OAuthAuthorizationService !== "function") {
  throw new Error("Packaged host-managed OAuth primitive is unavailable.");
}
const providerLoader = new ProviderLoader(executorModules);
const connectionStore = {
  async get() { return undefined; },
  async set() { throw new Error("not used"); },
  async updateCredential() { return false; },
  async delete() {},
  async list() { return []; },
};
const runLogStore = {
  async add() { return { retentionApplied: true }; },
  async get() { return undefined; },
  async list() { return { items: [] }; },
};
const connections = new ConnectionService({ catalog, providerLoader, store: connectionStore });
const runner = new ActionRunner({ catalog, providerLoader, connections, runs: runLogStore });
const result = await runner.run({
  actionId: "quickchart.build_qr_url",
  caller: "http",
  input: { text: "sider-runtime-smoke-test" },
});

if (!result?.result.ok || !result.result.output?.url?.startsWith("https://quickchart.io/qr?")) {
  throw new Error("Packaged no-auth Action execution failed.");
}

process.stdout.write("Catalog import and lazy no-auth Action execution passed.");
`;
}
