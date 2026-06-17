import { PhoneVerificationPurpose, PhoneVerificationStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import {
  createDefaultProfiles,
  createStartingBalanceGrant,
  REGISTRATION_START_BALANCE_KOPECKS,
  REGISTRATION_START_BALANCE_RUB
} from "../lib/account-provisioning.js";
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

const completePhoneVerificationSchema = z.object({
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

  res.json({ verification });
});

authRouter.post("/phone-verification/:id/complete", async (req, res) => {
  const parsedParams = verificationParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid verification id", errors: parsedParams.error.flatten() });
    return;
  }

  const parsedBody = completePhoneVerificationSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsedBody.error.flatten() });
    return;
  }

  const passwordHash = await hashPassword(parsedBody.data.password);

  const result = await prisma.$transaction(
    async (tx) => {
      const request = await tx.phoneVerificationRequest.findUnique({
        where: { id: parsedParams.data.id }
      });

      if (!request) {
        return { ok: false as const, status: 404, message: "Verification request not found" };
      }

      const verification = publicPhoneVerificationRequest(request);

      if (request.status !== PhoneVerificationStatus.VERIFIED) {
        return { ok: false as const, status: 409, message: "Phone is not verified yet", verification };
      }

      if (request.userId) {
        return { ok: false as const, status: 409, message: "Verification request is already used", verification };
      }

      const latestRequest = await tx.phoneVerificationRequest.findFirst({
        where: { phone: request.phone },
        orderBy: { createdAt: "desc" },
        select: { id: true }
      });

      if (latestRequest?.id !== request.id) {
        const expired = await tx.phoneVerificationRequest.update({
          where: { id: request.id },
          data: {
            status: PhoneVerificationStatus.EXPIRED,
            verifiedAt: null,
            issuedPassword: null
          }
        });

        return {
          ok: false as const,
          status: 409,
          message: "Verification request was superseded",
          verification: publicPhoneVerificationRequest(expired)
        };
      }

      let user:
        | {
            id: string;
            phone: string;
            fullName: string | null;
            timeZone: string | null;
            createdAt: Date;
          }
        | null = null;

      if (request.purpose === PhoneVerificationPurpose.REGISTER) {
        const existingUser = await tx.user.findUnique({
          where: { phone: request.phone },
          select: { id: true }
        });

        if (existingUser) {
          const expired = await tx.phoneVerificationRequest.update({
            where: { id: request.id },
            data: {
              status: PhoneVerificationStatus.EXPIRED,
              verifiedAt: null,
              issuedPassword: null
            }
          });

          return {
            ok: false as const,
            status: 409,
            message: "Phone already registered",
            verification: publicPhoneVerificationRequest(expired)
          };
        }

        user = await tx.user.create({
          data: {
            phone: request.phone,
            fullName: request.fullName,
            password: passwordHash,
            rubleBalance: REGISTRATION_START_BALANCE_RUB,
            rubleBalanceKopecks: REGISTRATION_START_BALANCE_KOPECKS,
            minuteBalanceSeconds: 0
          },
          select: {
            id: true,
            phone: true,
            fullName: true,
            timeZone: true,
            createdAt: true
          }
        });

        await createDefaultProfiles(tx, user.id, user.phone);
        await createStartingBalanceGrant(tx, user.id);
      } else {
        user = await tx.user.findUnique({
          where: { phone: request.phone },
          select: {
            id: true,
            phone: true,
            fullName: true,
            timeZone: true,
            createdAt: true
          }
        });

        if (!user) {
          const expired = await tx.phoneVerificationRequest.update({
            where: { id: request.id },
            data: {
              status: PhoneVerificationStatus.EXPIRED,
              verifiedAt: null,
              issuedPassword: null
            }
          });

          return {
            ok: false as const,
            status: 404,
            message: "User not found",
            verification: publicPhoneVerificationRequest(expired)
          };
        }

        user = await tx.user.update({
          where: { id: user.id },
          data: { password: passwordHash },
          select: {
            id: true,
            phone: true,
            fullName: true,
            timeZone: true,
            createdAt: true
          }
        });
      }

      const completedRequest = await tx.phoneVerificationRequest.update({
        where: { id: request.id },
        data: {
          issuedPassword: null,
          userId: user.id
        }
      });

      return {
        ok: true as const,
        user,
        verification: publicPhoneVerificationRequest(completedRequest)
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (!result.ok) {
    res.status(result.status).json({
      message: result.message,
      ...(result.verification ? { verification: result.verification } : {})
    });
    return;
  }

  res.json({
    token: createToken({ userId: result.user.id, phone: result.user.phone }),
    user: publicUser(result.user),
    verification: result.verification,
    delivery: {
      channel: "call_verification",
      message: "Phone ownership was verified by an incoming call."
    }
  });
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
