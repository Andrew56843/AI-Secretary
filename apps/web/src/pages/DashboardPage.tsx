import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  changePassword,
  connectGoogleCalendar,
  connectTelegram,
  createDemoCallLog,
  createSiteCall,
  disconnectGoogleCalendar,
  disconnectTelegram,
  getBilling,
  getCallLogs,
  getContactNames,
  getIntegrations,
  getMyProfiles,
  getOutboundContacts,
  importOutboundContacts,
  saveContactName,
  saveProfile,
  topUpBalance,
  updateOutboundContactQueue,
  updateProfileForwarding
} from "../lib/api";
import type {
  AssistantProfile,
  AuthUser,
  BillingState,
  CallLog,
  IntegrationsState,
  OutboundContact,
  OutboundPagination,
  OutboundStats,
  PhoneContactName,
  ProfilesByMode,
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
  maxDialogSeconds: number;
};

type TariffPlan = {
  id: "ai-bot" | "ai-bot-mini";
  title: string;
  priceRub: number;
  minutes: number;
  description: string;
};

const MODE_LABEL: Record<UiMode, string> = {
  inbound: "Входящие звонки",
  outbound: "Исходящие звонки"
};

const TARIFF_PLANS: TariffPlan[] = [
  {
    id: "ai-bot",
    title: "ИИ бот",
    priceRub: 1500,
    minutes: 100,
    description: "Дорогой тариф для основного ИИ-секретаря."
  },
  {
    id: "ai-bot-mini",
    title: "ИИ бот (mini)",
    priceRub: 500,
    minutes: 60,
    description: "Дешевый тариф для тестов и коротких обзвонов."
  }
];

const DEFAULT_STATS: OutboundStats = {
  total: 0,
  pending: 0,
  queued: 0,
  called: 0,
  failed: 0
};

const OUTBOUND_CONTACTS_PAGE_SIZE = 5;

