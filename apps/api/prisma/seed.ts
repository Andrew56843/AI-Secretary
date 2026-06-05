import { randomUUID } from "node:crypto";
import { BillingTransactionType, CallDirection, PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const RESERVED_NUMBERS = ["+79952225212", "+79952225213"];
const OWNER_PHONE = "+79054176285";
const OWNER_PASSWORD = "123456";
const START_BALANCE_RUB = 1000;

const INBOUND_PROMPT =
  "Ты AI-секретарь. Отвечай на входящие звонки по-русски, говори кратко и вежливо. Собирай имя клиента, причину обращения и контактные данные. Если вопрос сложный или клиент просит человека, переведи звонок владельцу аккаунта.";

const OUTBOUND_PROMPT =
  "Ты AI-секретарь для исходящих звонков. Говори по-русски, коротко представляйся, уточняй цель звонка и фиксируй итог разговора.";

async function main() {
  await prisma.user.deleteMany({
    where: {
      phone: {
        not: OWNER_PHONE
      }
    }
  });

  for (const number of RESERVED_NUMBERS) {
    await prisma.reservedPhoneNumber.upsert({
      where: { number },
      update: {
        assigned: false,
        providerDid: number.replace(/\D/g, "")
      },
      create: {
        number,
        providerDid: number.replace(/\D/g, ""),
        assigned: false
      }
    });
  }

  await prisma.reservedPhoneNumber.deleteMany({
    where: {
      number: {
        notIn: RESERVED_NUMBERS
      },
      assigned: false
    }
  });

  const password = await bcrypt.hash(OWNER_PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { phone: OWNER_PHONE },
    update: {
      fullName: "Андрей",
      password,
      rubleBalance: START_BALANCE_RUB,
      minuteBalanceSeconds: 0,
      totalPurchasedSeconds: 0,
      numberPurchasedAt: null,
      numberRentExpiresAt: null
    },
    create: {
      phone: OWNER_PHONE,
      fullName: "Андрей",
      password,
      rubleBalance: START_BALANCE_RUB,
      minuteBalanceSeconds: 0,
      totalPurchasedSeconds: 0,
      numberPurchasedAt: null,
      numberRentExpiresAt: null
    }
  });

  await prisma.callLog.deleteMany({
    where: {
      assistantProfile: {
        userId: user.id
      }
    }
  });
  await prisma.outboundContact.deleteMany({ where: { userId: user.id } });
  await prisma.paymentOrder.deleteMany({ where: { userId: user.id } });
  await prisma.billingTransaction.deleteMany({ where: { userId: user.id } });

  await prisma.assistantProfile.upsert({
    where: { userId_mode: { userId: user.id, mode: CallDirection.INBOUND } },
    update: {
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
    },
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
    update: {
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
      reservedNumberId: null,
      status: "ACTIVE"
    },
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

  await prisma.billingTransaction.create({
    data: {
      userId: user.id,
      type: BillingTransactionType.FREE_GRANT,
      amountSeconds: 0,
      amountRub: START_BALANCE_RUB,
      note: "Starting balance"
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
