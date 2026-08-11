import { CallDirection, OutboundContactStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { extractPhones } from "../lib/phone.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const outboundRouter = Router();

const importContactsSchema = z.object({
  rawNumbers: z.string().trim().min(3).max(20000)
});

const contactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10)
});

const contactParamsSchema = z.object({
  id: z.string().cuid()
});

async function hasActiveReservedNumber(userId: string) {
  const now = new Date();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      numberRentExpiresAt: true,
      profiles: {
        where: { reservedNumberId: { not: null } },
        select: { id: true },
        take: 1
      }
    }
  });

  return Boolean(user?.numberRentExpiresAt && user.numberRentExpiresAt > now && user.profiles.length > 0);
}

outboundRouter.get("/contacts", requireAuth, async (req, res) => {
  const parsed = contactsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid pagination", errors: parsed.error.flatten() });
    return;
  }

  const where: Prisma.OutboundContactWhereInput = { userId: req.user!.userId, callMode: CallDirection.OUTBOUND };
  const { pageSize } = parsed.data;

  const [total, pending] = await Promise.all([
    prisma.outboundContact.count({ where }),
    prisma.outboundContact.count({ where: { ...where, status: OutboundContactStatus.PENDING } })
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(parsed.data.page, totalPages);

  const contacts = await prisma.outboundContact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize
  });

  const stats = {
    total,
    pending
  };

  res.json({
    contacts,
    stats,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasPreviousPage: page > 1,
      hasNextPage: page < totalPages
    }
  });
});

outboundRouter.post("/contacts/import", requireAuth, async (req, res) => {
  const parsed = importContactsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  if (!(await hasActiveReservedNumber(req.user!.userId))) {
    res.status(409).json({ message: "Сначала зарезервируйте номер аккаунта для входящих и исходящих звонков" });
    return;
  }

  const phones = extractPhones(parsed.data.rawNumbers);
  if (phones.length === 0) {
    res.status(400).json({ message: "No valid phone numbers found" });
    return;
  }

  await prisma.outboundContact.createMany({
    data: phones.map((phone) => ({
      userId: req.user!.userId,
      phone,
      callMode: CallDirection.OUTBOUND
    })),
    skipDuplicates: true
  });

  const contacts = await prisma.outboundContact.findMany({
    where: { userId: req.user!.userId, callMode: CallDirection.OUTBOUND },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  res.status(201).json({
    importedCount: phones.length,
    contacts
  });
});

outboundRouter.delete("/contacts/:id", requireAuth, async (req, res) => {
  const parsedParams = contactParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid contact id" });
    return;
  }

  const contact = await prisma.outboundContact.findFirst({
    where: {
      id: parsedParams.data.id,
      userId: req.user!.userId,
      callMode: CallDirection.OUTBOUND
    }
  });

  if (!contact) {
    res.status(404).json({ message: "Contact not found" });
    return;
  }

  await prisma.outboundContact.delete({
    where: { id: contact.id }
  });

  res.status(204).send();
});

export { outboundRouter };
