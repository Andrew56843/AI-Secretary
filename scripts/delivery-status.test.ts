import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

test("delivery badges distinguish pending, sending and unconfirmed results", () => {
  const source = fs.readFileSync(new URL("../apps/web/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  const from = source.indexOf("function formatDeliveryStatus(");
  const to = source.indexOf("function formatRubles(", from);
  assert.ok(from > 0 && to > from);
  const compiled = ts.transpileModule(source.slice(from, to), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const { formatDeliveryStatus: format, selectTelegramDelivery: select } = new Function(
    `${compiled}; return { formatDeliveryStatus, selectTelegramDelivery };`
  )() as {
    formatDeliveryStatus: (status: string) => string;
    selectTelegramDelivery: (deliveries?: Array<{ channel: string; status: string }>) => { status: string } | undefined;
  };
  assert.equal(format("SENDING"), "отправляется");
  assert.equal(format("UNKNOWN"), "не подтверждено");
  assert.notEqual(format("UNKNOWN"), format("FAILED"));
  assert.notEqual(format("SENDING"), format("PENDING"));
  assert.equal(format("SENT"), "отправлено");
  assert.equal(select()?.status, undefined);
  assert.equal(select([
    { channel: "TELEGRAM", status: "PENDING" },
    { channel: "TELEGRAM", status: "SENT" }
  ])?.status, "SENT");
  assert.equal(select([
    { channel: "TELEGRAM", status: "PENDING" },
    { channel: "TELEGRAM", status: "UNKNOWN" }
  ])?.status, "UNKNOWN");
});
