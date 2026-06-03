import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  changePassword,
  connectGoogleCalendar,
  connectTelegram,
  createSiteCall,
  deleteOutboundContact,
  disconnectGoogleCalendar,
  disconnectTelegram,
  getBilling,
  getBillingCharges,
  getCallLogs,
  getContactNames,
  getIntegrations,
  getMyProfiles,
  getOutboundContacts,
  importOutboundContacts,
  rentPhoneNumber,
  saveContactName,
  saveProfile,
  topUpBalance
} from "../lib/api";
import type {
  AssistantProfile,
  AuthUser,
  BillingPagination,
  BillingState,
  BillingTransaction,
  CallLog,
  CallLogsPagination,
  IntegrationsState,
  OutboundContact,
  OutboundPagination,
  OutboundStats,
  PhoneContactName,
  ProfilesByMode,
  RealtimeModel,
  RealtimeVoice,
  UiMode
} from "../types";

type DashboardProps = {
  token: string;
  user: AuthUser;
  onLogout: () => void;
};

type ProfileForm = {
  title: string;
  businessName: string;
  promptRequest: string;
  prompt: string;
  greetingText: string;
  forwardingEnabled: boolean;
  forwardingOnComplete: boolean;
  forwardingOnStalemate: boolean;
  realtimeModel: RealtimeModel;
  voice: RealtimeVoice;
  maxDialogSeconds: number;
};

type RealtimeModelOption = {
  value: RealtimeModel;
  title: string;
  badge: string;
  inboundRateRubPerMinute: number;
  outboundRateRubPerMinute: number;
  description: string;
};

type VoiceOption = {
  value: RealtimeVoice;
  title: string;
  description: string;
  previewRate: number;
  previewPitch: number;
};

type ScenarioTemplateId = "dentist" | "barber" | "tutor" | "auto" | "beauty" | "custom";

type ScenarioTemplate = {
  id: ScenarioTemplateId;
  title: string;
  description: string;
  inboundPrompt: string;
  outboundPrompt: string;
  inboundGreeting: string;
  outboundGreeting: string;
};

const MODE_LABEL: Record<UiMode, string> = {
  inbound: "Входящие звонки",
  outbound: "Исходящие звонки"
};

const DEFAULT_STATS: OutboundStats = {
  total: 0,
  pending: 0
};

const OUTBOUND_CONTACTS_PAGE_SIZE = 5;
const BILLING_HISTORY_PAGE_SIZE = 5;
const CALL_LOGS_PAGE_SIZE = 4;

const REALTIME_MODEL_OPTIONS: RealtimeModelOption[] = [
  {
    value: "gpt-realtime-mini",
    title: "gpt-realtime-mini",
    badge: "Дешевле",
    inboundRateRubPerMinute: 5,
    outboundRateRubPerMinute: 7,
    description: "Экономичная модель для простых звонков и массового обзвона."
  },
  {
    value: "gpt-realtime-2",
    title: "gpt-realtime-2",
    badge: "Дороже",
    inboundRateRubPerMinute: 10,
    outboundRateRubPerMinute: 12,
    description: "Основная модель по умолчанию для более живых и ответственных диалогов."
  }
];

const VOICE_OPTIONS: VoiceOption[] = [
  {
    value: "alloy",
    title: "Alloy",
    description: "Нейтральный и ровный",
    previewRate: 1,
    previewPitch: 1
  },
  {
    value: "ash",
    title: "Ash",
    description: "Сдержанный и уверенный",
    previewRate: 0.96,
    previewPitch: 0.92
  },
  {
    value: "ballad",
    title: "Ballad",
    description: "Мягкий и плавный",
    previewRate: 0.92,
    previewPitch: 1.04
  },
  {
    value: "coral",
    title: "Coral",
    description: "Теплый и дружелюбный",
    previewRate: 1.02,
    previewPitch: 1.08
  },
  {
    value: "echo",
    title: "Echo",
    description: "Четкий и деловой",
    previewRate: 1.04,
    previewPitch: 0.96
  },
  {
    value: "sage",
    title: "Sage",
    description: "Спокойный и взрослый",
    previewRate: 0.94,
    previewPitch: 0.9
  },
  {
    value: "shimmer",
    title: "Shimmer",
    description: "Легкий и приветливый",
    previewRate: 1.06,
    previewPitch: 1.12
  },
  {
    value: "verse",
    title: "Verse",
    description: "Выразительный и живой",
    previewRate: 1.02,
    previewPitch: 1.02
  },
  {
    value: "marin",
    title: "Marin",
    description: "Спокойный сервисный тон",
    previewRate: 0.98,
    previewPitch: 0.98
  },
  {
    value: "cedar",
    title: "Cedar",
    description: "Низкий и уверенный",
    previewRate: 0.9,
    previewPitch: 0.86
  }
];

