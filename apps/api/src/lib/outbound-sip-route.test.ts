import assert from "node:assert/strict";
import test from "node:test";
import { resolveOutboundSipRoute, safeSipLineRoute, type SipLineRouteSource } from "./outbound-sip-route.js";

const now = new Date("2026-11-21T12:00:00.000Z");
const revisionDate = new Date("2026-11-21T11:00:00.000Z");
const rentalExpiresAt = new Date("2026-12-21T12:00:00.000Z");

function line(number: string): SipLineRouteSource {
  return {
    enabled: true,
    asteriskEndpoint: `callsec-sip-${number.slice(1)}`,
    server: "sip.novofon.ru",
    port: 5061,
    transport: "tls",
    updatedAt: revisionDate
  };
}

const ownedNumber = { number: "+79952225213", assigned: true, sipLine: line("+79952225213") };
const testNumber = { number: "+79952225212", assigned: false, sipLine: line("+79952225212") };
const input = {
  ownerPhone: "+79990000001",
  destinationPhone: "+79990000002",
  reservedNumber: ownedNumber,
  numberRentExpiresAt: rentalExpiresAt,
  testCallerId: testNumber.number,
  testNumber,
  now
};

test("ordinary outbound calls select the tenant rental's dedicated SIP endpoint", () => {
  const result = resolveOutboundSipRoute(input);
  assert.equal(result?.callerId, ownedNumber.number);
  assert.equal(result?.sipLine.endpoint, "callsec-sip-79952225213");
  assert.equal(result?.sipLine.number, ownedNumber.number);
  assert.equal(result?.sipLine.revision, revisionDate.toISOString());
});

test("an active owned rental has priority for owner tests, independent of inbound scenario state", () => {
  const result = resolveOutboundSipRoute({ ...input, destinationPhone: input.ownerPhone });
  assert.equal(result?.callerId, ownedNumber.number);
  assert.equal(result?.sipLine.endpoint, ownedNumber.sipLine.asteriskEndpoint);
});

test("missing or disabled tenant SIP lines fail closed instead of using the test endpoint", () => {
  for (const sipLine of [null, { ...ownedNumber.sipLine, enabled: false }]) {
    assert.equal(resolveOutboundSipRoute({ ...input, reservedNumber: { ...ownedNumber, sipLine } }), null);
    assert.equal(resolveOutboundSipRoute({ ...input, destinationPhone: input.ownerPhone, reservedNumber: { ...ownedNumber, sipLine } }), null);
  }
});

test("unassigned or expired rentals cannot authorize calls to arbitrary customers", () => {
  assert.equal(resolveOutboundSipRoute({ ...input, reservedNumber: { ...ownedNumber, assigned: false } }), null);
  assert.equal(resolveOutboundSipRoute({ ...input, numberRentExpiresAt: now }), null);
  assert.equal(resolveOutboundSipRoute({ ...input, numberRentExpiresAt: null }), null);
});

test("owner-only tests resolve the configured service number through its own dedicated SIP line", () => {
  const result = resolveOutboundSipRoute({ ...input, reservedNumber: null, destinationPhone: input.ownerPhone });
  assert.equal(result?.callerId, testNumber.number);
  assert.equal(result?.sipLine.endpoint, testNumber.sipLine.asteriskEndpoint);
  assert.equal(resolveOutboundSipRoute({ ...input, reservedNumber: null }), null);
  assert.equal(resolveOutboundSipRoute({ ...input, reservedNumber: null, destinationPhone: input.ownerPhone, testNumber: null }), null);
});

test("the service endpoint cannot be substituted with another number's line", () => {
  assert.equal(resolveOutboundSipRoute({
    ...input,
    reservedNumber: null,
    destinationPhone: input.ownerPhone,
    testNumber: { ...testNumber, number: "+79952225214" }
  }), null);
});

test("safe line metadata contains no credentials or provider employee details", () => {
  const source = { ...ownedNumber.sipLine, username: "private-login", passwordEncrypted: "enc:v2:private", providerEmployeeId: "private-id" };
  const result = safeSipLineRoute(ownedNumber.number, source);
  assert.deepEqual(Object.keys(result!).sort(), ["endpoint", "number", "port", "revision", "server", "transport"]);
  assert.doesNotMatch(JSON.stringify(result), /private|username|password|providerEmployee/);
});

test("invalid endpoints, insecure transports and stale or absent revisions fail closed", () => {
  for (const change of [
    { asteriskEndpoint: "novofon-endpoint" },
    { asteriskEndpoint: "callsec-sip-79952225212" },
    { asteriskEndpoint: "callsec-sip-safe\n[evil]" },
    { server: "attacker.example" },
    { port: 5060 },
    { transport: "udp" },
    { updatedAt: new Date("invalid") },
    { updatedAt: undefined }
  ]) {
    assert.equal(safeSipLineRoute(ownedNumber.number, { ...ownedNumber.sipLine, ...change } as SipLineRouteSource), null);
  }
});
