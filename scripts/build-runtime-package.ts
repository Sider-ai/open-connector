import { spawn } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const packageDir = join(rootDir, "packages/open-connector-runtime");
const outputDir = join(packageDir, "dist");
const tscBin = join(rootDir, "node_modules/typescript/bin/tsc");

await rm(outputDir, { force: true, recursive: true });
await runTypeScriptCompiler();
await copyRuntimeAssets();

async function runTypeScriptCompiler(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tscBin, "-p", "tsconfig.runtime-package.json", "--pretty", "false"], {
      cwd: rootDir,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        resolve();
        return;
      }

      reject(new Error(`Runtime package TypeScript build failed (${signal ?? `exit ${exitCode ?? 1}`}).`));
    });
  });
}

async function copyRuntimeAssets(): Promise<void> {
  const assets = [
    [join(rootDir, "catalog/apps"), join(packageDir, "catalog/apps")],
    [join(rootDir, "migrations"), join(packageDir, "migrations")],
    [join(rootDir, "LICENSE.txt"), join(packageDir, "LICENSE.txt")],
    [join(rootDir, "NOTICE.md"), join(packageDir, "NOTICE.md")],
  ] as const;

  await Promise.all(
    assets.map(async ([source, destination]) => {
      await rm(destination, { force: true, recursive: true });
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    }),
  );
}