const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: "dentist",
    title: "Для стоматолога",
    description: "Запись, перенос визита, первичная консультация.",
    inboundPrompt:
      "Ты ИИ-секретарь стоматологической клиники. Отвечай на входящие звонки, уточняй имя пациента, причину обращения, желаемую дату и время приема. Можешь предложить запись, перенос или отмену визита. Если пациент описывает острую боль, травму, сложный медицинский вопрос или спорную ситуацию, переведи звонок владельцу аккаунта.",
    outboundPrompt:
      "Ты ИИ-секретарь стоматологической клиники для исходящих звонков. Вежливо напомни пациенту о записи, уточни подтверждение визита или удобное время для переноса. Говори коротко, фиксируй результат разговора и заверши диалог спокойно.",
    inboundGreeting: "Здравствуйте! Я ИИ-секретарь стоматологии. Хотите записаться, перенести визит или уточнить вопрос?",
    outboundGreeting: "Здравствуйте! Я ИИ-секретарь стоматологии, уточню запись на прием. Вам удобно говорить?"
  },
  {
    id: "barber",
    title: "Для парикмахера",
    description: "Запись на услуги, мастер, время, перенос.",
    inboundPrompt:
      "Ты ИИ-секретарь парикмахера или салона. Отвечай на входящие звонки, уточняй услугу, желаемого мастера, дату, время, имя клиента и контактный номер. Если клиент просит нестандартную услугу, сложное окрашивание или срочное окно вне расписания, переведи звонок владельцу аккаунта.",
    outboundPrompt:
      "Ты ИИ-секретарь салона для исходящих звонков. Напомни клиенту о записи, уточни подтверждение или перенос, говори дружелюбно и коротко. Зафиксируй итог разговора.",
    inboundGreeting: "Здравствуйте! Я ИИ-секретарь салона. На какую услугу хотите записаться?",
    outboundGreeting: "Здравствуйте! Я ИИ-секретарь салона, хочу уточнить вашу запись. Вам удобно говорить?"
  },
  {
    id: "tutor",
    title: "Для репетитора",
    description: "Заявки, предмет, класс, формат занятий.",
    inboundPrompt:
      "Ты ИИ-секретарь репетитора. Уточняй предмет, класс или уровень ученика, цель занятий, удобный формат, дни и время. Если родитель или ученик задает вопрос о цене, программе, подготовке к экзамену или нестандартном формате, собери детали и при необходимости переведи звонок владельцу аккаунта.",
    outboundPrompt:
      "Ты ИИ-секретарь репетитора для исходящих звонков. Свяжись с клиентом по заявке, уточни предмет, уровень ученика, цель и удобное время для первого занятия. Зафиксируй результат разговора.",
    inboundGreeting: "Здравствуйте! Я ИИ-секретарь репетитора. По какому предмету и для какого класса нужны занятия?",
    outboundGreeting: "Здравствуйте! Я ИИ-секретарь репетитора, звоню по заявке на занятия. Вам удобно говорить?"
  },
  {
    id: "auto",
    title: "Для автосервиса",
    description: "Запись на диагностику, ремонт, уточнение авто.",
    inboundPrompt:
      "Ты ИИ-секретарь автосервиса. Уточняй марку и модель автомобиля, проблему, желаемую дату визита, имя клиента и номер для связи. Если клиент описывает аварийную ситуацию, сложный ремонт, гарантийный спор или просит точную стоимость без диагностики, переведи звонок владельцу аккаунта.",
    outboundPrompt:
      "Ты ИИ-секретарь автосервиса для исходящих звонков. Уточни заявку клиента, автомобиль, проблему и удобное время визита. Говори по делу и фиксируй результат.",
    inboundGreeting: "Здравствуйте! Я ИИ-секретарь автосервиса. Что случилось с автомобилем?",
    outboundGreeting: "Здравствуйте! Я ИИ-секретарь автосервиса, звоню по вашей заявке. Вам удобно говорить?"
  },
  {
    id: "beauty",
    title: "Для мастера услуг",
    description: "Маникюр, массаж, косметология, частная практика.",
    inboundPrompt:
      "Ты ИИ-секретарь частного мастера услуг. Уточняй услугу, желаемую дату и время, имя клиента, контактный номер и важные пожелания. Если клиент просит медицинский совет, нестандартную услугу, срочную запись или условия вне обычного сценария, переведи звонок владельцу аккаунта.",
    outboundPrompt:
      "Ты ИИ-секретарь частного мастера для исходящих звонков. Напомни клиенту о записи или уточни заявку, предложи подтвердить или перенести время. Говори коротко и доброжелательно.",
    inboundGreeting: "Здравствуйте! Я ИИ-секретарь мастера. На какую услугу хотите записаться?",
    outboundGreeting: "Здравствуйте! Я ИИ-секретарь мастера, хочу уточнить вашу запись. Вам удобно говорить?"
  }
];

const DEFAULT_OUTBOUND_PAGINATION: OutboundPagination = {
  page: 1,
  pageSize: OUTBOUND_CONTACTS_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasPreviousPage: false,
  hasNextPage: false
};

const DEFAULT_BILLING_PAGINATION: BillingPagination = {
  page: 1,
  pageSize: BILLING_HISTORY_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasPreviousPage: false,
  hasNextPage: false
};

const DEFAULT_CALL_LOGS_PAGINATION: CallLogsPagination = {
  page: 1,
  pageSize: CALL_LOGS_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasPreviousPage: false,
  hasNextPage: false
};

function TelegramIcon() {
  return (
    <svg aria-hidden="true" className="integration-icon telegram-icon" viewBox="0 0 24 24">
      <path d="M21.7 3.8 18.3 20c-.3 1.1-.9 1.4-1.8.9l-5.1-3.8-2.5 2.4c-.3.3-.5.5-1 .5l.4-5.2 9.5-8.6c.4-.4-.1-.6-.6-.2L5.4 13.4.3 11.8c-1.1-.3-1.1-1.1.2-1.6L20.3 2.6c.9-.3 1.7.2 1.4 1.2Z" />
    </svg>
  );
}

function GoogleCalendarIcon() {
  return (
    <svg aria-hidden="true" className="integration-icon google-calendar-icon" viewBox="0 0 24 24">
      <path className="gcal-blue" d="M5 3h14a2 2 0 0 1 2 2v4H3V5a2 2 0 0 1 2-2Z" />
      <path className="gcal-green" d="M3 9h6v12H5a2 2 0 0 1-2-2V9Z" />
      <path className="gcal-yellow" d="M9 9h12v5H9V9Z" />
      <path className="gcal-red" d="M9 14h12v5a2 2 0 0 1-2 2H9v-7Z" />
      <path className="gcal-page" d="M7 6h10v3H7V6Zm4.2 12v-1.4h1.4V11h-1.3l-1.7 1.1v1.5l1.5-1v4h-1.7V18h4.8v-1.4h-1.6V10h-1.4Z" />
    </svg>
  );
}

function VideoInstructionIcon() {
  return (
    <svg aria-hidden="true" className="topbar-icon" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.8v6.4l5.2-3.2L10 8.8Z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" className="topbar-icon" viewBox="0 0 24 24">
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <path d="M4 12h3" />
      <path d="M11 12h9" />
      <path d="M4 17h12" />
      <path d="M20 17h0" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="18" cy="17" r="2" />
    </svg>
  );
}

function defaultForm(mode: UiMode): ProfileForm {
  return {
    title: MODE_LABEL[mode],
    businessName: "",
    promptRequest: "",
    prompt: "",
    greetingText: "",
    forwardingEnabled: true,
    forwardingOnComplete: true,
    forwardingOnStalemate: true,
    realtimeModel: "gpt-realtime-2",
    voice: "alloy",
    maxDialogSeconds: mode === "inbound" ? 120 : 90
  };
}

function formFromProfile(profile: AssistantProfile | null, mode: UiMode): ProfileForm {
  if (!profile) {
    return defaultForm(mode);
  }

  return {
    title: profile.title,
    businessName: profile.businessName ?? "",
    promptRequest: "",
    prompt: profile.prompt,
    greetingText: profile.greetingText,
    forwardingEnabled: profile.forwardingEnabled ?? true,
    forwardingOnComplete: profile.forwardingOnComplete ?? profile.forwardingEnabled ?? true,
    forwardingOnStalemate: profile.forwardingOnStalemate ?? profile.forwardingEnabled ?? true,
    realtimeModel: profile.realtimeModel ?? "gpt-realtime-2",
    voice: profile.voice ?? "alloy",
    maxDialogSeconds: profile.maxDialogSeconds
  };
}

function comparableProfileForm(form: ProfileForm) {
  return {
    title: form.title,
    businessName: form.businessName,
    prompt: form.prompt,
    greetingText: form.greetingText,
    forwardingEnabled: form.forwardingOnComplete || form.forwardingOnStalemate,
    forwardingOnComplete: form.forwardingOnComplete,
    forwardingOnStalemate: form.forwardingOnStalemate,
    realtimeModel: form.realtimeModel,
    voice: form.voice,
    maxDialogSeconds: form.maxDialogSeconds
  };
}

