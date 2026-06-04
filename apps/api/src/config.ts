import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24).default("change-me-in-production-very-secret"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  VOICE_SERVICE_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(24).optional()
  )
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment config", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
