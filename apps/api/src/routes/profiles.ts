import { Prisma } from "@prisma/client";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";
import { z } from "zod";

const profilesRouter = Router();

const updateProfileSchema = z.object({
  title: z.string().trim().min(2).max(100),
  businessName: z.string().trim().max(120).optional(),
  prompt: z.string().trim().min(20).max(4000),
  forwardingPhone: z.string().trim().min(8).max(24),
  reservedNumberId: z.string().cuid().optional()
});

profilesRouter.get("/numbers/free", requireAuth, async (_req, res) => {
  const numbers = await prisma.reservedPhoneNumber.findMany({
    where: { assigned: false },
    orderBy: { number: "asc" },
    take: 50
  });

  res.json({ numbers });
});

profilesRouter.get("/me", requireAuth, async (req, res) => {
  const profile = await prisma.assistantProfile.findFirst({
    where: { userId: req.user!.userId },
    include: {
      reservedNumber: true,
      _count: {
        select: { callLogs: true }
      }
    }
  });

  res.json({ profile });
});

profilesRouter.put("/me", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  const userId = req.user!.userId;

  try {
    const profile = await prisma.$transaction(async (tx) => {
      const existing = await tx.assistantProfile.findFirst({ where: { userId } });
      if (!existing) {
        const candidate = payload.reservedNumberId
          ? await tx.reservedPhoneNumber.findUnique({ where: { id: payload.reservedNumberId } })
          : await tx.reservedPhoneNumber.findFirst({
              where: { assigned: false },
              orderBy: { number: "asc" }
            });

        if (!candidate) {
          throw new Error("NO_FREE_NUMBERS");
        }

        if (candidate.assigned) {
          throw new Error("NUMBER_ALREADY_ASSIGNED");
        }

        const assignResult = await tx.reservedPhoneNumber.updateMany({
          where: { id: candidate.id, assigned: false },
          data: { assigned: true }
        });

        if (assignResult.count !== 1) {
          throw new Error("NUMBER_ALREADY_ASSIGNED");
        }

        return tx.assistantProfile.create({
          data: {
            userId,
            title: payload.title,
            businessName: payload.businessName,
            prompt: payload.prompt,
            forwardingPhone: payload.forwardingPhone,
            reservedNumberId: candidate.id
          },
          include: {
            reservedNumber: true
          }
        });
      }

      let nextReservedId = existing.reservedNumberId;

      if (payload.reservedNumberId && payload.reservedNumberId !== existing.reservedNumberId) {
        const candidate = await tx.reservedPhoneNumber.findUnique({
          where: { id: payload.reservedNumberId }
        });

        if (!candidate) {
          throw new Error("NUMBER_NOT_FOUND");
        }

        if (candidate.assigned) {
          throw new Error("NUMBER_ALREADY_ASSIGNED");
        }

        const assignResult = await tx.reservedPhoneNumber.updateMany({
          where: { id: candidate.id, assigned: false },
          data: { assigned: true }
        });

        if (assignResult.count !== 1) {
          throw new Error("NUMBER_ALREADY_ASSIGNED");
        }

        await tx.reservedPhoneNumber.update({
          where: { id: existing.reservedNumberId },
          data: { assigned: false }
        });

        nextReservedId = candidate.id;
      }

      return tx.assistantProfile.update({
        where: { id: existing.id },
        data: {
          title: payload.title,
          businessName: payload.businessName,
          prompt: payload.prompt,
          forwardingPhone: payload.forwardingPhone,
          reservedNumberId: nextReservedId
        },
        include: {
          reservedNumber: true
        }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    res.json({ profile });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_FREE_NUMBERS") {
      res.status(409).json({ message: "No free numbers available now" });
      return;
    }
    if (error instanceof Error && error.message === "NUMBER_ALREADY_ASSIGNED") {
      res.status(409).json({ message: "Number has already been assigned. Pick another one." });
      return;
    }
    if (error instanceof Error && error.message === "NUMBER_NOT_FOUND") {
      res.status(404).json({ message: "Number not found" });
      return;
    }
    throw error;
  }
});

export { profilesRouter };
