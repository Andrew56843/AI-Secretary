import { randomUUID } from "node:crypto";
import { BillingTransactionType, CallDirection, PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

if (process.env.NODE_ENV === "production") {
  throw new Error("Database seed is disabled in production");
}

const RESERVED_NUMBERS = (process.env.SEED_RESERVED_NUMBERS ?? "+79990000001,+79990000002")
  .split(",")
  .map((number) => number.trim())
  .filter(Boolean);
const OWNER_PHONE = process.env.SEED_OWNER_PHONE ?? "+79990000000";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "123456";
const OWNER_NAME = process.env.SEED_OWNER_NAME ?? "Тестовый пользователь";
const START_BALANCE_KOPECKS = 100_000;

const INBOUND_PROMPT =
  "Ты AI-секретарь. Отвечай на входящие звонки по-русски, говори кратко и вежливо. Собирай имя клиента, причину обращения и контактные данные. Если вопрос сложный или клиент просит человека, переведи звонок владельцу аккаунта.";

const OUTBOUND_PROMPT =
  "Ты AI-секретарь для исходящих звонков. Говори по-русски, коротко представляйся, уточняй цель звонка и фиксируй итог разговора.";

async function main() {
  for (const number of RESERVED_NUMBERS) {
    await prisma.reservedPhoneNumber.upsert({
      where: { number },
      update: { providerDid: number.replace(/\D/g, "") },
      create: {
        number,
        providerDid: number.replace(/\D/g, ""),
        assigned: false
      }
    });
  }

  const password = await bcrypt.hash(OWNER_PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { phone: OWNER_PHONE },
    update: {
      fullName: OWNER_NAME,
      password
    },
    create: {
      phone: OWNER_PHONE,
      fullName: OWNER_NAME,
      password,
      rubleBalanceKopecks: 0
    }
  });

  await prisma.assistantProfile.upsert({
    where: { userId_mode: { userId: user.id, mode: CallDirection.INBOUND } },
    update: {},
    create: {
      userId: user.id,
      mode: CallDirection.INBOUND,
      title: "Входящие звонки",
      businessName: null,
      prompt: INBOUND_PROMPT,
      greetingText: "Здравствуйте! Я AI-секретарь. Чем могу помочь?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "cedar",
      maxDialogSeconds: 120,
      reservedNumberId: null,
      status: "ACTIVE"
    }
  });

  await prisma.assistantProfile.upsert({
    where: { userId_mode: { userId: user.id, mode: CallDirection.OUTBOUND } },
    update: {},
    create: {
      userId: user.id,
      mode: CallDirection.OUTBOUND,
      title: "Исходящие звонки",
      businessName: null,
      prompt: OUTBOUND_PROMPT,
      greetingText: "Здравствуйте! Я AI-секретарь, звоню по заявке. Вам удобно говорить?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "cedar",
      maxDialogSeconds: 90,
      status: "ACTIVE"
    }
  });

  await prisma.googleAccount.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      status: "DISCONNECTED"
    }
  });

  await prisma.telegramAccount.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      linkToken: randomUUID(),
      status: "DISCONNECTED"
    }
  });

  await prisma.$transaction(async (tx) => {
    const transactionId = `seed_starting_balance_${user.id}`;
    const existing = await tx.billingTransaction.findUnique({ where: { id: transactionId } });

    if (!existing) {
      await tx.billingTransaction.create({
        data: {
          id: transactionId,
          userId: user.id,
          type: BillingTransactionType.FREE_GRANT,
          amountKopecks: START_BALANCE_KOPECKS,
          note: "Development seed starting balance"
        }
      });
      await tx.user.update({
        where: { id: user.id },
        data: { rubleBalanceKopecks: { increment: START_BALANCE_KOPECKS } }
      });
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
