import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const databaseUrl = "postgresql://test:test@127.0.0.1:1/prisma_config_test";

function runPrismaCheck(source: string): void {
  // Run outside this test process so dotenv and config caches cannot affect other tests.
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: databaseUrl,
    DOTENV_CONFIG_PATH: devNull,
    DOTENV_CONFIG_OVERRIDE: "false"
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const output = execFileSync(process.execPath, ["--input-type=commonjs", "--eval", `
    const assert = require("node:assert/strict");
    const { createRequire } = require("node:module");
    const { Socket } = require("node:net");
    const { resolve } = require("node:path");
    Socket.prototype.connect = () => { throw new Error("Network is forbidden in Prisma config tests"); };
    const apiRequire = createRequire(resolve(process.cwd(), "prisma.config.ts"));
    const prismaRequire = createRequire(apiRequire.resolve("prisma/config"));
    const configPath = prismaRequire.resolve("@prisma/config");
    const configRequire = createRequire(configPath);
    (async () => {
      ${source}
      console.log("prisma compatibility check passed");
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `], { cwd: apiRoot, env, encoding: "utf8", timeout: 15_000 });
  assert.match(output, /prisma compatibility check passed/);
}

test("Prisma loads the existing classic config with patched transitive dependencies without a database", () => {
  runPrismaCheck(`
    const { loadConfigFromFile } = prismaRequire("@prisma/config");
    const result = await loadConfigFromFile({
      configRoot: process.cwd(),
      configFile: "prisma.config.ts"
    });
    assert.equal(result.error, undefined);
    assert.equal(result.resolvedPath, resolve("prisma.config.ts"));
    assert.equal(result.config.loadedFromFile, result.resolvedPath);
    assert.equal(result.config.engine, "classic");
    assert.equal(result.config.schema, resolve("prisma/schema.prisma"));
    assert.equal(result.config.datasource.url, process.env.DATABASE_URL);
    assert.equal(result.config.migrations.seed, "tsx prisma/seed.ts");
  `);
});

test("Prisma's resolved deepmerge preserves config records and handles recursive graphs without stack exhaustion", () => {
  runPrismaCheck(`
    const { deepmerge } = configRequire("deepmerge-ts");
    const base = {
      engine: "classic",
      datasource: { url: process.env.DATABASE_URL },
      migrations: { seed: "tsx prisma/seed.ts" }
    };
    const overlay = {
      schema: "prisma/schema.prisma",
      migrations: { path: "prisma/migrations" }
    };
    assert.deepEqual(deepmerge(base, overlay), {
      ...base,
      schema: overlay.schema,
      migrations: { ...base.migrations, ...overlay.migrations }
    });
    assert.deepEqual(base.migrations, { seed: "tsx prisma/seed.ts" });

    const first = { label: "first" };
    first.self = first;
    const second = { label: "second" };
    second.self = second;
    const merged = deepmerge(first, second);
    assert.equal(merged.label, "second");
    assert.equal(merged.self, merged);
    assert.equal(first.self, first);
    assert.equal(second.self, second);
  `);
});
