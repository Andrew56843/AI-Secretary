import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const integrationsRouter = Router();

const googleConnectSchema = z.object({
  googleEmail: z.string().email().optional(),
  calendarId: z.string().trim().min(1).max(200).default("primary")
});

const telegramConnectSchema = z.object({
  username: z.string().trim().min(2).max(80).optional(),
  chatId: z.string().trim().min(2).max(80).optional()
});

async function ensureTelegramAccount(userId: string) {
  const existing = await prisma.telegramAccount.findUnique({ where: { userId } });
  if (existing) {
    return existing;
  }

  return prisma.telegramAccount.create({
    data: {
      userId,
      linkToken: randomUUID()
    }
  });
}

function publicTelegram(account: Awaited<ReturnType<typeof ensureTelegramAccount>>) {
  return {
    ...account,
    botLink: `https://t.me/${account.botUsername}?start=${account.linkToken}`
  };
}

integrationsRouter.get("/me", requireAuth, async (req, res) => {
  const [googleAccount, telegramAccount] = await Promise.all([
    prisma.googleAccount.findUnique({ where: { userId: req.user!.userId } }),
    ensureTelegramAccount(req.user!.userId)
  ]);

  res.json({
    integrations: {
      google: googleAccount ?? {
        status: "DISCONNECTED",
        googleEmail: null,
        calendarId: null,
        connectedAt: null
      },
      telegram: publicTelegram(telegramAccount)
    }
  });
});

integrationsRouter.post("/google/connect", requireAuth, async (req, res) => {
  const parsed = googleConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const account = await prisma.googleAccount.upsert({
    where: { userId: req.user!.userId },
    update: {
      status: "CONNECTED",
      googleEmail: parsed.data.googleEmail,
      calendarId: parsed.data.calendarId,
      connectedAt: new Date()
    },
    create: {
      userId: req.user!.userId,
      status: "CONNECTED",
      googleEmail: parsed.data.googleEmail,
      calendarId: parsed.data.calendarId,
      connectedAt: new Date()
    }
  });

  res.json({ google: account });
});

integrationsRouter.post("/google/disconnect", requireAuth, async (req, res) => {
  const account = await prisma.googleAccount.upsert({
    where: { userId: req.user!.userId },
    update: {
      status: "DISCONNECTED",
      connectedAt: null
    },
    create: {
      userId: req.user!.userId,
      status: "DISCONNECTED"
    }
  });

  res.json({ google: account });
});

integrationsRouter.post("/telegram/link", requireAuth, async (req, res) => {
  const account = await ensureTelegramAccount(req.user!.userId);
  res.json({ telegram: publicTelegram(account) });
});

integrationsRouter.post("/telegram/connect", requireAuth, async (req, res) => {
  const parsed = telegramConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const base = await ensureTelegramAccount(req.user!.userId);
  const account = await prisma.telegramAccount.update({
    where: { id: base.id },
    data: {
      status: "CONNECTED",
      username: parsed.data.username,
      chatId: parsed.data.chatId,
      connectedAt: new Date()
    }
  });

  res.json({ telegram: publicTelegram(account) });
});

integrationsRouter.post("/telegram/disconnect", requireAuth, async (req, res) => {
  const base = await ensureTelegramAccount(req.user!.userId);
  const account = await prisma.telegramAccount.update({
    where: { id: base.id },
    data: {
      status: "DISCONNECTED",
      chatId: null,
      username: null,
      connectedAt: null
    }
  });

  res.json({ telegram: publicTelegram(account) });
});

export { integrationsRouter };
