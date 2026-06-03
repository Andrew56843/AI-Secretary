import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { clearToken, clearUser, getToken, getUser, setToken, setUser } from "./lib/session";
import { AuthPage } from "./pages/AuthPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LandingPage } from "./pages/LandingPage";
import type { AuthResponse, AuthUser } from "./types";

export default function App() {
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

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={token ? <Navigate to="/dashboard" replace /> : <LandingPage onAuthorized={handleAuthorized} />} />
        <Route
          path="/auth"
          element={token ? <Navigate to="/dashboard" replace /> : <AuthPage onAuthorized={handleAuthorized} />}
        />
        <Route
          path="/dashboard"
          element={
            token && user ? (
              <DashboardPage token={token} user={user} onLogout={handleLogout} />
            ) : (
              <Navigate to="/auth" replace />
            )
          }
        />
        <Route path="*" element={<Navigate to={token ? "/dashboard" : "/"} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
