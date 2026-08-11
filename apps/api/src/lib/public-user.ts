import { isAdminPhone } from "./admin-access.js";

type PublicUserInput = {
  id: string;
  phone: string;
  fullName: string | null;
  timeZone?: string | null;
  createdAt?: Date;
};

export function publicUser(user: PublicUserInput) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    timeZone: user.timeZone ?? "Europe/Moscow",
    createdAt: user.createdAt,
    isAdmin: isAdminPhone(user.phone)
  };
}
