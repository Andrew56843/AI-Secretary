import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { env } from "../config.js";
import { parseRublesToKopecks, verifyCloudPaymentsHmac } from "./cloudpayments.js";

test("parses payment amounts without floating point rounding", () => {
  assert.equal(parseRublesToKopecks("100"), 10_000);
  assert.equal(parseRublesToKopecks("100.05"), 10_005);
  assert.equal(parseRublesToKopecks("100,5"), 10_050);
  assert.equal(parseRublesToKopecks("100.005"), null);
  assert.equal(parseRublesToKopecks("not-money"), null);
});

test("accepts an authentic CloudPayments raw-body signature", () => {
  const secret = "cloudpayments-test-secret";
  const previousSecret = env.CLOUDPAYMENTS_API_SECRET;
  env.CLOUDPAYMENTS_API_SECRET = secret;
  const rawBody = Buffer.from("InvoiceId=order-1&Amount=100.00&Currency=RUB");
  const signature = createHmac("sha256", secret).update(rawBody).digest("base64");

  assert.equal(verifyCloudPaymentsHmac({ rawBody, contentHmac: signature }), true);
  assert.equal(verifyCloudPaymentsHmac({ rawBody, contentHmac: "invalid" }), false);
  env.CLOUDPAYMENTS_API_SECRET = previousSecret;
});
