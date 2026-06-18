import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24).default("change-me-in-production-very-secret"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_PROXY_URL: optionalString,
  SOCKS_PROXY_URL: optionalString,
  PUBLIC_WEB_URL: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString,
  GOOGLE_CALENDAR_SCOPES: z
    .string()
    .trim()
    .min(1)
    .default("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email"),
  PROMPT_EDITOR_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  CALL_RECORDINGS_ROOT: z.string().trim().min(1).default("/home/andrew/ai/records"),
  PHONE_VERIFICATION_CALL_NUMBER: z.string().trim().min(1).default("+79952225212"),
  PHONE_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  TELEGRAM_BOT_TOKEN: optionalString,
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