const DEFAULT_OUTBOUND_PAGINATION: OutboundPagination = {
  page: 1,
  pageSize: OUTBOUND_CONTACTS_PAGE_SIZE,
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

function defaultForm(mode: UiMode): ProfileForm {
  return {
    title: MODE_LABEL[mode],
    businessName: "",
    promptRequest: "",
    prompt:
      mode === "inbound"
        ? "Ты ИИ-секретарь компании. Отвечай на входящие звонки, уточняй цель обращения, помогай клиенту и переводи звонок владельцу, если вопрос выходит за рамки сценария."
        : "Ты ИИ-ассистент для исходящего обзвона. Коротко представляйся, объясняй цель звонка, фиксируй результат разговора и завершай диалог вежливо.",
    greetingText:
      mode === "inbound"
        ? "Здравствуйте! Я ИИ-секретарь. Чем могу помочь?"
        : "Здравствуйте! Уточню пару вопросов, это займет меньше минуты.",
    forwardingEnabled: true,
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
    maxDialogSeconds: profile.maxDialogSeconds
  };
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
  const [integrations, setIntegrations] = useState<IntegrationsState | null>(null);
  const [logsByMode, setLogsByMode] = useState<Record<UiMode, CallLog[]>>({ inbound: [], outbound: [] });
  const [contacts, setContacts] = useState<OutboundContact[]>([]);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<OutboundStats>(DEFAULT_STATS);
  const [outboundPagination, setOutboundPagination] = useState<OutboundPagination>(DEFAULT_OUTBOUND_PAGINATION);
  const [outboundPageLoading, setOutboundPageLoading] = useState(false);
  const [rawNumbers, setRawNumbers] = useState("+79160001122, +79261230044 +79031234567");
  const [newPassword, setNewPassword] = useState("");
  const [topUpModalOpen, setTopUpModalOpen] = useState(false);
  const [accessModalOpen, setAccessModalOpen] = useState(false);
  const [contactNameModal, setContactNameModal] = useState<{ phone: string } | null>(null);
  const [contactNameDraft, setContactNameDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topUpSaving, setTopUpSaving] = useState<string | null>(null);
  const [forwardingSaving, setForwardingSaving] = useState(false);
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
          getCallLogs(token, "inbound"),
          getCallLogs(token, "outbound"),
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

  const activeProfile = profiles[activeMode];
  const reservedNumber = billing?.reservedNumber?.number ?? null;

  function handleModeChange(mode: UiMode) {
    setActiveMode(mode);
    setNotice(null);
    setError(null);
    setForm(formFromProfile(profiles[mode], mode));
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

  async function refreshLogs(mode: UiMode) {
    const result = await getCallLogs(token, mode);
    setLogsByMode((prev) => ({ ...prev, [mode]: result.logs }));
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
        forwardingEnabled: form.forwardingEnabled,
        maxDialogSeconds: form.maxDialogSeconds
      });

      setProfiles((prev) => ({ ...prev, [activeMode]: response.profile }));
      setNotice("Сценарий сохранен");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не удалось сохранить сценарий");
    } finally {
      setSaving(false);
    }
  }

  async function handleTopUpPlan(plan: TariffPlan) {
    setError(null);
    setNotice(null);
    setTopUpSaving(plan.id);

    try {
      const response = await topUpBalance(token, {
        minutes: plan.minutes,
        amountRub: plan.priceRub
      });
      setBilling(response.billing);
      const nextProfiles = await refreshProfiles();
      setForm(formFromProfile(nextProfiles[activeMode], activeMode));
      setTopUpModalOpen(false);
      setNotice(reservedNumber ? "Баланс пополнен" : "Баланс пополнен, номер автоматически закреплен");
    } catch (topUpError) {
      setError(topUpError instanceof Error ? topUpError.message : "Не удалось пополнить баланс");
    } finally {
      setTopUpSaving(null);
    }
  }

  async function handleSiteCall() {
    setError(null);
    setNotice(null);

    try {
      await createSiteCall(token, activeMode);
      await Promise.all([refreshLogs(activeMode), refreshBilling()]);
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

  async function handleForwardingToggle(forwardingEnabled: boolean) {
    const previousValue = form.forwardingEnabled;
    setError(null);
    setNotice(null);
    setForwardingSaving(true);
    setForm((prev) => ({ ...prev, forwardingEnabled }));

    try {
      const response = await updateProfileForwarding(token, activeMode, forwardingEnabled);
      setProfiles((prev) => ({ ...prev, [activeMode]: response.profile }));
      setForm((prev) => ({ ...prev, forwardingEnabled: response.profile.forwardingEnabled }));
      setNotice(forwardingEnabled ? "Перевод на номер включен" : "Перевод на номер выключен");
    } catch (forwardingError) {
      setForm((prev) => ({ ...prev, forwardingEnabled: previousValue }));
      setError(forwardingError instanceof Error ? forwardingError.message : "Не удалось изменить перевод на номер");
    } finally {
      setForwardingSaving(false);
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

  async function handleGenerateDemoLog() {
    setError(null);
    setNotice(null);

    try {
      await createDemoCallLog(token, activeMode);
      await Promise.all([refreshLogs(activeMode), refreshBilling()]);
      setNotice("Демо-звонок добавлен");
    } catch (logsError) {
      setError(logsError instanceof Error ? logsError.message : "Не удалось создать демо-лог");
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

  async function handleQueueContact(contact: OutboundContact) {
    setError(null);
    setNotice(null);

    try {
      const nextQueuedState = !contact.queuedForCall;
      const response = await updateOutboundContactQueue(token, contact.id, nextQueuedState);
      setContacts((prev) => prev.map((item) => (item.id === response.contact.id ? response.contact : item)));
      await refreshOutboundContacts(outboundPagination.page);
      setNotice(nextQueuedState ? "Номер добавлен в очередь исходящего обзвона" : "Номер снят с очереди исходящего обзвона");
    } catch (queueError) {
      setError(queueError instanceof Error ? queueError.message : "Не удалось изменить очередь исходящего обзвона");
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
          <p className="eyebrow">AI Secretary SaaS</p>
          <h1>{MODE_LABEL[activeMode]}</h1>
          <p className="subtitle">
            {user.fullName ?? "Аккаунт"} · {user.phone}
          </p>
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" type="button" aria-label="Код пароль входа" onClick={() => setAccessModalOpen(true)}>
            ⚙
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
          <button type="button" onClick={() => setTopUpModalOpen(true)}>
            Пополнить
          </button>
        </section>

        <section className="panel account-panel">
          <div>
            <p className="eyebrow">Номер вашего AI Секретаря</p>
            <h2>{reservedNumber ?? "Не выдан"}</h2>
            <p className="hint">Номер нельзя выбрать вручную: он закрепляется автоматически при первом пополнении.</p>
          </div>
        </section>
      </section>

      <section className="workspace-grid">
        <form className="panel form-panel" onSubmit={handleSaveProfile}>
          <div className="panel-title">
            <h2>Настройки сценария</h2>
            <span>{activeProfile?.status ?? "ACTIVE"}</span>
          </div>

          <div className="two-columns">
            <label>
              Название
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                minLength={2}
                maxLength={100}
                required
              />
            </label>

            <label>
              Бизнес
              <input
                value={form.businessName}
                onChange={(event) => setForm({ ...form, businessName: event.target.value })}
                placeholder="Echte Doner"
                maxLength={120}
              />
            </label>
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

          <label>
            Максимальное время диалога: {form.maxDialogSeconds} сек
            <input
              type="range"
              min={15}
              max={600}
              step={15}
              value={form.maxDialogSeconds}
              onChange={(event) => setForm({ ...form, maxDialogSeconds: Number(event.target.value) })}
            />
          </label>

          <div className="form-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Сохраняю..." : "Сохранить сценарий"}
            </button>
            <button className="outline-btn" type="button" onClick={handleSiteCall}>
              Тест звонок
            </button>
          </div>
        </form>

        <aside className="side-stack">
          <section className="panel integration-card">
            <div className="panel-title">
              <h2>Интеграции</h2>
              <span>Тестовый режим</span>
            </div>
            <div className="integration-actions">
              <button className="outline-btn integration-button" type="button" onClick={handleGoogleToggle}>
                <GoogleCalendarIcon />
                <span>{integrations?.google.status === "CONNECTED" ? "Отключить Google" : "Подключить Google"}</span>
              </button>
              <button className="outline-btn integration-button" type="button" onClick={handleTelegramToggle}>
                <TelegramIcon />
                <span>{integrations?.telegram.status === "CONNECTED" ? "Отключить Telegram" : "Подключить Telegram"}</span>
              </button>
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

              <div className="stats-grid">
                <strong>
                  {stats.total}
                  <span>В базе</span>
                </strong>
                <strong>
                  {stats.queued}
                  <span>В очереди</span>
                </strong>
                <strong>
                  {stats.called}
                  <span>Обзвонено</span>
                </strong>
                <strong>
                  {stats.failed}
                  <span>Ошибки</span>
                </strong>
              </div>

              <div className="contact-list">
                {contacts.length === 0 && <p className="empty-state">Номера пока не загружены.</p>}

                {contacts.map((contact) => (
                  <article className="contact-row" key={contact.id}>
                    <div>
                      <strong>{contactNames[contact.phone] ? `${contactNames[contact.phone]} · ${contact.phone}` : contact.phone}</strong>
                      <span>
                        {contact.queuedForCall ? "В очереди" : formatStatus(contact.status)} · {contact.attempts} попыток
                      </span>
                    </div>
                    <button className="outline-btn small-btn" type="button" onClick={() => handleQueueContact(contact)}>
                      {contact.queuedForCall ? "Снять из очереди" : "В очередь"}
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
          <button type="button" className="outline-btn" onClick={handleGenerateDemoLog}>
            + Демо-звонок
          </button>
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
      </section>

      {topUpModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTopUpModalOpen(false)}>
          <section className="modal-panel tariff-modal" role="dialog" aria-modal="true" aria-labelledby="tariff-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <h2 id="tariff-title">Пополнение баланса</h2>
              <button className="icon-mini-btn" type="button" aria-label="Закрыть" onClick={() => setTopUpModalOpen(false)}>
                ×
              </button>
            </div>

            <div className="tariff-table" role="table" aria-label="Тарифы">
              <div className="tariff-row tariff-head" role="row">
                <span role="columnheader">Тариф</span>
                <span role="columnheader">Цена</span>
                <span role="columnheader">Лимит</span>
                <span role="columnheader">Действие</span>
              </div>

              {TARIFF_PLANS.map((plan) => (
                <div className="tariff-row" role="row" key={plan.id}>
                  <div role="cell">
                    <strong>{plan.title}</strong>
                    <small>{plan.description}</small>
                  </div>
                  <span role="cell">{formatRubles(plan.priceRub)}</span>
                  <span role="cell">{plan.minutes} мин</span>
                  <button type="button" className="small-btn" disabled={topUpSaving === plan.id} onClick={() => void handleTopUpPlan(plan)}>
                    {topUpSaving === plan.id ? "..." : "Выбрать"}
                  </button>
                </div>
              ))}
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
              <section className="modal-setting">
                <div>
                  <strong>Перевод на номер</strong>
                  <span>{user.phone}</span>
                </div>
                <label className="switch-field">
                  <input
                    type="checkbox"
                    checked={form.forwardingEnabled}
                    disabled={forwardingSaving}
                    onChange={(event) => void handleForwardingToggle(event.currentTarget.checked)}
                  />
                  <span>{form.forwardingEnabled ? "Включен" : "Выключен"}</span>
                </label>
              </section>

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
