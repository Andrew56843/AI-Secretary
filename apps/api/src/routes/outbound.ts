import { CallDirection, CallStatus, OutboundContactStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { createBillableCallLog } from "../lib/billable-call.js";
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

const queueContactSchema = z.object({
  queuedForCall: z.boolean()
});

outboundRouter.get("/contacts", requireAuth, async (req, res) => {
  const parsed = contactsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid pagination", errors: parsed.error.flatten() });
    return;
  }

  const where: Prisma.OutboundContactWhereInput = { userId: req.user!.userId };
  const { pageSize } = parsed.data;

  const [total, pending, queued, called, failed] = await Promise.all([
    prisma.outboundContact.count({ where }),
    prisma.outboundContact.count({ where: { ...where, status: OutboundContactStatus.PENDING } }),
    prisma.outboundContact.count({ where: { ...where, queuedForCall: true } }),
    prisma.outboundContact.count({ where: { ...where, status: OutboundContactStatus.CALLED } }),
    prisma.outboundContact.count({ where: { ...where, status: OutboundContactStatus.FAILED } })
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
    pending,
    queued,
    called,
    failed
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

  const phones = extractPhones(parsed.data.rawNumbers);
  if (phones.length === 0) {
    res.status(400).json({ message: "No valid phone numbers found" });
    return;
  }

  await prisma.outboundContact.createMany({
    data: phones.map((phone) => ({
      userId: req.user!.userId,
      phone
    })),
    skipDuplicates: true
  });

  const contacts = await prisma.outboundContact.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  res.status(201).json({
    importedCount: phones.length,
    contacts
  });
});

outboundRouter.put("/contacts/:id/queue", requireAuth, async (req, res) => {
  const parsedParams = contactParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid contact id" });
    return;
  }

  const parsed = queueContactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const contact = await prisma.outboundContact.findFirst({
    where: {
      id: parsedParams.data.id,
      userId: req.user!.userId
    }
  });

  if (!contact) {
    res.status(404).json({ message: "Contact not found" });
    return;
  }

  const updated = await prisma.outboundContact.update({
    where: { id: contact.id },
    data: {
      queuedForCall: parsed.data.queuedForCall,
      ...(parsed.data.queuedForCall ? { status: OutboundContactStatus.PENDING } : {})
    }
  });

  res.json({ contact: updated });
});

outboundRouter.post("/contacts/:id/mock-call", requireAuth, async (req, res) => {
  const parsedParams = contactParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid contact id" });
    return;
  }

  const contact = await prisma.outboundContact.findFirst({
    where: {
      id: parsedParams.data.id,
      userId: req.user!.userId
    }
  });

  if (!contact) {
    res.status(404).json({ message: "Contact not found" });
    return;
  }

  const profile = await prisma.assistantProfile.findUnique({
    where: { userId_mode: { userId: req.user!.userId, mode: CallDirection.OUTBOUND } },
    select: { id: true }
  });

  if (!profile) {
    res.status(404).json({ message: "Create outbound profile first" });
    return;
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const log = await createBillableCallLog(tx, {
          userId: req.user!.userId,
          direction: CallDirection.OUTBOUND,
          customerPhone: contact.phone,
          status: CallStatus.SUCCESS,
          durationSeconds: 72,
          summary: "Демо-обзвон завершен: клиент ответил, результат зафиксирован.",
          transcript:
            "Assistant: Здравствуйте! Уточню пару вопросов по заявке.\nUser: Да, слушаю.\nAssistant: Спасибо, я передам итог владельцу аккаунта.",
          recordingUrl: "https://example.com/calls/outbound-demo.mp3"
        });

        const updated = await tx.outboundContact.update({
          where: { id: contact.id },
          data: {
            status: OutboundContactStatus.CALLED,
            queuedForCall: false,
            attempts: { increment: 1 },
            lastCallLogId: log.id
          }
        });

        return { contact: updated, log };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "INSUFFICIENT_MINUTES") {
      res.status(402).json({ message: "Not enough minutes. Top up balance to continue calls." });
      return;
    }
    if (error instanceof Error && error.message === "PROFILE_NOT_FOUND") {
      res.status(404).json({ message: "Create outbound profile first" });
      return;
    }
    throw error;
  }
});

export { outboundRouter };
