import { randomBytes, randomUUID } from "node:crypto";
import type { GoogleAccount } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { encryptSecret } from "../lib/secret-box.js";
import { requireAuth } from "../middleware/require-auth.js";

const integrationsRouter = Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const googleConnectSchema = z.object({
  calendarId: z.string().trim().min(1).max(200).default("primary")
});

const telegramConnectSchema = z.object({
  username: z.string().trim().min(2).max(80).optional(),
  chatId: z.string().trim().min(2).max(80).optional()
});

type GoogleTokenSuccess = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

type GoogleTokenResponse = Partial<GoogleTokenSuccess> & {
  error?: string;
  error_description?: string;
};

type GoogleUserInfoResponse = {
  email?: string;
};

function getGoogleOAuthConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) {
    return null;
  }

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    scopes: env.GOOGLE_CALENDAR_SCOPES.split(/\s+/).filter(Boolean)
  };
}

function publicGoogle(account: GoogleAccount | null | undefined) {
  return {
    status: account?.status ?? "DISCONNECTED",
    googleEmail: account?.googleEmail ?? null,
    calendarId: account?.calendarId ?? null,
    connectedAt: account?.connectedAt ?? null
  };
}

function getGoogleReturnUrl(result: "connected" | "error", reason?: string) {
  const baseUrl = env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN;
  const url = new URL("/dashboard", baseUrl);
  url.searchParams.set("google", result);
  if (reason) {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
}

function buildGoogleAuthUrl(state: string) {
  const config = getGoogleOAuthConfig();
  if (!config) {
    return null;
  }

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");

  return url.toString();
}

async function exchangeGoogleCodeForTokens(code: string) {
  const config = getGoogleOAuthConfig();
  if (!config) {
    throw new Error("Google OAuth is not configured");
  }

  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const payload = (await response.json().catch(() => ({}))) as GoogleTokenResponse;

  if (!response.ok || !payload.access_token) {
    const message = payload.error_description ?? payload.error ?? "Google token exchange failed";
    throw new Error(message);
  }

  return payload as GoogleTokenSuccess;
}

async function fetchGoogleEmail(accessToken: string) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => ({}))) as GoogleUserInfoResponse;
  return typeof payload.email === "string" ? payload.email : null;
}

async function ensureTelegramAccount(userId: string) {
  const existing = await prisma.telegramAccount.findUnique({ where: { userId } });
  if (existing) {
    return existing;
  }

  return prisma.telegramAccount.create({
    data: {
      userId,
      linkToken: randomUUID()
    }
  });
}

function publicTelegram(account: Awaited<ReturnType<typeof ensureTelegramAccount>>) {
  return {
    ...account,
    botLink: `https://t.me/${account.botUsername}?start=${account.linkToken}`
  };
}

integrationsRouter.get("/me", requireAuth, async (req, res) => {
  const [googleAccount, telegramAccount] = await Promise.all([
    prisma.googleAccount.findUnique({ where: { userId: req.user!.userId } }),
    ensureTelegramAccount(req.user!.userId)
  ]);

  res.json({
    integrations: {
      google: publicGoogle(googleAccount),
      telegram: publicTelegram(telegramAccount)
    }
  });
});

integrationsRouter.post("/google/connect", requireAuth, async (req, res) => {
  const parsed = googleConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const state = randomBytes(32).toString("base64url");
  const authUrl = buildGoogleAuthUrl(state);
  if (!authUrl) {
    res.status(503).json({ message: "Google OAuth is not configured" });
    return;
  }

  await prisma.$transaction([
    prisma.googleOAuthState.deleteMany({ where: { userId: req.user!.userId } }),
    prisma.googleOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    prisma.googleOAuthState.create({
      data: {
        userId: req.user!.userId,
        state,
        calendarId: parsed.data.calendarId,
        expiresAt: new Date(Date.now() + GOOGLE_OAUTH_STATE_TTL_MS)
      }
    })
  ]);

  const account = await prisma.googleAccount.findUnique({ where: { userId: req.user!.userId } });

  res.json({
    google: publicGoogle(account),
    authUrl
  });
});

