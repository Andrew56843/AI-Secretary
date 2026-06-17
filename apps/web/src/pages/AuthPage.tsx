import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { completePhoneVerification, forgotPassword, getPhoneVerification, login, register } from "../lib/api";
import type { AuthResponse, PhoneVerification } from "../types";

type AuthPageProps = {
  onAuthorized: (data: AuthResponse) => void;
};

type AuthPanelProps = AuthPageProps & {
  className?: string;
};

type AuthMode = "login" | "register" | "recover";

const RU_PHONE_PREFIX = "+7";
const VERIFICATION_POLL_INTERVAL_MS = 2000;

function formatRuPhoneInput(input: string) {
  let digits = input.replace(/\D/g, "");

  if (digits.startsWith("7") || digits.startsWith("8")) {
    digits = digits.slice(1);
  }

  const localDigits = digits.slice(0, 10);

  const operator = localDigits.slice(0, 3);
  const middle = localDigits.slice(3, 6);
  const firstPair = localDigits.slice(6, 8);
  const secondPair = localDigits.slice(8, 10);

  let formatted = RU_PHONE_PREFIX;
  if (operator) {
    formatted += `(${operator}`;
  }
  if (operator.length === 3) {
    formatted += ")";
  }
  if (middle) {
    formatted += middle;
  }
  if (firstPair) {
    formatted += `-${firstPair}`;
  }
  if (secondPair) {
    formatted += `-${secondPair}`;
  }

  return formatted;
}

function formatPhoneForDisplay(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  }
  return phone;
}

function formatDeadline(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function AuthPanel({ onAuthorized, className = "" }: AuthPanelProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState(RU_PHONE_PREFIX);
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [verification, setVerification] = useState<PhoneVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const verificationId = verification?.id;
  const verificationStatus = verification?.status;

  useEffect(() => {
    if (!verificationId || verificationStatus !== "PENDING") {
      return;
    }

    const activeVerificationId = verificationId;
    let stopped = false;
    let timer: number | undefined;

    async function pollVerification() {
      try {
        const response = await getPhoneVerification(activeVerificationId);
        if (stopped) {
          return;
        }

        setVerification(response.verification);

        if (response.verification.status === "VERIFIED") {
          setError(null);
          return;
        }

        if (response.verification.status === "EXPIRED") {
          setError("Время ожидания звонка истекло. Запросите проверку ещё раз.");
          return;
        }

        timer = window.setTimeout(pollVerification, VERIFICATION_POLL_INTERVAL_MS);
      } catch (pollError) {
        if (!stopped) {
          setError(pollError instanceof Error ? pollError.message : "Не удалось проверить звонок");
        }
      }
    }

    timer = window.setTimeout(pollVerification, 1000);

    return () => {
      stopped = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [verificationId, verificationStatus]);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setNewPassword("");
    setVerification(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if ((mode === "register" || mode === "recover") && verification?.status === "VERIFIED") {
        const response = await completePhoneVerification(verification.id, { password: newPassword });
        onAuthorized(response);
        return;
      }

      setVerification(null);

      if (mode === "register") {
        setNewPassword("");
        const response = await register({ phone, fullName: fullName || undefined });
        setVerification(response.verification);
        return;
      }

      if (mode === "recover") {
        setNewPassword("");
        const response = await forgotPassword({ phone });
        setVerification(response.verification);
        return;
      }

      const response = await login({ phone, password });
      onAuthorized(response);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  }

  const waitingForCall = verification?.status === "PENDING";
  const readyForPassword = (mode === "register" || mode === "recover") && verification?.status === "VERIFIED";

  return (
    <section className={className ? `auth-panel ${className}` : "auth-panel"}>
      <header className="auth-header">
        <p className="eyebrow">callsec</p>
        <h1>Кабинет callsec</h1>
        <p className="subtitle">Телефонная авторизация, входящие и исходящие звонки, логи разговоров.</p>
      </header>

      <div className="mode-toggle three" role="tablist" aria-label="Auth mode">
        <button className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")} type="button">
          Вход
        </button>
        <button
          className={mode === "register" ? "active" : ""}
          onClick={() => switchMode("register")}
          type="button"
        >
          Регистрация
        </button>
        <button className={mode === "recover" ? "active" : ""} onClick={() => switchMode("recover")} type="button">
          Забыли код
        </button>
      </div>

      <form className="auth-form" onSubmit={handleSubmit}>
        {mode === "register" && (
          <label>
            Имя
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Андрей"
              minLength={2}
              maxLength={80}
              required
            />
          </label>
        )}

        <label>
          Телефон
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(event) => setPhone(formatRuPhoneInput(event.target.value))}
            placeholder="+7(999)999-99-99"
            pattern="\+7\(\d{3}\)\d{3}-\d{2}-\d{2}"
            maxLength={16}
            required
          />
        </label>

        {mode === "login" && (
          <label>
            Код-пароль
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              required
            />
          </label>
        )}

        {readyForPassword && (
          <label>
            Новый код-пароль
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              required
              autoFocus
            />
          </label>
        )}

        {waitingForCall && (
          <div className="code-box verification-box">
            <span>Позвоните с номера {formatPhoneForDisplay(verification.phone)} на</span>
            <strong>{formatPhoneForDisplay(verification.verificationNumber)}</strong>
            <span>Ждём звонок до {formatDeadline(verification.expiresAt)}. После проверки звонок сразу сбросится.</span>
          </div>
        )}

        {readyForPassword && (
          <div className="code-box verification-box">
            <span>Номер подтверждён. Задайте новый код из 6 цифр и завершите действие.</span>
          </div>
        )}

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={loading || (readyForPassword && newPassword.length !== 6)}>
          {loading
            ? "Подождите..."
            : mode === "register"
              ? readyForPassword
                ? "Зарегистрироваться"
                : waitingForCall
                  ? "Отправить новый запрос"
                  : "Создать аккаунт"
              : mode === "recover"
                ? readyForPassword
                  ? "Войти"
                  : waitingForCall
                    ? "Отправить новый запрос"
                    : "Восстановить доступ"
                : "Войти"}
        </button>
      </form>
    </section>
  );
}

export function AuthPage({ onAuthorized }: AuthPageProps) {
  return (
    <main className="shell auth-shell">
      <AuthPanel onAuthorized={onAuthorized} />
    </main>
  );
}
