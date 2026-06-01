import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  createDemoCallLog,
  getCallLogs,
  getFreeNumbers,
  getMyProfile,
  saveProfile
} from "../lib/api";
import type { AssistantProfile, AuthUser, CallLog, ReservedPhoneNumber } from "../types";

type DashboardProps = {
  token: string;
  user: AuthUser;
  onLogout: () => void;
};

type ProfileForm = {
  title: string;
  businessName: string;
  prompt: string;
  forwardingPhone: string;
  reservedNumberId: string;
};

const INITIAL_PROMPT =
  "Ты ИИ-секретарь ресторана. Принимай заказ, уточняй количество, подтверждай итоговую сумму и при необходимости переводи звонок на владельца.";

export function DashboardPage({ token, user, onLogout }: DashboardProps) {
  const [profile, setProfile] = useState<AssistantProfile | null>(null);
  const [freeNumbers, setFreeNumbers] = useState<ReservedPhoneNumber[]>([]);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileForm>({
    title: "AI Secretary",
    businessName: "",
    prompt: INITIAL_PROMPT,
    forwardingPhone: "+79054176285",
    reservedNumberId: ""
  });

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        setLoading(true);
        const [profileResult, numbersResult, logsResult] = await Promise.all([
          getMyProfile(token),
          getFreeNumbers(token),
          getCallLogs(token)
        ]);

        if (!isMounted) {
          return;
        }

        setProfile(profileResult.profile);
        setFreeNumbers(numbersResult.numbers);
        setLogs(logsResult.logs);

        if (profileResult.profile) {
          const next = profileResult.profile;
          setForm({
            title: next.title,
            businessName: next.businessName ?? "",
            prompt: next.prompt,
            forwardingPhone: next.forwardingPhone,
            reservedNumberId: next.reservedNumberId
          });
        } else if (numbersResult.numbers[0]) {
          setForm((prev) => ({ ...prev, reservedNumberId: numbersResult.numbers[0]!.id }));
        }
      } catch (bootstrapError) {
        if (isMounted) {
          setError(bootstrapError instanceof Error ? bootstrapError.message : "Failed to load data");
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

  const numberOptions = useMemo(() => {
    if (!profile) {
      return freeNumbers;
    }
    const hasCurrent = freeNumbers.some((item) => item.id === profile.reservedNumberId);
    return hasCurrent ? freeNumbers : [profile.reservedNumber, ...freeNumbers];
  }, [freeNumbers, profile]);

  async function handleSaveProfile(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const response = await saveProfile(token, {
        title: form.title,
        businessName: form.businessName || undefined,
        prompt: form.prompt,
        forwardingPhone: form.forwardingPhone,
        reservedNumberId: form.reservedNumberId || undefined
      });
      setProfile(response.profile);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateDemoLog() {
    setError(null);
    try {
      await createDemoCallLog(token);
      const updated = await getCallLogs(token);
      setLogs(updated.logs);
    } catch (logsError) {
      setError(logsError instanceof Error ? logsError.message : "Cannot create demo log");
    }
  }

  if (loading) {
    return (
      <main className="shell">
        <section className="loading-state">Загружаю дашборд...</section>
      </main>
    );
  }

  return (
    <main className="shell dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AI Secretary SaaS</p>
          <h1>{profile?.title ?? "Настройка профиля"}</h1>
          <p className="subtitle">
            Пользователь: {user.fullName ?? user.email} · Email: {user.email}
          </p>
        </div>
        <button className="outline-btn" type="button" onClick={onLogout}>
          Выйти
        </button>
      </header>

      <section className="grid-layout">
        <form className="panel form-panel" onSubmit={handleSaveProfile}>
          <h2>Профиль ассистента</h2>
          <label>
            Название профиля
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

          <label>
            Промпт ассистента
            <textarea
              value={form.prompt}
              onChange={(event) => setForm({ ...form, prompt: event.target.value })}
              minLength={20}
              maxLength={4000}
              rows={6}
              required
            />
          </label>

          <label>
            Телефон владельца для эскалации
            <input
              value={form.forwardingPhone}
              onChange={(event) => setForm({ ...form, forwardingPhone: event.target.value })}
              minLength={8}
              maxLength={24}
              required
            />
          </label>

          <label>
            Выделенный номер
            <select
              value={form.reservedNumberId}
              onChange={(event) => setForm({ ...form, reservedNumberId: event.target.value })}
              required
            >
              <option value="" disabled>
                Выберите номер
              </option>
              {numberOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.number}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="error-text">{error}</p>}

          <button type="submit" disabled={saving}>
            {saving ? "Сохраняю..." : "Сохранить профиль"}
          </button>
        </form>

        <section className="panel logs-panel">
          <div className="logs-header">
            <h2>Логи звонков</h2>
            <button type="button" className="outline-btn" onClick={handleGenerateDemoLog}>
              + Демо-звонок
            </button>
          </div>

          <div className="logs-list">
            {logs.length === 0 && (
              <p className="empty-state">Логов пока нет. Создайте демо-звонок или подключите реальную телефонию.</p>
            )}

            {logs.map((log) => (
              <article key={log.id} className="log-item">
                <div className="log-row">
                  <strong>{log.customerPhone}</strong>
                  <span className={`status ${log.status.toLowerCase()}`}>{log.status}</span>
                </div>
                <p>{log.summary ?? "Без краткого описания"}</p>
                <div className="log-row meta">
                  <span>{new Date(log.createdAt).toLocaleString()}</span>
                  <span>{log.durationSeconds} сек</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