function hasSavedScenarioChanges(form: ProfileForm, profile: AssistantProfile | null, mode: UiMode) {
  return JSON.stringify(comparableProfileForm(form)) !== JSON.stringify(comparableProfileForm(formFromProfile(profile, mode)));
}

function formatStatus(status: CallLog["status"] | OutboundContact["status"]) {
  const labels: Record<string, string> = {
    SUCCESS: "Успешно",
    ESCALATED: "Перевод",
    MISSED: "Пропущен",
    PENDING: "Ожидает",
    CALLED: "Обзвонен",
    FAILED: "Ошибка"
  };

  return labels[status] ?? status;
}

function formatRubles(amount: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(amount);
}

function getModelRateForMode(option: RealtimeModelOption, mode: UiMode) {
  return mode === "inbound" ? option.inboundRateRubPerMinute : option.outboundRateRubPerMinute;
}

function formatSeconds(seconds: number) {
  const absoluteSeconds = Math.abs(seconds);
  const minutes = Math.floor(absoluteSeconds / 60);
  const restSeconds = absoluteSeconds % 60;

  if (minutes === 0) {
    return `${restSeconds} сек`;
  }

  return restSeconds === 0 ? `${minutes} мин` : `${minutes} мин ${restSeconds} сек`;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleDateString("ru-RU");
}

function formatDaysLeft(daysLeft: number | null | undefined) {
  if (daysLeft === null || daysLeft === undefined) {
    return null;
  }

  if (daysLeft <= 0) {
    return "срок аренды истек";
  }

  return `${daysLeft} дн.`;
}

function formatBillingTitle(transaction: BillingTransaction) {
  if (transaction.type === "CALL_CHARGE") {
    return "Списание за звонок";
  }

  if (transaction.type === "TOP_UP") {
    return "Пополнение баланса";
  }

  if (transaction.type === "NUMBER_PURCHASE") {
    return "Резервация номера";
  }

  return "Стартовый лимит";
}

function contactMapFromList(contacts: PhoneContactName[]) {
  return contacts.reduce<Record<string, string>>((acc, contact) => {
    acc[contact.phone] = contact.name;
    return acc;
  }, {});
}

