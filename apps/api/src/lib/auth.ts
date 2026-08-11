import * as bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config.js";

export type TokenPayload = {
  userId: string;
  phone: string;
  authVersion: number;
  impersonatedByUserId?: string;
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function createToken(payload: TokenPayload, expiresIn: SignOptions["expiresIn"] = "7d") {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
}
