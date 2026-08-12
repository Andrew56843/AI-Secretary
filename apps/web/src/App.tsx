import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { listenForAuthExpired } from "./lib/api";
import { clearToken, clearUser, getToken, getUser, setToken, setUser } from "./lib/session";
import { AuthPage } from "./pages/AuthPage";
import { AdminPage } from "./pages/AdminPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LandingPage } from "./pages/LandingPage";
import { LegalPage } from "./pages/LegalPage";
import type { AuthResponse, AuthUser } from "./types";

const PUBLIC_PAGE_META: Record<string, { title: string; description: string }> = {
  "/": {
    title: "callsec — AI-секретарь для входящих и исходящих звонков",
    description: "callsec отвечает на входящие звонки, ведёт исходящий обзвон, работает по вашему сценарию и сохраняет записи и транскрибы."
  },
  "/privacy": {
    title: "Политика конфиденциальности — callsec",
    description: "Политика обработки и защиты персональных данных сервиса callsec."
  },
  "/terms": {
    title: "Пользовательское соглашение — callsec",
    description: "Условия использования сервиса голосового AI-секретаря callsec."
  }
};

function PageMetadata() {
  const location = useLocation();

  useEffect(() => {
    const pageMeta = PUBLIC_PAGE_META[location.pathname];
    const isPublic = Boolean(pageMeta);
    document.title = pageMeta?.title ?? "Личный кабинет — callsec";

    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute("content", pageMeta?.description ?? "Личный кабинет сервиса callsec.");

    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    robots?.setAttribute("content", isPublic ? "index, follow, max-image-preview:large" : "noindex, nofollow");

    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    canonical?.setAttribute("href", `https://callsec.ru${isPublic && location.pathname !== "/" ? location.pathname : "/"}`);
  }, [location.pathname]);

  return null;
}

function AppRoutes() {
  const [token, setTokenState] = useState<string | null>(() => {
    const storedUser = getUser<AuthUser>();
    if (!storedUser?.phone) {
      clearToken();
      clearUser();
      return null;
    }
    return getToken();
  });
  const [user, setUserState] = useState<AuthUser | null>(() => {
    const storedUser = getUser<AuthUser>();
    if (!storedUser?.phone) {
      return null;
    }
    return storedUser;
  });

  function handleAuthorized(payload: AuthResponse) {
    setToken(payload.token);
    setUser(payload.user);
    setTokenState(payload.token);
    setUserState(payload.user);
  }

  function handleLogout() {
    clearToken();
    clearUser();
    setTokenState(null);
    setUserState(null);
  }

  useEffect(() => {
    return listenForAuthExpired(handleLogout);
  }, []);

  return (
    <>
      <PageMetadata />
      <Routes>
        <Route path="/" element={token ? <Navigate to="/dashboard" replace /> : <LandingPage onAuthorized={handleAuthorized} />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route
          path="/auth"
          element={token ? <Navigate to="/dashboard" replace /> : <AuthPage onAuthorized={handleAuthorized} />}
        />
        <Route
          path="/dashboard"
          element={
            token && user ? (
              <DashboardPage token={token} user={user} onAuthorized={handleAuthorized} onLogout={handleLogout} />
            ) : (
              <Navigate to="/auth" replace />
            )
          }
        />
        <Route
          path="/admin"
          element={
            token && user ? (
              user.isAdmin ? (
                <AdminPage token={token} user={user} onAuthorized={handleAuthorized} onLogout={handleLogout} />
              ) : (
                <Navigate to="/dashboard" replace />
              )
            ) : (
              <Navigate to="/auth" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to={token ? "/dashboard" : "/"} replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
