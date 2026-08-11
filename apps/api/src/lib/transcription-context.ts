import { CallDirection } from "@prisma/client";

const TRANSCRIPTION_PROMPT_MAX_LENGTH = 1024;
const TRANSCRIPTION_VOCABULARY_MAX_LENGTH = 680;

const STOP_WORDS = new Set([
  "ассистент",
  "будет",
  "говорить",
  "должен",
  "звонка",
  "звонки",
  "звонок",
  "клиент",
  "клиента",
  "который",
  "можно",
  "нужно",
  "ответ",
  "ответить",
  "после",
  "пользователь",
  "попросить",
  "сказать",
  "сценарий",
  "только",
  "человек",
  "чтобы",
  "если",
  "когда",
  "какой",
  "которая",
  "которые",
  "этого",
  "этот",
  "также",
  "сейчас",
  "уточнить",
  "спросить",
  "перевести",
  "владелец",
  "владельцу"
]);

type TranscriptionProfile = {
  mode: CallDirection;
  title: string;
  businessName: string | null;
  prompt: string;
};

type HintCandidate = {
  key: string;
  value: string;
  count: number;
  firstIndex: number;
  score: number;
};

function compactText(value: string | null | undefined, maxLength: number) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function candidateScore(value: string) {
  let score = 0;
  if (/\d/u.test(value)) score += 7;
  if (/^\p{Lu}/u.test(value)) score += 3;
  if (/^\p{Lu}{2,}$/u.test(value)) score += 2;
  if (value.includes("-")) score += 2;
  if (value.length >= 7) score += 1;
  return score;
}

export function extractTranscriptionHints(value: string | null | undefined, maxItems = 56) {
  const source = compactText(value, 6000);
  const matches = source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu);
  const candidates = new Map<string, HintCandidate>();

  for (const match of matches) {
    const word = match[0];
    const key = word.toLocaleLowerCase("ru-RU");
    const isNumber = /^\d+$/u.test(word);
    if (STOP_WORDS.has(key) || (!isNumber && word.length < 3)) continue;

    const existing = candidates.get(key);
    if (existing) {
      existing.count += 1;
      existing.score += 2;
      continue;
    }

    candidates.set(key, {
      key,
      value: word,
      count: 1,
      firstIndex: match.index,
      score: candidateScore(word)
    });
  }

  const ranked = [...candidates.values()].sort(
    (left, right) => right.score - left.score || left.firstIndex - right.firstIndex
  );
  const selected: string[] = [];
  let length = 0;

  for (const candidate of ranked) {
    const extraLength = candidate.value.length + (selected.length > 0 ? 2 : 0);
    if (selected.length >= maxItems || length + extraLength > TRANSCRIPTION_VOCABULARY_MAX_LENGTH) break;
    selected.push(candidate.value);
    length += extraLength;
  }

  return selected.join(", ");
}

export function createProfileTranscriptionPrompt(profile: TranscriptionProfile) {
  const businessName = compactText(profile.businessName, 160);
  const title = compactText(profile.title, 160);
  const vocabulary = extractTranscriptionHints(profile.prompt);
  const prompt = [
    "Русский телефонный разговор с AI-секретарём.",
    profile.mode === CallDirection.OUTBOUND
      ? "Тип звонка: исходящий звонок от AI-секретаря клиенту."
      : "Тип звонка: входящий звонок клиента AI-секретарю.",
    businessName ? `Компания или проект: ${businessName}.` : "",
    title ? `Название сценария: ${title}.` : "",
    "Записывай только слова из аудио, ничего не дописывай из контекста.",
    vocabulary ? `Возможные имена, числа и специальные термины: ${vocabulary}.` : ""
  ]
    .filter(Boolean)
    .join("\n");

  if (prompt.length <= TRANSCRIPTION_PROMPT_MAX_LENGTH) return prompt;
  return `${prompt.slice(0, TRANSCRIPTION_PROMPT_MAX_LENGTH - 3).trimEnd()}...`;
}
