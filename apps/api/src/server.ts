import cors from "cors";
import express from "express";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { startNumberRentalScheduler } from "./lib/number-rental.js";
import { deliverTelegramTranscript } from "./lib/telegram.js";
import { startTelegramDispatcher } from "./lib/telegram-dispatcher.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { billingRouter } from "./routes/billing.js";
import { callLogsRouter } from "./routes/call-logs.js";
import { callsRouter } from "./routes/calls.js";
import { contactNamesRouter } from "./routes/contact-names.js";
import { integrationsRouter } from "./routes/integrations.js";
import { outboundRouter } from "./routes/outbound.js";
import { profilesRouter } from "./routes/profiles.js";
import { drainVoiceCallDeliveries, voiceInternalRouter } from "./routes/voice-internal.js";

const app = express();
const allowedOrigins = new Set(
  env.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY_HOPS);
app.use(securityHeaders);
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, service: "ai-secretary-api" });
});

app.use("/api/admin", adminRouter);
app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api/calls", callsRouter);
app.use("/api/contact-names", contactNamesRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/call-logs", callLogsRouter);
app.use("/api/outbound", outboundRouter);
app.use("/internal/voice", voiceInternalRouter);

app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ message: "Unexpected server error" });
});

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});
const stopNumberRentalScheduler = startNumberRentalScheduler();
const stopTelegramDispatcher = startTelegramDispatcher({ db: prisma, deliver: deliverTelegramTranscript });
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const httpClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  stopNumberRentalScheduler();
  await Promise.all([stopTelegramDispatcher(), httpClosed]);
  await drainVoiceCallDeliveries();
  await prisma.$disconnect();
  process.exit(0);
}

function requestShutdown() {
  void shutdown().catch(async () => {
    console.error("[SHUTDOWN] Graceful shutdown failed");
    try {
      await prisma.$disconnect();
    } catch {
      console.error("[SHUTDOWN] Database disconnect failed");
    }
    process.exit(1);
  });
}

process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);
