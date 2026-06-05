import { CallDirection, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { OpenAiRequestError, postOpenAiJson } from "../lib/openai.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/require-auth.js";

const profilesRouter = Router();

const modeParamSchema = z.enum(["inbound", "outbound"]).transform((value) =>
  value === "inbound" ? CallDirection.INBOUND : CallDirection.OUTBOUND
);

const realtimeModelSchema = z.enum(["gpt-realtime-mini", "gpt-realtime-2"]);
const voiceSchema = z.enum(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);

const updateProfileSchema = z.object({
  title: z.string().trim().min(2).max(100),
  businessName: z.string().trim().max(120).optional(),
  prompt: z.string().trim().min(20).max(6000),
  greetingText: z.string().trim().min(4).max(600),
  forwardingEnabled: z.boolean().optional(),
  forwardingOnComplete: z.boolean().optional(),
  forwardingOnStalemate: z.boolean().optional(),
  realtimeModel: realtimeModelSchema.optional(),
  voice: voiceSchema.optional(),
  maxDialogSeconds: z.number().int().min(15).max(600)
});

const updateForwardingSchema = z.object({
  forwardingEnabled: z.boolean()
});

const promptEditHistoryItemSchema = z.object({
  command: z.string().trim().min(1).max(1200),
  beforePrompt: z.string().trim().max(6000).optional(),
  afterPrompt: z.string().trim().min(1).max(6000)
});

const applyPromptEditSchema = z.object({
  mode: z.enum(["inbound", "outbound"]).transform((value) =>
    value === "inbound" ? CallDirection.INBOUND : CallDirection.OUTBOUND
  ),
  title: z.string().trim().max(100).optional(),
  businessName: z.string().trim().max(120).optional(),
  currentPrompt: z.string().trim().max(6000),
  command: z.string().trim().min(1).max(1200),
  history: z.array(promptEditHistoryItemSchema).max(12).default([])
});

const promptEditorResponseSchema = z.object({
  updatedPrompt: z.string().trim().min(20).max(6000)
});

const openAiChatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional()
        })
      })
    )
    .min(1)
});

function includeProfileRelations() {
  return {
    reservedNumber: true,
    _count: {
      select: { callLogs: true }
    }
  } satisfies Prisma.AssistantProfileInclude;
}

function buildPromptEditorRequest(payload: z.infer<typeof applyPromptEditSchema>) {
  const history = payload.history.slice(-8).map((item) => ({
    command: item.command,
    beforePrompt: item.beforePrompt,
    afterPrompt: item.afterPrompt
  }));

  return {
    model: env.PROMPT_EDITOR_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Ты редактор промптов для AI-секретаря.",
          "На входе есть текущий промпт, новая команда пользователя и история прошлых команд этой страницы.",
          "Считай новую команду продолжением истории. Например, если раньше просили сделать тон мягче, команда 'ещё мягче' усиливает именно это изменение.",
          "Верни обновлённый рабочий промпт целиком, а не патч и не объяснение.",
          "Сохраняй важные факты, ограничения, цены, адреса, телефоны и правила, если новая команда явно не просит их изменить.",
          "Не добавляй markdown, комментарии и пояснения.",
          "Ответь строго JSON-объектом вида {\"updatedPrompt\":\"...\"}."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          mode: payload.mode,
          title: payload.title ?? "",
          businessName: payload.businessName ?? "",
          currentPrompt: payload.currentPrompt,
          command: payload.command,
          history
        })
      }
    ]
  };
}

function resolveForwardingRules(
  payload: {
    forwardingEnabled?: boolean;
    forwardingOnComplete?: boolean;
    forwardingOnStalemate?: boolean;
  },
  existing?: {
    forwardingEnabled: boolean;
    forwardingOnComplete: boolean;
    forwardingOnStalemate: boolean;
  }
) {
  const fallbackEnabled = payload.forwardingEnabled ?? existing?.forwardingEnabled ?? true;
  const forwardingOnComplete = payload.forwardingOnComplete ?? existing?.forwardingOnComplete ?? fallbackEnabled;
  const forwardingOnStalemate = payload.forwardingOnStalemate ?? existing?.forwardingOnStalemate ?? fallbackEnabled;

  return {
    forwardingEnabled: forwardingOnComplete || forwardingOnStalemate,
    forwardingOnComplete,
    forwardingOnStalemate
  };
}

