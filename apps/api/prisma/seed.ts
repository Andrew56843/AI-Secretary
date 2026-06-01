import { CallStatus, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const STARTING_POOL = [
  "+74950010001",
  "+74950010002",
  "+74950010003",
  "+74950010004",
  "+74950010005",
  "+74950010006"
];

const DEMO_EMAIL = "demo@ai-secretary.local";
const DEMO_PASSWORD = "demo-password";

const DEMO_CALLS = [
  {
    customerPhone: "+79054176285",
    status: CallStatus.SUCCESS,
    durationSeconds: 184,
    summary: "Client ordered pickup: three durum doners, fries, and cola.",
    transcript:
      "Assistant: Hello, Echte Doner. Delivery or pickup?\nUser: Pickup from Kulakova. I need three sets: doner, fries, and cola.\nAssistant: Accepted. Pickup from Kulakova, 29D.",
    recordingUrl: "https://example.com/recordings/demo-success.mp3",
    minutesAgo: 35
  },
  {
    customerPhone: "+79031234567",
    status: CallStatus.ESCALATED,
    durationSeconds: 96,
    summary: "Client asked for a non-standard catering order, assistant escalated to owner.",
    transcript:
      "Assistant: I can help with regular orders.\nUser: We need catering for 40 people tomorrow.\nAssistant: I will transfer you to the owner to confirm details.",
    recordingUrl: "https://example.com/recordings/demo-escalated.mp3",
    minutesAgo: 180
  },
  {
    customerPhone: "+79261230044",
    status: CallStatus.MISSED,
    durationSeconds: 12,
    summary: "Call ended before the customer selected delivery or pickup.",
    transcript: "Assistant: Hello, Echte Doner. Delivery or pickup?\nUser: Hello?\nCall ended.",
    recordingUrl: "https://example.com/recordings/demo-missed.mp3",
    minutesAgo: 420
  },
  {
    customerPhone: "+79160001122",
    status: CallStatus.SUCCESS,
    durationSeconds: 244,
    summary: "Delivery order accepted; assistant requested address and confirmed total.",
    transcript:
      "Assistant: What would you like to order?\nUser: Two doners and a mors.\nAssistant: Total is confirmed. Please tell me the delivery address.",
    recordingUrl: "https://example.com/recordings/demo-delivery.mp3",
    minutesAgo: 980
  }
];

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
    where: { email: DEMO_EMAIL },
    update: {
      fullName: "Demo Founder",
      password
    },
    create: {
      email: DEMO_EMAIL,
      fullName: "Demo Founder",
      password
    }
  });

  const reservedNumber = await prisma.reservedPhoneNumber.upsert({
    where: { number: STARTING_POOL[0]! },
    update: { assigned: true },
    create: {
      number: STARTING_POOL[0]!,
      assigned: true
    }
  });

  const profile = await prisma.assistantProfile.upsert({
    where: { id: "demo-assistant-profile" },
    update: {
      userId: user.id,
      title: "Echte Doner AI Secretary",
      businessName: "Echte Doner",
      prompt:
        "You are an AI phone secretary for Echte Doner. Accept delivery and pickup orders, clarify menu items, confirm totals, and escalate to the owner when the request is outside the normal flow.",
      forwardingPhone: "+79054176285",
      reservedNumberId: reservedNumber.id,
      status: "ACTIVE"
    },
    create: {
      id: "demo-assistant-profile",
      userId: user.id,
      title: "Echte Doner AI Secretary",
      businessName: "Echte Doner",
      prompt:
        "You are an AI phone secretary for Echte Doner. Accept delivery and pickup orders, clarify menu items, confirm totals, and escalate to the owner when the request is outside the normal flow.",
      forwardingPhone: "+79054176285",
      reservedNumberId: reservedNumber.id,
      status: "ACTIVE"
    }
  });

  await prisma.callLog.deleteMany({
    where: { assistantProfileId: profile.id }
  });

  await prisma.callLog.createMany({
    data: DEMO_CALLS.map((call) => ({
      assistantProfileId: profile.id,
      customerPhone: call.customerPhone,
      status: call.status,
      durationSeconds: call.durationSeconds,
      summary: call.summary,
      transcript: call.transcript,
      recordingUrl: call.recordingUrl,
      createdAt: new Date(Date.now() - call.minutesAgo * 60 * 1000)
    }))
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