integrationsRouter.get("/google/oauth/callback", async (req, res) => {
  const providerError = typeof req.query.error === "string" ? req.query.error : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;

  if (providerError) {
    console.warn("Google OAuth provider error", { providerError });
    res.redirect(getGoogleReturnUrl("error", "provider"));
    return;
  }

  if (!code || !state) {
    res.redirect(getGoogleReturnUrl("error", "missing_code"));
    return;
  }

  const oauthState = await prisma.googleOAuthState.findUnique({ where: { state } });
  if (!oauthState) {
    res.redirect(getGoogleReturnUrl("error", "state"));
    return;
  }

  if (oauthState.expiresAt < new Date()) {
    await prisma.googleOAuthState.delete({ where: { id: oauthState.id } });
    res.redirect(getGoogleReturnUrl("error", "expired"));
    return;
  }

  try {
    const tokens = await exchangeGoogleCodeForTokens(code);
    const [googleEmail, existingAccount] = await Promise.all([
      fetchGoogleEmail(tokens.access_token),
      prisma.googleAccount.findUnique({ where: { userId: oauthState.userId } })
    ]);
    const refreshToken = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : existingAccount?.refreshToken ?? null;

    if (!refreshToken) {
      throw new Error("Google did not return a refresh token");
    }

    await prisma.$transaction([
      prisma.googleAccount.upsert({
        where: { userId: oauthState.userId },
        update: {
          status: "CONNECTED",
          googleEmail,
          calendarId: oauthState.calendarId,
          accessToken: encryptSecret(tokens.access_token),
          refreshToken,
          tokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
          scope: tokens.scope ?? env.GOOGLE_CALENDAR_SCOPES,
          connectedAt: new Date()
        },
        create: {
          userId: oauthState.userId,
          status: "CONNECTED",
          googleEmail,
          calendarId: oauthState.calendarId,
          accessToken: encryptSecret(tokens.access_token),
          refreshToken,
          tokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
          scope: tokens.scope ?? env.GOOGLE_CALENDAR_SCOPES,
          connectedAt: new Date()
        }
      }),
      prisma.googleOAuthState.deleteMany({ where: { userId: oauthState.userId } })
    ]);

    res.redirect(getGoogleReturnUrl("connected"));
  } catch (error) {
    console.error("Google OAuth callback failed", error);
    await prisma.googleOAuthState.deleteMany({ where: { userId: oauthState.userId } });
    res.redirect(getGoogleReturnUrl("error", "callback"));
  }
});

integrationsRouter.post("/google/disconnect", requireAuth, async (req, res) => {
  const account = await prisma.googleAccount.upsert({
    where: { userId: req.user!.userId },
    update: {
      status: "DISCONNECTED",
      googleEmail: null,
      calendarId: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      scope: null,
      connectedAt: null
    },
    create: {
      userId: req.user!.userId,
      status: "DISCONNECTED"
    }
  });

  await prisma.googleOAuthState.deleteMany({ where: { userId: req.user!.userId } });

  res.json({ google: publicGoogle(account) });
});

integrationsRouter.post("/telegram/link", requireAuth, async (req, res) => {
  const account = await ensureTelegramAccount(req.user!.userId);
  res.json({ telegram: publicTelegram(account) });
});

integrationsRouter.post("/telegram/connect", requireAuth, async (req, res) => {
  const parsed = telegramConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const base = await ensureTelegramAccount(req.user!.userId);
  const account = await prisma.telegramAccount.update({
    where: { id: base.id },
    data: {
      status: "CONNECTED",
      username: parsed.data.username,
      chatId: parsed.data.chatId,
      connectedAt: new Date()
    }
  });

  res.json({ telegram: publicTelegram(account) });
});

integrationsRouter.post("/telegram/disconnect", requireAuth, async (req, res) => {
  const base = await ensureTelegramAccount(req.user!.userId);
  const account = await prisma.telegramAccount.update({
    where: { id: base.id },
    data: {
      status: "DISCONNECTED",
      chatId: null,
      username: null,
      connectedAt: null
    }
  });

  res.json({ telegram: publicTelegram(account) });
});

export { integrationsRouter };
