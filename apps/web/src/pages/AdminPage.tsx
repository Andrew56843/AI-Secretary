import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { adjustAdminUserBalance, getAdminUsers, impersonateAdminUser } from "../lib/api";
import type { AdminUser, AuthResponse, AuthUser } from "../types";

type AdminPageProps = {
  token: string;
  user: AuthUser;
  onAuthorized: (payload: AuthResponse) => void;
  onLogout: () => void;
};

const ADMIN_PHONE = "+79054176285";

function formatRubles(amount: number) {
  const hasKopecks = Math.abs(amount % 1) > Number.EPSILON;

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: hasKopecks ? 2 : 0,
    maximumFractionDigits: hasKopecks ? 2 : 0
  }).format(amount);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString("ru-RU");
}

function parseRubles(value: string) {
  const normalized = value.replace(",", ".").trim();
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : NaN;
}

function updateUser(users: AdminUser[], updatedUser: AdminUser) {
  return users.map((user) => (user.id === updatedUser.id ? updatedUser : user));
}

export function AdminPage({ token, user, onAuthorized, onLogout }: AdminPageProps) {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getAdminUsers(token)
      .then((response) => {
        if (!mounted) {
          return;
        }
        setUsers(response.users);
      })
      .catch((loadError) => {
        if (mounted) {
          setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить пользователей");
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [token]);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      const response = await getAdminUsers(token, search);
      setUsers(response.users);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Не удалось выполнить поиск");
    } finally {
      setLoading(false);
    }
  }

  async function handleBalance(userId: string, operation: "increase" | "decrease") {
    const amountRub = parseRubles(amountDrafts[userId] || "100");
    if (!Number.isFinite(amountRub) || amountRub <= 0) {
      setError("Введите сумму больше нуля");
      return;
    }

    setSavingUserId(userId);
    setError(null);
    setNotice(null);

    try {
      const response = await adjustAdminUserBalance(token, userId, {
        operation,
        amountRub,
        note: noteDrafts[userId]?.trim() || undefined
      });
      setUsers((current) => updateUser(current, response.user));
      setNotice("Баланс обновлён");
    } catch (balanceError) {
      setError(balanceError instanceof Error ? balanceError.message : "Не удалось изменить баланс");
    } finally {
      setSavingUserId(null);
    }
  }

  async function handleImpersonate(targetUser: AdminUser) {
    const confirmed = window.confirm(`Войти в кабинет пользователя ${targetUser.phone}?`);
    if (!confirmed) {
      return;
    }

    setSavingUserId(targetUser.id);
    setError(null);
    setNotice(null);

    try {
      const response = await impersonateAdminUser(token, targetUser.id);
      onAuthorized(response);
      navigate("/dashboard");
    } catch (impersonateError) {
      setError(impersonateError instanceof Error ? impersonateError.message : "Не удалось войти в аккаунт");
    } finally {
      setSavingUserId(null);
    }
  }

  if (user.phone !== ADMIN_PHONE) {
    return (
      <main className="admin-page">
        <section className="admin-denied">
          <h1>Доступ закрыт</h1>
          <p>Эта страница доступна только администратору.</p>
          <Link className="landing-copy-button" to="/dashboard">
            В кабинет
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <p>callsec admin</p>
          <h1>Аккаунты пользователей</h1>
        </div>
        <nav>
          <Link className="outline-btn" to="/dashboard">
            В кабинет
          </Link>
          <button className="outline-btn" type="button" onClick={onLogout}>
            Выйти
          </button>
        </nav>
      </header>

      <section className="admin-toolbar">
        <form className="admin-search" onSubmit={handleSearch}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Телефон или имя"
            type="search"
          />
          <button type="submit">Найти</button>
        </form>
        <span>{loading ? "Загрузка..." : `${users.length} аккаунтов`}</span>
      </section>

      {notice && <div className="success-banner">{notice}</div>}
      {error && <div className="error-banner">{error}</div>}

      <section className="admin-table-shell">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Пользователь</th>
              <th>Баланс</th>
              <th>Номер</th>
              <th>Интеграции</th>
              <th>Активность</th>
              <th>Баланс</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => {
              const saving = savingUserId === account.id;
              const amount = amountDrafts[account.id] ?? "100";
              const note = noteDrafts[account.id] ?? "";

              return (
                <tr key={account.id}>
                  <td>
                    <strong>{account.phone}</strong>
                    <span>{account.fullName || "Без имени"}</span>
                    <small>{formatDateTime(account.createdAt)}</small>
                  </td>
                  <td>
                    <strong>{formatRubles(account.rubleBalance)}</strong>
                    <span>{account.rubleBalanceKopecks} коп.</span>
                  </td>
                  <td>
                    <span>{account.reservedNumber?.number ?? "Не зарезервирован"}</span>
                    <small>До {formatDateTime(account.numberRentExpiresAt)}</small>
                  </td>
                  <td>
                    <span>Telegram: {account.telegramStatus}</span>
                    <span>Google: {account.googleStatus}</span>
                  </td>
                  <td>
                    <span>Профили: {account.profilesCount}</span>
                    <span>Контакты: {account.outboundContactsCount}</span>
                    <span>Операции: {account.billingTransactionsCount}</span>
                  </td>
                  <td>
                    <div className="admin-balance-form">
                      <input
                        min="0.01"
                        step="0.01"
                        type="number"
                        value={amount}
                        onChange={(event) =>
                          setAmountDrafts((current) => ({ ...current, [account.id]: event.target.value }))
                        }
                      />
                      <input
                        value={note}
                        onChange={(event) =>
                          setNoteDrafts((current) => ({ ...current, [account.id]: event.target.value }))
                        }
                        placeholder="Комментарий"
                      />
                      <div>
                        <button type="button" disabled={saving} onClick={() => handleBalance(account.id, "increase")}>
                          + ₽
                        </button>
                        <button
                          className="danger-btn"
                          type="button"
                          disabled={saving}
                          onClick={() => handleBalance(account.id, "decrease")}
                        >
                          - ₽
                        </button>
                      </div>
                    </div>
                  </td>
                  <td>
                    <button
                      className="outline-btn"
                      type="button"
                      disabled={saving}
                      onClick={() => handleImpersonate(account)}
                    >
                      Войти
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!loading && users.length === 0 && <div className="empty-state">Пользователи не найдены</div>}
      </section>
    </main>
  );
}