profilesRouter.post("/prompt/apply", requireAuth, async (req, res) => {
  const parsed = applyPromptEditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  try {
    const completion = await postOpenAiJson("/chat/completions", buildPromptEditorRequest(parsed.data));
    const parsedCompletion = openAiChatCompletionSchema.safeParse(completion);
    const content = parsedCompletion.success ? parsedCompletion.data.choices[0]?.message.content : null;

    if (!content) {
      res.status(502).json({ message: "OpenAI не вернул обновлённый промпт" });
      return;
    }

    const result = promptEditorResponseSchema.safeParse(JSON.parse(content));
    if (!result.success) {
      res.status(502).json({ message: "OpenAI вернул некорректный промпт" });
      return;
    }

    res.json({ updatedPrompt: result.data.updatedPrompt });
  } catch (error) {
    if (error instanceof SyntaxError) {
      res.status(502).json({ message: "OpenAI вернул некорректный JSON" });
      return;
    }

    if (error instanceof OpenAiRequestError) {
      if (error.status === 503) {
        res.status(503).json({ message: "OPENAI_API_KEY не настроен для API сайта" });
        return;
      }

      console.error("Prompt editor OpenAI error", {
        status: error.status,
        error: error.payload?.error
      });
      res.status(502).json({ message: "Не удалось применить команду к промпту" });
      return;
    }

    throw error;
  }
});

profilesRouter.get("/numbers/free", requireAuth, async (_req, res) => {
  const numbers = await prisma.reservedPhoneNumber.findMany({
    where: { assigned: false },
    orderBy: { number: "asc" },
    take: 50
  });

  res.json({ numbers });
});

profilesRouter.get("/me", requireAuth, async (req, res) => {
  const profiles = await prisma.assistantProfile.findMany({
    where: { userId: req.user!.userId },
    include: includeProfileRelations(),
    orderBy: { mode: "asc" }
  });

  res.json({
    profiles: {
      inbound: profiles.find((profile) => profile.mode === CallDirection.INBOUND) ?? null,
      outbound: profiles.find((profile) => profile.mode === CallDirection.OUTBOUND) ?? null
    }
  });
});

profilesRouter.put("/:mode/forwarding", requireAuth, async (req, res) => {
  const parsedMode = modeParamSchema.safeParse(req.params.mode);
  if (!parsedMode.success) {
    res.status(404).json({ message: "Profile mode not found" });
    return;
  }

  const parsed = updateForwardingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const profile = await prisma.assistantProfile.update({
    where: {
      userId_mode: {
        userId: req.user!.userId,
        mode: parsedMode.data
      }
    },
    data: {
      forwardingEnabled: parsed.data.forwardingEnabled,
      forwardingOnComplete: parsed.data.forwardingEnabled,
      forwardingOnStalemate: parsed.data.forwardingEnabled,
      forwardingPhone: req.user!.phone
    },
    include: includeProfileRelations()
  });

  res.json({ profile });
});

profilesRouter.put("/:mode", requireAuth, async (req, res) => {
  const parsedMode = modeParamSchema.safeParse(req.params.mode);
  if (!parsedMode.success) {
    res.status(404).json({ message: "Profile mode not found" });
    return;
  }

  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }

  const mode = parsedMode.data;
  const payload = parsed.data;
  const userId = req.user!.userId;

  try {
    const profile = await prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const existing = await tx.assistantProfile.findUnique({
          where: { userId_mode: { userId, mode } }
        });

        if (!existing) {
          const forwardingRules = resolveForwardingRules(payload);

          return tx.assistantProfile.create({
            data: {
              userId,
              mode,
              title: payload.title,
              businessName: payload.businessName,
              prompt: payload.prompt,
              greetingText: payload.greetingText,
              forwardingPhone: user.phone,
              ...forwardingRules,
              realtimeModel: payload.realtimeModel ?? "gpt-realtime-2",
              voice: payload.voice ?? "alloy",
              maxDialogSeconds: payload.maxDialogSeconds
            },
            include: includeProfileRelations()
          });
        }

        const forwardingRules = resolveForwardingRules(payload, existing);

        return tx.assistantProfile.update({
          where: { id: existing.id },
          data: {
            title: payload.title,
            businessName: payload.businessName,
            prompt: payload.prompt,
            greetingText: payload.greetingText,
            forwardingPhone: user.phone,
            ...forwardingRules,
            ...(payload.realtimeModel !== undefined ? { realtimeModel: payload.realtimeModel } : {}),
            ...(payload.voice !== undefined ? { voice: payload.voice } : {}),
            maxDialogSeconds: payload.maxDialogSeconds
          },
          include: includeProfileRelations()
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.json({ profile });
  } catch (error) {
    throw error;
  }
});

export { profilesRouter };