function renderTranscript(transcript: string) {
  return (
    <div className="transcript-box">
      {transcript.split("\n").map((line, index) => {
        const isUserLine = /^\s*(User|Пользователь|Клиент):/i.test(line);

        return (
          <div className={isUserLine ? "transcript-line user-line" : "transcript-line"} key={`${line}-${index}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

export function DashboardPage({ token, user, onLogout }: DashboardProps) {
  const [activeMode, setActiveMode] = useState<UiMode>("inbound");
  const [profiles, setProfiles] = useState<ProfilesByMode>({ inbound: null, outbound: null });
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [billingHistoryOpen, setBillingHistoryOpen] = useState(false);
  const [billingHistory, setBillingHistory] = useState<BillingTransaction[]>([]);
  const [billingHistoryPagination, setBillingHistoryPagination] = useState<BillingPagination>(DEFAULT_BILLING_PAGINATION);
  const [billingHistoryLoading, setBillingHistoryLoading] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationsState | null>(null);
  const [logsByMode, setLogsByMode] = useState<Record<UiMode, CallLog[]>>({ inbound: [], outbound: [] });
  const [logsPaginationByMode, setLogsPaginationByMode] = useState<Record<UiMode, CallLogsPagination>>({
    inbound: DEFAULT_CALL_LOGS_PAGINATION,
    outbound: DEFAULT_CALL_LOGS_PAGINATION
  });
  const [logsPageLoading, setLogsPageLoading] = useState(false);
  const [contacts, setContacts] = useState<OutboundContact[]>([]);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<OutboundStats>(DEFAULT_STATS);
  const [outboundPagination, setOutboundPagination] = useState<OutboundPagination>(DEFAULT_OUTBOUND_PAGINATION);
  const [outboundPageLoading, setOutboundPageLoading] = useState(false);
  const [rawNumbers, setRawNumbers] = useState("+79160001122, +79261230044 +79031234567");
  const [newPassword, setNewPassword] = useState("");
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [accessModalOpen, setAccessModalOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [contactNameModal, setContactNameModal] = useState<{ phone: string } | null>(null);
  const [contactNameDraft, setContactNameDraft] = useState("");
  const [templatePickerDismissed, setTemplatePickerDismissed] = useState<Record<UiMode, boolean>>({
    inbound: false,
    outbound: false
  });
  const [templatePickerOpen, setTemplatePickerOpen] = useState<Record<UiMode, boolean>>({
    inbound: false,
    outbound: false
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topUpSaving, setTopUpSaving] = useState(false);
  const [numberRentalSaving, setNumberRentalSaving] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("1000");
  const [previewingVoice, setPreviewingVoice] = useState<RealtimeVoice | null>(null);
  const [form, setForm] = useState<ProfileForm>(() => defaultForm("inbound"));

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        setLoading(true);
        const [
          profilesResult,
          billingResult,
          integrationsResult,
          inboundLogs,
          outboundLogs,
          outboundResult,
          contactNamesResult
        ] = await Promise.all([
          getMyProfiles(token),
          getBilling(token),
          getIntegrations(token),
          getCallLogs(token, "inbound", { page: 1, pageSize: CALL_LOGS_PAGE_SIZE }),
          getCallLogs(token, "outbound", { page: 1, pageSize: CALL_LOGS_PAGE_SIZE }),
          getOutboundContacts(token, { page: 1, pageSize: OUTBOUND_CONTACTS_PAGE_SIZE }),
          getContactNames(token)
        ]);

        if (!isMounted) {
          return;
        }

        setProfiles(profilesResult.profiles);
        setBilling(billingResult.billing);
        setIntegrations(integrationsResult.integrations);
        setLogsByMode({ inbound: inboundLogs.logs, outbound: outboundLogs.logs });
        setLogsPaginationByMode({ inbound: inboundLogs.pagination, outbound: outboundLogs.pagination });
        setContacts(outboundResult.contacts);
        setStats(outboundResult.stats);
        setOutboundPagination(outboundResult.pagination);
        setContactNames(contactMapFromList(contactNamesResult.contacts));
        setForm(formFromProfile(profilesResult.profiles.inbound, "inbound"));
      } catch (bootstrapError) {
        if (isMounted) {
          setError(bootstrapError instanceof Error ? bootstrapError.message : "Не удалось загрузить кабинет");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    bootstrap();
    return () => {
      isMounted = false;
    };
  }, [token]);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const activeProfile = profiles[activeMode];
  const activeLogsPagination = logsPaginationByMode[activeMode];
  const reservedNumber = billing?.reservedNumber?.number ?? null;
  const selectedVoice = VOICE_OPTIONS.find((option) => option.value === form.voice) ?? VOICE_OPTIONS[0];
  const numberRentalPrice = billing?.numberRentalPriceRub ?? 299;
  const numberRentExpiresDate = formatDate(billing?.numberRentExpiresAt);
  const numberRentDaysLeft = formatDaysLeft(billing?.numberRentDaysLeft);
  const numberRentalBalanceEnough = (billing?.rubleBalance ?? 0) >= numberRentalPrice;
  const numberRentalBlockedByWindow = Boolean(reservedNumber && !billing?.numberRenewalAvailable);
  const numberRentalActionLabel = reservedNumber ? "Продлить" : "Зарезервировать номер";
  const numberRentalDisabled = Boolean(
    numberRentalSaving || !billing || !numberRentalBalanceEnough || numberRentalBlockedByWindow
  );
  const hasScenarioChanges = hasSavedScenarioChanges(form, activeProfile, activeMode);
  const scenarioReady = form.prompt.trim().length >= 20 && form.greetingText.trim().length >= 4;
  const showTemplatePicker =
    templatePickerOpen[activeMode] || (form.prompt.trim().length === 0 && !templatePickerDismissed[activeMode]);

  function handleModeChange(mode: UiMode) {
    setActiveMode(mode);
    setNotice(null);
    setError(null);
    setForm(formFromProfile(profiles[mode], mode));
  }

  function handleTemplateToggle() {
    if (showTemplatePicker) {
      setTemplatePickerDismissed((prev) => ({ ...prev, [activeMode]: true }));
      setTemplatePickerOpen((prev) => ({ ...prev, [activeMode]: false }));
      return;
    }

    setTemplatePickerOpen((prev) => ({ ...prev, [activeMode]: true }));
  }

  function handleTemplateSelect(templateId: ScenarioTemplateId) {
    setTemplatePickerDismissed((prev) => ({ ...prev, [activeMode]: true }));
    setTemplatePickerOpen((prev) => ({ ...prev, [activeMode]: false }));

    if (templateId === "custom") {
      return;
    }

    const template = SCENARIO_TEMPLATES.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    setForm((prev) => ({
      ...prev,
      prompt: activeMode === "inbound" ? template.inboundPrompt : template.outboundPrompt,
      greetingText: activeMode === "inbound" ? template.inboundGreeting : template.outboundGreeting,
      promptRequest: ""
    }));
  }

  function applyPromptRequest() {
    const request = form.promptRequest.trim();
    if (!request) {
      return;
    }

    setForm((prev) => ({
      ...prev,
      prompt: `${prev.prompt.trim()}\n\nУточнение владельца: ${request}`,
      promptRequest: ""
    }));
  }

  function openContactNameModal(phone: string) {
    setContactNameModal({ phone });
    setContactNameDraft(contactNames[phone] ?? "");
  }

  async function refreshProfiles() {
    const result = await getMyProfiles(token);
    setProfiles(result.profiles);
    return result.profiles;
  }

  async function refreshBilling() {
    const result = await getBilling(token);
    setBilling(result.billing);
  }

  async function refreshBillingHistory(page = billingHistoryPagination.page) {
    setBillingHistoryLoading(true);
    try {
      const result = await getBillingCharges(token, { page, pageSize: BILLING_HISTORY_PAGE_SIZE });
      setBillingHistory(result.transactions);
      setBillingHistoryPagination(result.pagination);
    } finally {
      setBillingHistoryLoading(false);
    }
  }

  async function openBillingHistory() {
    setBillingHistoryOpen(true);
    setError(null);
    await refreshBillingHistory(1);
  }

  async function refreshLogs(mode: UiMode, page = logsPaginationByMode[mode].page) {
    setLogsPageLoading(true);
    try {
      const result = await getCallLogs(token, mode, { page, pageSize: CALL_LOGS_PAGE_SIZE });
      setLogsByMode((prev) => ({ ...prev, [mode]: result.logs }));
      setLogsPaginationByMode((prev) => ({ ...prev, [mode]: result.pagination }));
    } finally {
      setLogsPageLoading(false);
    }
  }

  async function refreshOutboundContacts(page = outboundPagination.page) {
    setOutboundPageLoading(true);
    try {
      const result = await getOutboundContacts(token, { page, pageSize: OUTBOUND_CONTACTS_PAGE_SIZE });
      setContacts(result.contacts);
      setStats(result.stats);
      setOutboundPagination(result.pagination);
    } finally {
      setOutboundPageLoading(false);
    }
  }

  function handleForwardingRuleChange(rule: "forwardingOnComplete" | "forwardingOnStalemate", checked: boolean) {
    setForm((prev) => {
      const next: ProfileForm = { ...prev, [rule]: checked };
      return { ...next, forwardingEnabled: next.forwardingOnComplete || next.forwardingOnStalemate };
    });
  }

  async function handleSaveProfile(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);

    try {
      const response = await saveProfile(token, activeMode, {
        title: form.title,
        businessName: form.businessName || undefined,
        prompt: form.prompt,
        greetingText: form.greetingText,
        forwardingEnabled: form.forwardingOnComplete || form.forwardingOnStalemate,
        forwardingOnComplete: form.forwardingOnComplete,
        forwardingOnStalemate: form.forwardingOnStalemate,
        realtimeModel: form.realtimeModel,
        voice: form.voice,
        maxDialogSeconds: form.maxDialogSeconds
      });

      setProfiles((prev) => ({ ...prev, [activeMode]: response.profile }));
      setForm(formFromProfile(response.profile, activeMode));
      setNotice("Сценарий сохранен");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить сценарий");
    } finally {
      setSaving(false);
    }
  }

  async function handleTopUpBalance(event: FormEvent) {
    event.preventDefault();
    const amountRub = Number(topUpAmount);
    setError(null);
    setNotice(null);

    if (!Number.isFinite(amountRub) || !Number.isInteger(amountRub) || amountRub < 100) {
      setError("Введите целую сумму от 100 ₽");
      return;
    }

    setTopUpSaving(true);

    try {
      const response = await topUpBalance(token, { amountRub });
      setBilling(response.billing);
      setNotice("Баланс пополнен");
    } catch (topUpError) {
      setError(topUpError instanceof Error ? topUpError.message : "Не удалось пополнить баланс");
    } finally {
      setTopUpSaving(false);
    }
  }

  async function handleRentPhoneNumber() {
    setError(null);
    setNotice(null);
    setNumberRentalSaving(true);

    try {
      const response = await rentPhoneNumber(token);
      setBilling(response.billing);
      const nextProfiles = await refreshProfiles();
      setForm(formFromProfile(nextProfiles[activeMode], activeMode));
      setNotice(reservedNumber ? "Аренда номера продлена" : "Номер AI секретаря зарезервирован");
    } catch (rentError) {
      setError(rentError instanceof Error ? rentError.message : "Не удалось зарезервировать или продлить номер");
    } finally {
      setNumberRentalSaving(false);
    }
  }

  function handleVoicePreview(option: VoiceOption) {
    if (!("speechSynthesis" in window)) {
      setNotice("В этом браузере нет встроенного прослушивания голоса");
      return;
    }

    window.speechSynthesis.cancel();
    if (previewingVoice === option.value) {
      setPreviewingVoice(null);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(`Здравствуйте. Это тестовая запись голоса ${option.title}. Я ваш AI секретарь.`);
    const startedAt = Date.now();
    const finishPreview = () => {
      const remainingMs = Math.max(0, 1200 - (Date.now() - startedAt));
      window.setTimeout(() => {
        setPreviewingVoice((currentVoice) => (currentVoice === option.value ? null : currentVoice));
      }, remainingMs);
    };
    const browserVoice =
      window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("ru")) ??
      window.speechSynthesis.getVoices()[0];

    utterance.lang = "ru-RU";
    utterance.rate = option.previewRate;
    utterance.pitch = option.previewPitch;
    if (browserVoice) {
      utterance.voice = browserVoice;
    }

    utterance.onend = finishPreview;
    utterance.onerror = finishPreview;
    setPreviewingVoice(option.value);
    window.speechSynthesis.speak(utterance);
  }

  async function handleSiteCall() {
    setError(null);
    setNotice(null);

    try {
      await createSiteCall(token, activeMode);
      await Promise.all([refreshLogs(activeMode, 1), refreshBilling()]);
      if (billingHistoryOpen) {
        await refreshBillingHistory(1);
      }
      setNotice("Тестовый звонок записан в логи");
    } catch (callError) {
      setError(callError instanceof Error ? callError.message : "Не удалось создать тестовый звонок");
    }
  }

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    try {
      await changePassword(token, newPassword);
      setNewPassword("");
      setAccessModalOpen(false);
      setNotice("Код пароль входа обновлен");
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : "Не удалось изменить код");
    }
  }

  async function handleGoogleToggle() {
    setError(null);
    setNotice(null);

    try {
      if (integrations?.google.status === "CONNECTED") {
        const response = await disconnectGoogleCalendar(token);
        setIntegrations((prev) => ({ google: response.google, telegram: prev!.telegram }));
        setNotice("Google Calendar отключен");
        return;
      }

      const response = await connectGoogleCalendar(token, {
        googleEmail: "demo@gmail.com",
        calendarId: "primary"
      });
      setIntegrations((prev) => ({ google: response.google, telegram: prev!.telegram }));
      setNotice("Google Calendar подключен в тестовом режиме");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Не удалось переключить Google Calendar");
    }
  }

  async function handleTelegramToggle() {
    setError(null);
    setNotice(null);

    try {
      if (integrations?.telegram.status === "CONNECTED") {
        const response = await disconnectTelegram(token);
        setIntegrations((prev) => ({ google: prev!.google, telegram: response.telegram }));
        setNotice("Telegram отключен");
        return;
      }

      const response = await connectTelegram(token, {
        username: "@andrew_demo",
        chatId: "demo-chat-id"
      });
      setIntegrations((prev) => ({ google: prev!.google, telegram: response.telegram }));
      setNotice("Telegram подключен, новые транскрипты будут отмечаться как отправленные");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Не удалось переключить Telegram");
    }
  }

  async function handleSaveContactName(event: FormEvent) {
    event.preventDefault();
    if (!contactNameModal) {
      return;
    }

    setError(null);
    setNotice(null);

    try {
      const response = await saveContactName(token, {
        phone: contactNameModal.phone,
        name: contactNameDraft
      });

      setContactNames((prev) => ({ ...prev, [response.contact.phone]: response.contact.name }));
      setContactNameModal(null);
      setContactNameDraft("");
      setNotice("Имя номера сохранено");
    } catch (contactError) {
      setError(contactError instanceof Error ? contactError.message : "Не удалось сохранить имя номера");
    }
  }

  async function handleImportContacts(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    try {
      const result = await importOutboundContacts(token, rawNumbers);
      await refreshOutboundContacts(1);
      setNotice(`Импортировано номеров: ${result.importedCount}`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Не удалось импортировать номера");
    }
  }

  async function handleDeleteOutboundContact(contact: OutboundContact) {
    setError(null);
    setNotice(null);

    try {
      await deleteOutboundContact(token, contact.id);
      setContacts((prev) => prev.filter((item) => item.id !== contact.id));
      await refreshOutboundContacts(outboundPagination.page);
      setNotice("Номер удален из базы исходящих обзвонов");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить номер из базы");
    }
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="loading-state">Загружаю кабинет...</section>
      </main>
    );
  }

  return (
    <main className="shell dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">callsec</p>
          <h1>{MODE_LABEL[activeMode]}</h1>
          <p className="subtitle">
            {user.fullName ?? "Аккаунт"} · {user.phone}
          </p>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-btn video-icon-btn"
            type="button"
            aria-label="Видеоинструкция"
            title="Видеоинструкция"
            onClick={() => setVideoModalOpen(true)}
          >
            <VideoInstructionIcon />
          </button>
          <button className="outline-btn" type="button" onClick={() => setHelpModalOpen(true)}>
            Обратная связь
          </button>
          <button className="icon-btn" type="button" aria-label="Код пароль входа" onClick={() => setAccessModalOpen(true)}>
            <SettingsIcon />
          </button>
          <button className="outline-btn" type="button" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </header>

      <nav className="section-tabs" aria-label="Разделы звонков">
        <button className={activeMode === "outbound" ? "active" : ""} type="button" onClick={() => handleModeChange("outbound")}>
          Исходящие звонки
        </button>
        <button className={activeMode === "inbound" ? "active" : ""} type="button" onClick={() => handleModeChange("inbound")}>
          Входящие звонки
        </button>
      </nav>

      {(notice || error) && <div className={error ? "toast error" : "toast"}>{error ?? notice}</div>}

      <section className="account-grid">
        <section className="panel account-panel">
          <div>
            <p className="eyebrow">Баланс</p>
            <h2>{billing ? formatRubles(billing.rubleBalance) : formatRubles(0)}</h2>
            <p className="hint">Баланс списывается за входящие и исходящие разговоры AI-секретаря.</p>
          </div>
          <div className="account-actions">
            <button type="button" onClick={() => setTopUpModalOpen(true)}>
              Пополнить
            </button>
            <button className="outline-btn" type="button" onClick={() => void openBillingHistory()}>
              История
            </button>
          </div>
        </section>

        <section className="panel account-panel">
          <div>
            <p className="eyebrow">Номер вашего AI Секретаря</p>
            <h2>{reservedNumber ?? "Не выдан"}</h2>
            <p className="hint">Номер нельзя выбрать вручную: он закрепляется в разделе пополнения баланса.</p>
            {reservedNumber && numberRentExpiresDate && (
              <p className="hint">Аренда до {numberRentExpiresDate}{numberRentDaysLeft ? ` · ${numberRentDaysLeft}` : ""}</p>
            )}
          </div>
        </section>
      </section>

      <section className="workspace-grid">
        <form className="panel form-panel" onSubmit={handleSaveProfile}>
          <div className="panel-title">
            <h2>Настройки сценария</h2>
            <div className="panel-title-actions">
              <button
                className={showTemplatePicker ? "outline-btn small-btn active" : "outline-btn small-btn"}
                type="button"
                aria-pressed={showTemplatePicker}
                onClick={handleTemplateToggle}
              >
                Шаблоны
              </button>
            </div>
          </div>

          <div className="scenario-form-stage">
            {showTemplatePicker && (
              <section className="template-overlay" aria-label="Выбор шаблона сценария">
                <div className="template-overlay-copy">
                  <p className="eyebrow">Быстрый старт</p>
                  <h2>Выберите шаблон сценария</h2>
                </div>
                <div className="template-grid">
                  {SCENARIO_TEMPLATES.map((template) => (
                    <button
                      className="template-option"
                      type="button"
                      key={template.id}
                      onClick={() => handleTemplateSelect(template.id)}
                    >
                      <strong>{template.title}</strong>
                      <span>{template.description}</span>
                    </button>
                  ))}
                  <button className="template-option custom" type="button" onClick={() => handleTemplateSelect("custom")}>
                    <strong>Заполнить самостоятельно</strong>
                    <span>Оставить поля пустыми и написать сценарий вручную.</span>
                  </button>
                </div>
              </section>
            )}

            <div className={showTemplatePicker ? "scenario-form-content blurred" : "scenario-form-content"}>
              <section className="scenario-section scenario-section-model">
                <div className="scenario-section-title">
                  <strong>Модель и голос</strong>
                  <span>Цена за минуту</span>
                </div>
                <section className="model-picker" aria-label="Модель разговора">
                  <div className="model-options">
                    {REALTIME_MODEL_OPTIONS.map((option) => (
                      <label className={form.realtimeModel === option.value ? "model-option active" : "model-option"} key={option.value}>
                        <input
                          type="radio"
                          name="realtime-model"
                          value={option.value}
                          checked={form.realtimeModel === option.value}
                          onChange={() => setForm({ ...form, realtimeModel: option.value })}
                        />
                        <span>
                          <strong>{option.title}</strong>
                          <small>{option.description}</small>
                        </span>
                        <em>{formatRubles(getModelRateForMode(option, activeMode))}/мин</em>
                      </label>
                    ))}
                  </div>
                </section>

                <section className="voice-picker" aria-label="Голос AI секретаря">
                  <div className="model-picker-header">
                    <strong>Голос AI секретаря</strong>
                    <span>{selectedVoice.description}</span>
                  </div>
                  <div className="voice-control">
                    <label>
                      Выбор голоса
                      <select
                        value={form.voice}
                        onChange={(event) => setForm({ ...form, voice: event.target.value as RealtimeVoice })}
                      >
                        {VOICE_OPTIONS.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.title} — {option.description}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="outline-btn play-btn" type="button" onClick={() => handleVoicePreview(selectedVoice)}>
                      <span aria-hidden="true">{previewingVoice === selectedVoice.value ? "■" : "▶"}</span>
                      {previewingVoice === selectedVoice.value ? "Стоп" : "Прослушать"}
                    </button>
                  </div>
                  <div className="voice-chip-list" aria-label="Быстрый выбор голоса">
                    {VOICE_OPTIONS.map((option) => (
                      <button
                        className={form.voice === option.value ? "voice-chip active" : "voice-chip"}
                        type="button"
                        key={option.value}
                        onClick={() => setForm({ ...form, voice: option.value })}
                      >
                        {option.title}
                      </button>
                    ))}
                  </div>
                </section>
              </section>

              <section className="scenario-section scenario-section-texts">
                <div className="scenario-section-title">
                  <strong>Тексты сценария</strong>
                  <span>{activeMode === "inbound" ? "Входящий диалог" : "Исходящий диалог"}</span>
                </div>
                <label>
                  Greeting text
                  <textarea
                    className="compact-textarea"
                    value={form.greetingText}
                    onChange={(event) => setForm({ ...form, greetingText: event.target.value })}
                    minLength={4}
                    maxLength={600}
                    rows={2}
                    required
                  />
                </label>

                <label>
                  Промпт
                  <textarea
                    value={form.prompt}
                    onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                    minLength={20}
                    maxLength={6000}
                    rows={10}
                    required
                  />
                </label>

                <div className="prompt-tools">
                  <label>
                    Команда для изменения промпта
                    <textarea
                      className="compact-textarea"
                      value={form.promptRequest}
                      onChange={(event) => setForm({ ...form, promptRequest: event.target.value })}
                      placeholder="Например: отвечай короче, чаще уточняй адрес, не обещай скидки"
                      rows={3}
                    />
                  </label>

                  <button className="outline-btn" type="button" onClick={applyPromptRequest}>
                    Применить к промпту
                  </button>
                </div>
              </section>

              <section className="scenario-section scenario-section-behavior">
                <div className="scenario-section-title">
                  <strong>Поведение звонка</strong>
                </div>
                <div className="scenario-behavior-grid">
                  <label className="range-card">
                    <span className="range-card-header">
                      <strong>Максимальное время диалога</strong>
                      <em>{form.maxDialogSeconds} сек</em>
                    </span>
                    <input
                      className="range-control"
                      type="range"
                      min={15}
                      max={600}
                      step={15}
                      value={form.maxDialogSeconds}
                      style={{ "--range-progress": `${((form.maxDialogSeconds - 15) / (600 - 15)) * 100}%` } as CSSProperties}
                      onChange={(event) => setForm({ ...form, maxDialogSeconds: Number(event.target.value) })}
                    />
                  </label>

                  <section className="forwarding-rules" aria-label="Перевод клиента на ваш номер">
                    <div className="forwarding-rules-header">
                      <strong>Перевод клиента на ваш номер</strong>
                      <span>{user.phone}</span>
                    </div>
                    <div className="forwarding-rule-options">
                      <label className="forwarding-option">
                        <input
                          type="checkbox"
                          checked={form.forwardingOnComplete}
                          onChange={(event) => handleForwardingRuleChange("forwardingOnComplete", event.currentTarget.checked)}
                        />
                        <span>По завершении разговора</span>
                      </label>
                      <label className="forwarding-option">
                        <input
                          type="checkbox"
                          checked={form.forwardingOnStalemate}
                          onChange={(event) => handleForwardingRuleChange("forwardingOnStalemate", event.currentTarget.checked)}
                        />
                        <span>При логическом тупике</span>
                      </label>
                    </div>
                  </section>
                </div>
              </section>

              <div className="form-actions">
                <button type="submit" disabled={saving || !hasScenarioChanges || !scenarioReady}>
                  {saving ? "Сохраняю..." : "Сохранить сценарий"}
                </button>
                <button
                  className="outline-btn"
                  type="button"
                  disabled={saving || hasScenarioChanges || !scenarioReady}
                  title={
                    !scenarioReady
                      ? "Сначала заполните greeting и промпт"
                      : hasScenarioChanges
                        ? "Сначала сохраните изменения сценария"
                        : undefined
                  }
                  onClick={handleSiteCall}
                >
                  Тест звонок
                </button>
              </div>
            </div>
          </div>
        </form>

        <aside className="side-stack">
          <section className="panel integration-card">
            <div className="panel-title">
              <h2>Интеграции</h2>
              <span>Тестовый режим</span>
            </div>
            <div className="integration-list">
              <article className="integration-item">
                <div className="integration-copy">
                  <GoogleCalendarIcon />
                  <div>
                    <strong>Google Calendar</strong>
                    <p>AI секретарь сможет создавать и переносить записи в календаре, а телефон, планшет и ПК синхронизируют изменения автоматически.</p>
                  </div>
                </div>
                <button className="outline-btn integration-button" type="button" onClick={handleGoogleToggle}>
                  {integrations?.google.status === "CONNECTED" ? "Отключить" : "Подключить"}
                </button>
              </article>
              <article className="integration-item">
                <div className="integration-copy">
                  <TelegramIcon />
                  <div>
                    <strong>Telegram</strong>
                    <p>Транскрибы входящих и исходящих разговоров будут приходить в Telegram после каждого звонка.</p>
                  </div>
                </div>
                <button className="outline-btn integration-button" type="button" onClick={handleTelegramToggle}>
                  {integrations?.telegram.status === "CONNECTED" ? "Отключить" : "Подключить"}
                </button>
              </article>
            </div>
          </section>

          {activeMode === "outbound" && (
            <section className="panel">
              <div className="panel-title">
                <h2>База исходящих обзвонов</h2>
                <span>{stats.total}</span>
              </div>

              <form className="stack-form" onSubmit={handleImportContacts}>
                <textarea
                  className="compact-textarea"
                  value={rawNumbers}
                  onChange={(event) => setRawNumbers(event.target.value)}
                  rows={4}
                />
                <button type="submit">Загрузить номера</button>
              </form>
              <p className="hint">
                Новые номера добавляются сверху. Обзвон идет снизу вверх по порядку загрузки; повторная попытка через 15 минут,
                после успешного звонка или 3 неудачных попыток номер удаляется из базы.
              </p>

              <div className="contact-list">
                {contacts.length === 0 && <p className="empty-state">Номера пока не загружены.</p>}

                {contacts.map((contact) => (
                  <article className="contact-row" key={contact.id}>
                    <div>
                      <strong>{contactNames[contact.phone] ? `${contactNames[contact.phone]} · ${contact.phone}` : contact.phone}</strong>
                      <span>
                        {contact.attempts === 0 ? "Ожидает первого звонка" : `${contact.attempts} попыток`}
                        {contact.nextAttemptAt
                          ? ` · повтор после ${new Date(contact.nextAttemptAt).toLocaleTimeString("ru-RU", {
                              hour: "2-digit",
                              minute: "2-digit"
                            })}`
                          : ""}
                      </span>
                    </div>
                    <button className="outline-btn small-btn" type="button" onClick={() => void handleDeleteOutboundContact(contact)}>
                      Удалить из базы
                    </button>
                  </article>
                ))}
              </div>

              <div className="pagination-row">
                <button
                  className="outline-btn small-btn"
                  type="button"
                  disabled={outboundPageLoading || !outboundPagination.hasPreviousPage}
                  onClick={() => void refreshOutboundContacts(outboundPagination.page - 1)}
                >
                  Назад
                </button>
                <span>
                  Страница {outboundPagination.page} из {outboundPagination.totalPages}
                </span>
                <button
                  className="outline-btn small-btn"
                  type="button"
                  disabled={outboundPageLoading || !outboundPagination.hasNextPage}
                  onClick={() => void refreshOutboundContacts(outboundPagination.page + 1)}
                >
                  Вперёд
                </button>
              </div>
            </section>
          )}
        </aside>
      </section>

      <section className="panel logs-panel">
        <div className="logs-header">
          <h2>Логи разговоров</h2>
          <span className="section-count">{activeLogsPagination.total}</span>
        </div>

        <div className="logs-list">
          {logsByMode[activeMode].length === 0 && <p className="empty-state">Логов пока нет.</p>}

          {logsByMode[activeMode].map((log) => {
            const telegramDelivery = log.transcriptDeliveries?.find((delivery) => delivery.channel === "TELEGRAM");
            const customerName = contactNames[log.customerPhone];

            return (
              <article key={log.id} className="log-item">
                <div className="log-row">
                  <div className="log-phone">
                    <strong>{customerName ? `${customerName} · ${log.customerPhone}` : log.customerPhone}</strong>
                    <button
                      className="icon-mini-btn"
                      type="button"
                      aria-label="Назвать номер"
                      title="Назвать номер"
                      onClick={() => openContactNameModal(log.customerPhone)}
                    >
                      ✎
                    </button>
                  </div>
                  <span className={`status ${log.status.toLowerCase()}`}>{formatStatus(log.status)}</span>
                </div>
                <p>{log.summary ?? "Без краткого описания"}</p>
                {telegramDelivery && (
                  <span className={`delivery ${telegramDelivery.status.toLowerCase()}`}>
                    Telegram: {telegramDelivery.status}
                  </span>
                )}
                {log.recordingUrl && <audio controls src={log.recordingUrl} />}
                {log.transcript && renderTranscript(log.transcript)}
                <div className="log-row meta">
                  <span>{new Date(log.createdAt).toLocaleString()}</span>
                  <span>{log.durationSeconds} сек</span>
                </div>
              </article>
            );
          })}
        </div>

        {activeLogsPagination.totalPages > 1 && (
          <div className="pagination-row">
            <button
              className="outline-btn small-btn"
              type="button"
              disabled={logsPageLoading || !activeLogsPagination.hasPreviousPage}
              onClick={() => void refreshLogs(activeMode, activeLogsPagination.page - 1)}
            >
              Назад
            </button>
            <span>
              Страница {activeLogsPagination.page} из {activeLogsPagination.totalPages}
            </span>
            <button
              className="outline-btn small-btn"
              type="button"
              disabled={logsPageLoading || !activeLogsPagination.hasNextPage}
              onClick={() => void refreshLogs(activeMode, activeLogsPagination.page + 1)}
            >
              Вперёд
            </button>
          </div>
        )}
      </section>

      <footer className="site-footer">79054176285@yandex.ru - Email для связи</footer>

      {topUpModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTopUpModalOpen(false)}>
          <section className="modal-panel tariff-modal" role="dialog" aria-modal="true" aria-labelledby="tariff-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="tariff-title">Пополнение баланса</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setTopUpModalOpen(false)}>
                ×
              </button>
            </div>

            <form className="top-up-form" onSubmit={handleTopUpBalance}>
              <label>
                Сумма пополнения, ₽
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={topUpAmount}
                  onChange={(event) => setTopUpAmount(event.target.value)}
                  placeholder="1000"
                  required
                />
              </label>
              <button type="submit" disabled={topUpSaving}>
                {topUpSaving ? "Пополняю..." : "Пополнить баланс"}
              </button>
            </form>

            <section className="number-rental-card">
              <div>
                <p className="eyebrow">Аренда номера</p>
                <h3>{formatRubles(numberRentalPrice)}/мес</h3>
                <p className="hint">
                  Номер продлевается автоматически при достаточном балансе. Вручную продлить можно, когда остается меньше 14 дней.
                </p>
              </div>

              <div className="rental-meta">
                <span>{reservedNumber ? `Ваш номер: ${reservedNumber}` : "Номер пока не зарезервирован"}</span>
                <span>
                  {numberRentExpiresDate
                    ? `Оплачено до ${numberRentExpiresDate}${numberRentDaysLeft ? ` · ${numberRentDaysLeft}` : ""}`
                    : "Аренда еще не оплачена"}
                </span>
                {!numberRentalBalanceEnough && (
                  <span>Для аренды нужно пополнить баланс минимум до {formatRubles(numberRentalPrice)}.</span>
                )}
                {numberRentalBlockedByWindow && <span>Продление станет доступно, когда останется меньше 14 дней.</span>}
              </div>

              <button
                type="button"
                className="outline-btn"
                disabled={numberRentalDisabled}
                onClick={() => void handleRentPhoneNumber()}
              >
                {numberRentalSaving ? "Обновляю..." : numberRentalActionLabel}
              </button>
            </section>

            <section className="rate-table" aria-label="Стоимость звонков">
              <div className="rate-row rate-head">
                <span>Модель</span>
                <span>Входящие</span>
                <span>Исходящие</span>
              </div>
              {REALTIME_MODEL_OPTIONS.map((option) => (
                <div className="rate-row" key={option.value}>
                  <strong>{option.title}</strong>
                  <span>{formatRubles(option.inboundRateRubPerMinute)}/мин</span>
                  <span>{formatRubles(option.outboundRateRubPerMinute)}/мин</span>
                </div>
              ))}
            </section>
          </section>
        </div>
      )}

      {billingHistoryOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setBillingHistoryOpen(false)}>
          <section className="modal-panel history-modal" role="dialog" aria-modal="true" aria-labelledby="billing-history-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="billing-history-title">История списаний</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setBillingHistoryOpen(false)}>
                ×
              </button>
            </div>

            <div className="history-list">
              {billingHistoryLoading && <p className="empty-state">Загружаю списания...</p>}
              {!billingHistoryLoading && billingHistory.length === 0 && <p className="empty-state">Списаний пока нет.</p>}

              {!billingHistoryLoading &&
                billingHistory.map((transaction) => (
                  <article className="history-row" key={transaction.id}>
                    <div>
                      <strong>{formatBillingTitle(transaction)}</strong>
                      <span>{transaction.note ?? "AI-секретарь"}</span>
                      <small>{new Date(transaction.createdAt).toLocaleString()} · {formatSeconds(transaction.amountSeconds)}</small>
                    </div>
                    <b>{formatRubles(transaction.amountRub ?? 0)}</b>
                  </article>
                ))}
            </div>

            <div className="pagination-row">
              <button
                className="outline-btn small-btn"
                type="button"
                disabled={billingHistoryLoading || !billingHistoryPagination.hasPreviousPage}
                onClick={() => void refreshBillingHistory(billingHistoryPagination.page - 1)}
              >
                Назад
              </button>
              <span>
                Страница {billingHistoryPagination.page} из {billingHistoryPagination.totalPages}
              </span>
              <button
                className="outline-btn small-btn"
                type="button"
                disabled={billingHistoryLoading || !billingHistoryPagination.hasNextPage}
                onClick={() => void refreshBillingHistory(billingHistoryPagination.page + 1)}
              >
                Вперёд
              </button>
            </div>
          </section>
        </div>
      )}

      {videoModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setVideoModalOpen(false)}>
          <section className="modal-panel video-modal" role="dialog" aria-modal="true" aria-labelledby="video-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="video-title">Видеоинструкция</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setVideoModalOpen(false)}>
                ×
              </button>
            </div>
            <div className="instruction-video-frame">
              <span aria-hidden="true">▶</span>
              <strong>AI Secretary: быстрый обзор кабинета</strong>
              <small>Настройка сценария, тестовый звонок, база исходящих и логи разговоров.</small>
            </div>
          </section>
        </div>
      )}

      {helpModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setHelpModalOpen(false)}>
          <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="help-title">Обратная связь</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setHelpModalOpen(false)}>
                ×
              </button>
            </div>
            <div className="help-content">
              <p>Напишите, если нужна помощь с настройкой сценария, телефонией, оплатой или интеграциями.</p>
              <div className="plain-phone-contact" aria-label="Телефон для копирования">
                <span>Телефон</span>
                <strong>+79054176285</strong>
              </div>
              <div className="contact-links">
                <a href="https://t.me/Drunlet" target="_blank" rel="noreferrer">
                  Telegram @Drunlet
                </a>
                <a href="tel:+79054176285">
                  Max +79054176285
                </a>
                <a href="https://wa.me/79054176285" target="_blank" rel="noreferrer">
                  WhatsApp +79054176285
                </a>
                <a href="mailto:79054176285@yandex.ru">79054176285@yandex.ru</a>
              </div>
            </div>
          </section>
        </div>
      )}

      {accessModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAccessModalOpen(false)}>
          <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="access-code-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="access-code-title">Код пароль входа</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setAccessModalOpen(false)}>
                ×
              </button>
            </div>
            <form className="stack-form" onSubmit={handleChangePassword}>
              <label>
                Новый 6-значный код пароль входа
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="654321"
                  required
                />
              </label>
              <div className="modal-actions">
                <button className="outline-btn" type="button" onClick={() => setAccessModalOpen(false)}>
                  Отмена
                </button>
                <button type="submit">Обновить код</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {contactNameModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setContactNameModal(null)}>
          <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="contact-name-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="contact-name-title">Имя номера</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setContactNameModal(null)}>
                ×
              </button>
            </div>
            <p className="hint">{contactNameModal.phone}</p>
            <form className="stack-form" onSubmit={handleSaveContactName}>
              <label>
                Как показывать клиента
                <input
                  value={contactNameDraft}
                  onChange={(event) => setContactNameDraft(event.target.value)}
                  placeholder="Например: Андрей, поставщик, клиент с сайта"
                  maxLength={80}
                  required
                />
              </label>
              <div className="modal-actions">
                <button className="outline-btn" type="button" onClick={() => setContactNameModal(null)}>
                  Отмена
                </button>
                <button type="submit">Сохранить</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
