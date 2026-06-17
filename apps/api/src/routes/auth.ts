import { PhoneVerificationPurpose, PhoneVerificationStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { comparePassword, createToken, hashPassword } from "../lib/auth.js";
import { isValidPhone, normalizePhone } from "../lib/phone.js";
import {
  getFreshPhoneVerificationRequest,
  publicPhoneVerificationRequest,
  startPhoneVerificationRequest
} from "../lib/phone-verification.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const authRouter = Router();

const phoneSchema = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine(isValidPhone, "Phone must be in international format");

const passwordSchema = z.string().regex(/^\d{6}$/, "Password must contain exactly 6 digits");

const registerSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().trim().min(2).max(80).optional()
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema
});

const changePasswordSchema = z.object({
  password: passwordSchema
});

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid time zone");

const updateTimeZoneSchema = z.object({
  timeZone: timeZoneSchema
});

const verificationParamsSchema = z.object({
  id: z.string().trim().min(1).max(80)
});

function publicUser(user: { id: string; phone: string; fullName: string | null; timeZone?: string | null; createdAt?: Date }) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    timeZone: user.timeZone ?? "Europe/Moscow",
    createdAt: user.createdAt
  };
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const { phone, fullName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    res.status(409).json({ message: "Phone already registered" });
    return;
  }

  const request = await startPhoneVerificationRequest({
    phone,
    purpose: PhoneVerificationPurpose.REGISTER,
    fullName
  });

  res.status(202).json({
    verification: publicPhoneVerificationRequest(request)
  });
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const { phone, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { phone } });

  if (!user) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const passwordMatches = await comparePassword(password, user.password);

  if (!passwordMatches) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const token = createToken({ userId: user.id, phone: user.phone });

  res.json({
    token,
    user: publicUser(user)
  });
});

authRouter.post("/forgot-password", async (req, res) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  const request = await startPhoneVerificationRequest({
    phone: parsed.data.phone,
    purpose: PhoneVerificationPurpose.RECOVER
  });

  res.status(202).json({
    verification: publicPhoneVerificationRequest(request)
  });
});

authRouter.get("/phone-verification/:id", async (req, res) => {
  const parsed = verificationParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid verification id", errors: parsed.error.flatten() });
    return;
  }

  const request = await getFreshPhoneVerificationRequest(parsed.data.id);
  if (!request) {
    res.status(404).json({ message: "Verification request not found" });
    return;
  }

  const verification = publicPhoneVerificationRequest(request);

  if (request.status !== PhoneVerificationStatus.VERIFIED) {
    res.json({ verification });
    return;
  }

  const user = request.userId
    ? await prisma.user.findUnique({
        where: { id: request.userId },
        select: { id: true, phone: true, fullName: true, createdAt: true }
      })
    : null;

  if (!user || !request.issuedPassword) {
    res.json({ verification });
    return;
  }

  const payload = {
    verification,
    issuedPassword: request.issuedPassword,
    delivery: {
      channel: "call_verification",
      message: "Phone ownership was verified by an incoming call."
    }
  };

  if (request.purpose === PhoneVerificationPurpose.REGISTER) {
    res.json({
      ...payload,
      token: createToken({ userId: user.id, phone: user.phone }),
      user: publicUser(user)
    });
    return;
  }

  res.json(payload);
});

authRouter.put("/password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { password: await hashPassword(parsed.data.password) }
  });

  res.json({ user: publicUser(user) });
});

authRouter.put("/timezone", requireAuth, async (req, res) => {
  const parsed = updateTimeZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { timeZone: parsed.data.timeZone },
    select: {
      id: true,
      phone: true,
      fullName: true,
      timeZone: true,
      createdAt: true
    }
  });

  res.json({ user: publicUser(user) });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      id: true,
      phone: true,
      fullName: true,
      timeZone: true,
      createdAt: true
    }
  });

  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json({ user: publicUser(user) });
});

export { authRouter };
