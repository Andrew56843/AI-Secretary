import { CallDirection, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { comparePassword, createToken, hashPassword } from "../lib/auth.js";
import { generateSixDigitPassword, isValidPhone, normalizePhone } from "../lib/phone.js";
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

function publicUser(user: { id: string; phone: string; fullName: string | null; createdAt?: Date }) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName,
    createdAt: user.createdAt
  };
}

async function createDefaultProfiles(tx: Prisma.TransactionClient, userId: string, phone: string) {
  await tx.assistantProfile.createMany({
    data: [
      {
        userId,
        mode: CallDirection.INBOUND,
        title: "Входящие звонки",
        businessName: "Мой бизнес",
        prompt: "",
        greetingText: "",
        forwardingPhone: phone,
        forwardingEnabled: true,
        forwardingOnComplete: true,
        forwardingOnStalemate: true,
        realtimeModel: "gpt-realtime-2",
        voice: "alloy",
        maxDialogSeconds: 120
      },
      {
        userId,
        mode: CallDirection.OUTBOUND,
        title: "Исходящие звонки",
        businessName: "Мой бизнес",
        prompt: "",
        greetingText: "",
        forwardingPhone: phone,
        forwardingEnabled: true,
        forwardingOnComplete: true,
        forwardingOnStalemate: true,
        realtimeModel: "gpt-realtime-2",
        voice: "alloy",
        maxDialogSeconds: 90
      }
    ]
  });
}

async function createFreeMinuteGrant(tx: Prisma.TransactionClient, userId: string) {
  await tx.billingTransaction.create({
    data: {
      userId,
      type: "FREE_GRANT",
      amountSeconds: 300,
      note: "Registration free minutes"
    }
  });
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

  const issuedPassword = generateSixDigitPassword();
  const passwordHash = await hashPassword(issuedPassword);

  try {
    const user = await prisma.$transaction(
      async (tx) => {
        const created = await tx.user.create({
          data: {
            phone,
            fullName,
            password: passwordHash
          }
        });

        await createDefaultProfiles(tx, created.id, created.phone);
        await createFreeMinuteGrant(tx, created.id);
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    const token = createToken({ userId: user.id, phone: user.phone });

    res.status(201).json({
      token,
      user: publicUser(user),
      issuedPassword,
      delivery: {
        channel: "sms_stub",
        message: `SMS integration is not connected yet. Test password: ${issuedPassword}`
      }
    });
  } catch (error) {
    throw error;
  }
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

  const issuedPassword = generateSixDigitPassword();
  await prisma.user.update({
    where: { id: user.id },
    data: { password: await hashPassword(issuedPassword) }
  });

  res.json({
    issuedPassword,
    delivery: {
      channel: "sms_stub",
      message: `SMS integration is not connected yet. Recovery password: ${issuedPassword}`
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

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: {
      id: true,
      phone: true,
      fullName: true,
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
