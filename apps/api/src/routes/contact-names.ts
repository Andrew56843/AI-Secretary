import { Router } from "express";
import { z } from "zod";
import { isValidPhone, normalizePhone } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const contactNamesRouter = Router();

const contactNameSelect = {
  id: true,
  phone: true,
  name: true,
  createdAt: true,
  updatedAt: true
};

const saveContactNameSchema = z.object({
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .refine(isValidPhone, "Phone must be in international format"),
  name: z.string().trim().min(1).max(80)
});

contactNamesRouter.get("/me", requireAuth, async (req, res) => {
  const contacts = await prisma.phoneContactName.findMany({
    where: { userId: req.user!.userId },
    orderBy: { updatedAt: "desc" },
    select: contactNameSelect
  });

  res.json({ contacts });
});

contactNamesRouter.put("/me", requireAuth, async (req, res) => {
  const parsed = saveContactNameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const contact = await prisma.phoneContactName.upsert({
    where: {
      userId_phone: {
        userId: req.user!.userId,
        phone: parsed.data.phone
      }
    },
    update: {
      name: parsed.data.name
    },
    create: {
      userId: req.user!.userId,
      phone: parsed.data.phone,
      name: parsed.data.name
    },
    select: contactNameSelect
  });

  res.json({ contact });
});

export { contactNamesRouter };
