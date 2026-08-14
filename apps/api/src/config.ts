import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const booleanString = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() === "true" : value),
  z.boolean()
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: optionalString,
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  PUBLIC_WEB_URL: optionalString,
  ADMIN_PHONES: optionalString,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  RATE_LIMIT_ENABLED: booleanString.default(true),
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_PROXY_URL: optionalString,
  SOCKS_PROXY_URL: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString,
  GOOGLE_CALENDAR_SCOPES: z
    .string()
    .trim()
    .min(1)
    .default("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email"),
  PROMPT_EDITOR_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
  OPENAI_TTS_MODEL: z.string().trim().min(1).default("gpt-4o-mini-tts"),
  CALL_RECORDINGS_ROOT: z.string().trim().min(1).default("/home/andrew/ai/records"),
  PHONE_VERIFICATION_CALL_NUMBER: z.string().trim().min(1).default("+79952225212"),
  PHONE_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_PROXY_URL: optionalString,
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

if (parsed.data.NODE_ENV === "production") {
  const productionErrors: string[] = [];
  const normalizedSecret = parsed.data.JWT_SECRET.toLowerCase();

  if (normalizedSecret.includes("change-me") || normalizedSecret.includes("replace-with")) {
    productionErrors.push("JWT_SECRET must not use an example value");
  }
  if (!parsed.data.VOICE_SERVICE_TOKEN) {
    productionErrors.push("VOICE_SERVICE_TOKEN is required");
  }
  if (!parsed.data.DATA_ENCRYPTION_KEY || parsed.data.DATA_ENCRYPTION_KEY.length < 32) {
    productionErrors.push("DATA_ENCRYPTION_KEY with at least 32 characters is required");
  } else if (/change-me|replace-with/i.test(parsed.data.DATA_ENCRYPTION_KEY)) {
    productionErrors.push("DATA_ENCRYPTION_KEY must not use an example value");
  }
  if (!parsed.data.PUBLIC_WEB_URL) {
    productionErrors.push("PUBLIC_WEB_URL is required");
  }
  if (parsed.data.CORS_ORIGIN.split(",").some((origin) => /localhost|127\.0\.0\.1/i.test(origin))) {
    productionErrors.push("CORS_ORIGIN must not contain localhost in production");
  }

  if (productionErrors.length > 0) {
    console.error("Unsafe production environment config", productionErrors);
    process.exit(1);
  }
}

export const env = parsed.data;
