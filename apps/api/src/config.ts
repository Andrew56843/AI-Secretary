import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalPositiveInt = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : Number(value)),
  z.number().int().positive().optional()
);
const booleanFromEnv = z.preprocess((value) => value === true || value === "true" || value === "1", z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(24).default("change-me-in-production-very-secret"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  MULENPAY_API_KEY: optionalString,
  MULENPAY_SECRET_KEY: optionalString,
  MULENPAY_SHOP_ID: optionalPositiveInt,
  MULENPAY_BASE_URL: z.string().url().default("https://mulenpay.ru/api"),
  MULENPAY_WEBSITE_URL: optionalString,
  MULENPAY_SIGN_WITH_UUID: booleanFromEnv.default(false),
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
