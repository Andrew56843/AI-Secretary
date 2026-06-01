import cors from "cors";
import express from "express";
import { env } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { authRouter } from "./routes/auth.js";
import { callLogsRouter } from "./routes/call-logs.js";
import { profilesRouter } from "./routes/profiles.js";

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, service: "ai-secretary-api" });
});

app.use("/api/auth", authRouter);
app.use("/api/profiles", profilesRouter);
app.use("/api/call-logs", callLogsRouter);

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

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
