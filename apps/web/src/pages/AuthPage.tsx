import { useState } from "react";
import type { FormEvent } from "react";
import { forgotPassword, login, register } from "../lib/api";
import type { AuthResponse } from "../types";

type AuthPageProps = {
  onAuthorized: (data: AuthResponse) => void;
};

type AuthMode = "login" | "register" | "recover";

export function AuthPage({ onAuthorized }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("+79054176285");
  const [password, setPassword] = useState("");
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<AuthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setIssuedPassword(null);
    setPendingAuth(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setIssuedPassword(null);

    try {
      if (mode === "register") {
        const response = await register({ phone, fullName: fullName || undefined });
        setPendingAuth(response);
        setIssuedPassword(response.issuedPassword ?? null);
        return;
      }

      if (mode === "recover") {
        const response = await forgotPassword({ phone });
        setIssuedPassword(response.issuedPassword ?? null);
        setMode("login");
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

  return (
    <main className="shell auth-shell">
      <section className="auth-panel">
        <header className="auth-header">
          <p className="eyebrow">AI Secretary</p>
          <h1>Кабинет ИИ-секретаря</h1>
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
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+79054176285"
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

          {issuedPassword && (
            <div className="code-box">
              <span>Тестовый код</span>
              <strong>{issuedPassword}</strong>
            </div>
          )}

          {error && <p className="error-text">{error}</p>}

          {pendingAuth ? (
            <button type="button" onClick={() => onAuthorized(pendingAuth)}>
              Продолжить в кабинет
            </button>
          ) : (
            <button type="submit" disabled={loading}>
              {loading
                ? "Подождите..."
                : mode === "register"
                  ? "Создать аккаунт"
                  : mode === "recover"
                    ? "Получить новый код"
                    : "Войти"}
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
