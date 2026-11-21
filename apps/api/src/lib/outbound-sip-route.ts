import { resolveOutboundCallerId } from "./outbound-caller-id.js";
import { isValidPhone, normalizePhone } from "./phone.js";

export const sipLineRouteSelect = {
  enabled: true,
  asteriskEndpoint: true,
  server: true,
  port: true,
  transport: true,
  updatedAt: true
} as const;

export const reservedNumberRouteSelect = {
  number: true,
  assigned: true,
  sipLine: { select: sipLineRouteSelect }
} as const;

export type SipLineRouteSource = {
  enabled: boolean;
  asteriskEndpoint: string;
  server: string;
  port: number;
  transport: string;
  updatedAt: Date;
};

export type OutboundSipLine = {
  endpoint: string;
  number: string;
  server: string;
  port: number;
  transport: "tls";
  revision: string;
};

type ReservedNumberRouteSource = {
  number: string;
  assigned: boolean;
  sipLine: SipLineRouteSource | null;
};

export function safeSipLineRoute(number: string, line: SipLineRouteSource | null | undefined): OutboundSipLine | null {
  const normalizedNumber = normalizePhone(number);
  if (
    !isValidPhone(normalizedNumber) ||
    !line?.enabled ||
    line.asteriskEndpoint !== `callsec-sip-${normalizedNumber.slice(1)}` ||
    line.server !== "sip.novofon.ru" ||
    line.port !== 5061 ||
    line.transport !== "tls" ||
    !(line.updatedAt instanceof Date) || !Number.isFinite(line.updatedAt.getTime())
  ) {
    return null;
  }
  return {
    endpoint: line.asteriskEndpoint,
    number: normalizedNumber,
    server: line.server,
    port: line.port,
    transport: "tls",
    revision: line.updatedAt.toISOString()
  };
}

export function resolveOutboundSipRoute(input: {
  ownerPhone: string;
  destinationPhone: string;
  reservedNumber?: ReservedNumberRouteSource | null;
  numberRentExpiresAt?: Date | null;
  testCallerId?: string | null;
  testNumber?: ReservedNumberRouteSource | null;
  now?: Date;
}) {
  const callerId = resolveOutboundCallerId({
    ownerPhone: input.ownerPhone,
    destinationPhone: input.destinationPhone,
    reservedNumber: input.reservedNumber?.assigned ? input.reservedNumber.number : null,
    numberRentExpiresAt: input.numberRentExpiresAt,
    testCallerId: input.testCallerId,
    now: input.now
  });
  if (!callerId) {
    return null;
  }

  // A broken dedicated rental line must not silently route through the shared test line.
  const source = input.reservedNumber && callerId === normalizePhone(input.reservedNumber.number)
    ? input.reservedNumber
    : input.testNumber && callerId === normalizePhone(input.testNumber.number)
      ? input.testNumber
      : null;
  const sipLine = source ? safeSipLineRoute(source.number, source.sipLine) : null;
  return sipLine ? { callerId, sipLine } : null;
}
