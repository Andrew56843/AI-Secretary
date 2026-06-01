import { useState } from "react";
import type { FormEvent } from "react";
import { login, register } from "../lib/api";
import type { AuthResponse } from "../types";

type AuthPageProps = {
  onAuthorized: (data: AuthResponse) => void;
};

type AuthMode = "login" | "register";

export function AuthPage({ onAuthorized }: AuthPageProps) {
  const [mode, setMode] = useState<AuthMode>("register");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response =
        mode === "register"
          ? await register({ email, password, fullName: fullName || undefined })
          : await login({ email, password });
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
          <p className="eyebrow">Portfolio MVP</p>
          <h1>AI Secretary Platform</h1>
          <p className="subtitle">
            SaaS-концепт: клиент задаёт промпт, получает номер, принимает звонки и смотрит логи.
          </p>
        </header>

        <div className="mode-toggle" role="tablist" aria-label="Auth mode">
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            Регистрация
          </button>
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            Вход
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
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="founder@startup.dev"
              required
            />
          </label>

          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Минимум 8 символов"
              minLength={8}
              required
            />
          </label>

          {error && <p className="error-text">{error}</p>}

          <button type="submit" disabled={loading}>
            {loading ? "Подождите..." : mode === "register" ? "Создать аккаунт" : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}
