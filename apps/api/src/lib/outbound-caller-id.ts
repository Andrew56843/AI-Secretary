import { isValidPhone, normalizePhone } from "./phone.js";

function normalizeRussianPhone(value: string | null | undefined) {
  const phone = normalizePhone(value ?? "");
  return isValidPhone(phone) ? phone : null;
}

export function isOwnerTestDestination(ownerPhone: string, destinationPhone: string) {
  const owner = normalizeRussianPhone(ownerPhone);
  return Boolean(owner && owner === normalizeRussianPhone(destinationPhone));
}

export function resolveOutboundCallerId(input: {
  ownerPhone: string;
  destinationPhone: string;
  reservedNumber?: string | null;
  numberRentExpiresAt?: Date | null;
  testCallerId?: string | null;
  now?: Date;
}) {
  if (!normalizeRussianPhone(input.destinationPhone)) {
    return null;
  }

  const now = input.now ?? new Date();
  const reservedNumber = normalizeRussianPhone(input.reservedNumber);
  if (reservedNumber && input.numberRentExpiresAt && input.numberRentExpiresAt > now) {
    return reservedNumber;
  }

  return isOwnerTestDestination(input.ownerPhone, input.destinationPhone)
    ? normalizeRussianPhone(input.testCallerId)
    : null;
}
