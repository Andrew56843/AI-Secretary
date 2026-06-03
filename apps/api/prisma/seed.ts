import { BillingTransactionType, CallDirection, CallStatus, PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const STARTING_POOL = [
  "+74950010001",
  "+74950010002",
  "+74950010003",
  "+74950010004",
  "+74950010005",
  "+74950010006"
];

const DEMO_PHONE = "+79054176285";
const DEMO_PASSWORD = "123456";
const REGISTRATION_START_BALANCE_RUB = 100;
const DEMO_CALL_CHARGES_RUB = 59;

const INBOUND_PROMPT =
  "Ты ИИ-секретарь ресторана Echte Doner. Принимай входящие звонки, уточняй доставку или самовывоз, помогай выбрать позиции из меню, подтверждай заказ и переводь звонок владельцу, если клиент просит нестандартное решение.";

const OUTBOUND_PROMPT =
  "Ты ИИ-ассистент для исходящего обзвона клиентов Echte Doner. Вежливо представляйся, уточняй интерес к повторному заказу, фиксируй результат разговора и не затягивай диалог.";

async function main() {
  for (const number of STARTING_POOL) {
    await prisma.reservedPhoneNumber.upsert({
      where: { number },
      update: {},
      create: { number }
    });
  }

  const password = await bcrypt.hash(DEMO_PASSWORD, 12);

  const user = await prisma.user.upsert({
    where: { phone: DEMO_PHONE },
    update: {
      fullName: "Андрей",
      password,
      rubleBalance: REGISTRATION_START_BALANCE_RUB - DEMO_CALL_CHARGES_RUB,
      minuteBalanceSeconds: 0,
      totalPurchasedSeconds: 0,
      numberPurchasedAt: null,
      numberRentExpiresAt: null
    },
    create: {
      phone: DEMO_PHONE,
      fullName: "Андрей",
      password,
      rubleBalance: REGISTRATION_START_BALANCE_RUB - DEMO_CALL_CHARGES_RUB,
      minuteBalanceSeconds: 0,
      totalPurchasedSeconds: 0,
      numberRentExpiresAt: null
    }
  });

  const existingInbound = await prisma.assistantProfile.findUnique({
    where: { userId_mode: { userId: user.id, mode: CallDirection.INBOUND } }
  });

  if (existingInbound?.reservedNumberId) {
    await prisma.reservedPhoneNumber.update({
      where: { id: existingInbound.reservedNumberId },
      data: { assigned: false }
    });
  }

  const inboundProfile = await prisma.assistantProfile.upsert({
    where: { userId_mode: { userId: user.id, mode: CallDirection.INBOUND } },
    update: {
      title: "Входящие звонки Echte Doner",
      businessName: "Echte Doner",
      prompt: INBOUND_PROMPT,
      greetingText: "Здравствуйте! Я ИИ-оператор ресторана Echte Doner. Доставка или самовывоз?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "alloy",
      maxDialogSeconds: 120,
      reservedNumberId: null,
      status: "ACTIVE"
    },
    create: {
      userId: user.id,
      mode: CallDirection.INBOUND,
      title: "Входящие звонки Echte Doner",
      businessName: "Echte Doner",
      prompt: INBOUND_PROMPT,
      greetingText: "Здравствуйте! Я ИИ-оператор ресторана Echte Doner. Доставка или самовывоз?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "alloy",
      maxDialogSeconds: 120,
      status: "ACTIVE"
    }
  });

  const outboundProfile = await prisma.assistantProfile.upsert({
    where: { userId_mode: { userId: user.id, mode: CallDirection.OUTBOUND } },
    update: {
      title: "Исходящие звонки Echte Doner",
      businessName: "Echte Doner",
      prompt: OUTBOUND_PROMPT,
      greetingText: "Здравствуйте! Это Echte Doner, можно задать один короткий вопрос?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "alloy",
      maxDialogSeconds: 90,
      reservedNumberId: null,
      status: "ACTIVE"
    },
    create: {
      userId: user.id,
      mode: CallDirection.OUTBOUND,
      title: "Исходящие звонки Echte Doner",
      businessName: "Echte Doner",
      prompt: OUTBOUND_PROMPT,
      greetingText: "Здравствуйте! Это Echte Doner, можно задать один короткий вопрос?",
      forwardingPhone: user.phone,
      forwardingEnabled: true,
      forwardingOnComplete: true,
      forwardingOnStalemate: true,
      realtimeModel: "gpt-realtime-2",
      voice: "alloy",
      maxDialogSeconds: 90,
      status: "ACTIVE"
    }
  });

  await prisma.callLog.deleteMany({
    where: { assistantProfileId: { in: [inboundProfile.id, outboundProfile.id] } }
  });

  await prisma.outboundContact.deleteMany({ where: { userId: user.id } });
  await prisma.billingTransaction.deleteMany({ where: { userId: user.id } });

  await prisma.googleAccount.upsert({
    where: { userId: user.id },
    update: {
      status: "DISCONNECTED",
      googleEmail: null,
      calendarId: null,
      connectedAt: null
    },
    create: {
      userId: user.id,
      status: "DISCONNECTED"
    }
  });

  await prisma.telegramAccount.upsert({
    where: { userId: user.id },
    update: {
      status: "DISCONNECTED",
      username: null,
      chatId: null,
      connectedAt: null
    },
    create: {
      userId: user.id,
      linkToken: "demo-telegram-link-token",
      status: "DISCONNECTED"
    }
  });

  await prisma.billingTransaction.create({
    data: {
      userId: user.id,
      type: BillingTransactionType.FREE_GRANT,
      amountSeconds: 0,
      amountRub: REGISTRATION_START_BALANCE_RUB,
      note: "Registration starting balance"
    }
  });

  await prisma.billingTransaction.createMany({
    data: [
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -184,
        amountRub: -19,
        note: "gpt-realtime-mini · inbound · +79054176285",
        createdAt: new Date(Date.now() - 35 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -96,
        amountRub: -10,
        note: "gpt-realtime-mini · inbound · +79031234567",
        createdAt: new Date(Date.now() - 180 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -72,
        amountRub: -8,
        note: "gpt-realtime-mini · outbound · +79261230044",
        createdAt: new Date(Date.now() - 420 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -60,
        amountRub: -6,
        note: "gpt-realtime-mini · inbound · +79160001122",
        createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -45,
        amountRub: -5,
        note: "gpt-realtime-mini · outbound · +79031234567",
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -135,
        amountRub: -14,
        note: "gpt-realtime-mini · inbound · +79261230044",
        createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000)
      },
      {
        userId: user.id,
        type: BillingTransactionType.CALL_CHARGE,
        amountSeconds: -30,
        amountRub: -3,
        note: "gpt-realtime-mini · outbound · +79160001122",
        createdAt: new Date(Date.now() - 96 * 60 * 60 * 1000)
      }
    ]
  });

  await prisma.callLog.createMany({
    data: [
      {
        assistantProfileId: inboundProfile.id,
        direction: CallDirection.INBOUND,
        customerPhone: "+79054176285",
        status: CallStatus.SUCCESS,
        durationSeconds: 184,
        summary: "Клиент оформил самовывоз: три дюрюма, картофель фри и кола.",
        transcript:
          "Assi: Здравствуйте! Доставка или самовывоз?\nUser: Самовывоз с Кулакова.\nAssi: Принял заказ и подтвердил сумму.",
        recordingUrl: "https://example.com/recordings/inbound-success.mp3",
        createdAt: new Date(Date.now() - 35 * 60 * 1000)
      },
      {
        assistantProfileId: inboundProfile.id,
        direction: CallDirection.INBOUND,
        customerPhone: "+79031234567",
        status: CallStatus.ESCALATED,
        durationSeconds: 96,
        summary: "Клиент попросил нестандартный кейтеринг, звонок переведен владельцу.",
        transcript:
          "Assi: Я могу помочь с обычным заказом.\nUser: Нужно на 40 человек завтра.\nAssi: Передаю владельцу для уточнения деталей.",
        recordingUrl: "https://example.com/recordings/inbound-escalated.mp3",
        createdAt: new Date(Date.now() - 180 * 60 * 1000)
      },
      {
        assistantProfileId: outboundProfile.id,
        direction: CallDirection.OUTBOUND,
        customerPhone: "+79261230044",
        status: CallStatus.SUCCESS,
        durationSeconds: 72,
        summary: "Клиент заинтересовался повторным заказом на вечер.",
        transcript:
          "Assi: Здравствуйте! Это Echte Doner, удобно говорить?\nUser: Да.\nAssi: Зафиксировал интерес к повторному заказу.",
        recordingUrl: "https://example.com/recordings/outbound-success.mp3",
        createdAt: new Date(Date.now() - 420 * 60 * 1000)
      }
    ]
  });

  await prisma.outboundContact.createMany({
    data: [
      { userId: user.id, phone: "+79261230044" },
      { userId: user.id, phone: "+79160001122" },
      { userId: user.id, phone: "+79031234567" }
    ],
    skipDuplicates: true
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
