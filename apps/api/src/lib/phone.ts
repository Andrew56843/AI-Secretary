export function normalizePhone(input: string) {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }

  return `+${digits}`;
}

export function isValidPhone(phone: string) {
  return /^\+\d{10,15}$/.test(phone);
}

export function extractPhones(input: string) {
  const candidates = input
    .split(/[\s,;]+/)
    .map((item) => normalizePhone(item))
    .filter(Boolean);

  return [...new Set(candidates)].filter(isValidPhone);
}

export function generateSixDigitPassword() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
