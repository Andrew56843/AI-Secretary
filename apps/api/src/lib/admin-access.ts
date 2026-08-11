import { env } from "../config.js";
import { normalizePhone } from "./phone.js";

const adminPhones = new Set(
  String(env.ADMIN_PHONES ?? "")
    .split(",")
    .map((phone) => normalizePhone(phone))
    .filter(Boolean)
);

export function isAdminPhone(phone: string | null | undefined) {
  const normalized = normalizePhone(phone ?? "");
  return Boolean(normalized && adminPhones.has(normalized));
}
