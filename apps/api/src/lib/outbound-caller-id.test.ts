import assert from "node:assert/strict";
import test from "node:test";
import { isOwnerTestDestination, resolveOutboundCallerId } from "./outbound-caller-id.js";

const now = new Date("2026-11-20T12:00:00.000Z");
const base = {
  ownerPhone: "+79990000001",
  destinationPhone: "+79990000001",
  testCallerId: "+79952225212",
  now
};

test("uses the explicitly configured service number for the owner's test without rental", () => {
  assert.equal(resolveOutboundCallerId(base), "+79952225212");
  assert.equal(resolveOutboundCallerId({ ...base, destinationPhone: "8 (999) 000-00-01" }), "+79952225212");
});

test("prefers an active account-owned rental over the shared test number", () => {
  assert.equal(
    resolveOutboundCallerId({ ...base, reservedNumber: "+79952225213", numberRentExpiresAt: new Date(now.getTime() + 1) }),
    "+79952225213"
  );
});

test("never offers the service test number for an arbitrary destination", () => {
  assert.equal(resolveOutboundCallerId({ ...base, destinationPhone: "+79990000002" }), null);
  assert.equal(
    resolveOutboundCallerId({
      ...base,
      destinationPhone: "+79990000002",
      reservedNumber: "+79952225213",
      numberRentExpiresAt: new Date(now.getTime() + 1)
    }),
    "+79952225213"
  );
});

test("does not use an expired rental, including the exact expiration instant", () => {
  for (const expiresAt of [new Date(now.getTime() - 1), now]) {
    assert.equal(
      resolveOutboundCallerId({ ...base, destinationPhone: "+79990000002", reservedNumber: "+79952225213", numberRentExpiresAt: expiresAt }),
      null
    );
    assert.equal(
      resolveOutboundCallerId({ ...base, reservedNumber: "+79952225213", numberRentExpiresAt: expiresAt }),
      "+79952225212"
    );
  }
});

test("does not infer a test number when no explicit configuration is provided", () => {
  assert.equal(resolveOutboundCallerId({ ...base, testCallerId: undefined }), null);
  assert.equal(resolveOutboundCallerId({ ...base, reservedNumber: "+79952225213", testCallerId: undefined }), null);
});

test("requires valid Russian phones for the test owner, destination and service number", () => {
  assert.equal(isOwnerTestDestination("", ""), false);
  assert.equal(isOwnerTestDestination("+441234567890", "+441234567890"), false);
  assert.equal(resolveOutboundCallerId({ ...base, ownerPhone: "+441234567890", destinationPhone: "+441234567890" }), null);
  assert.equal(resolveOutboundCallerId({ ...base, testCallerId: "+441234567890" }), null);
  assert.equal(resolveOutboundCallerId({ ...base, destinationPhone: "+799900000011" }), null);
});
