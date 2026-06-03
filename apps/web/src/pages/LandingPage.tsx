import { useState } from "react";
import { AuthPanel } from "./AuthPage";
import type { AuthResponse } from "../types";

type LandingPageProps = {
  onAuthorized: (data: AuthResponse) => void;
};

const LANDING_POINTS = [
  "Входящие звонки принимает AI-секретарь",
  "Исходящий обзвон идет по вашей базе",
  "Транскрибы и записи остаются в кабинете"
];

const LANDING_STEPS = [
  ["1", "Создайте сценарий", "Выберите шаблон или опишите, как AI должен отвечать клиентам."],
  ["2", "Получите номер", "После пополнения баланса номер закрепляется за аккаунтом."],
  ["3", "Смотрите результат", "Записи, транскрибы и статусы звонков остаются в кабинете."]
];

const LANDING_MODES = [
  {
    title: "Входящие звонки",
    text: "AI отвечает на закрепленный номер, уточняет детали и переводит сложные разговоры на владельца."
  },
  {
    title: "Исходящий обзвон",
    text: "Загрузите базу номеров, а callsec будет дозваниваться по очереди и фиксировать итог разговора."
  },
  {
    title: "Интеграции",
    text: "Telegram для транскрибов, Google Calendar для записей и платежи для баланса подключаются по мере роста сервиса."
  }
];

export function LandingPage({ onAuthorized }: LandingPageProps) {
  const [authOpen, setAuthOpen] = useState(false);

  return (
    <main className="landing-page">
      <section className="landing-hero">
        <div className="landing-scene" aria-hidden="true">
          <div className="scene-phone">
            <span />
            <strong>+7 495 001 00 01</strong>
            <em>AI секретарь на линии</em>
          </div>
          <div className="scene-wave">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="scene-panel scene-panel-left">
            <strong>Входящий</strong>
            <span>Клиент записан на 14:30</span>
          </div>
          <div className="scene-panel scene-panel-right">
            <strong>Исходящий</strong>
            <span>3 номера ожидают обзвона</span>
          </div>
        </div>

        <header className="landing-nav">
          <span className="landing-logo">callsec</span>
          <div className="landing-nav-links">
            <a href="#how">Как работает</a>
            <a href="#modes">Возможности</a>
            <button className="outline-link" type="button" onClick={() => setAuthOpen(true)}>
              Войти
            </button>
          </div>
        </header>

        <div className="landing-copy">
          <p className="eyebrow landing-domain">callsec.ru</p>
          <h1>callsec</h1>
          <p>
            AI-секретарь для входящих и исходящих звонков: отвечает клиентам, ведет сценарий, фиксирует результат и
            передает сложные разговоры владельцу.
          </p>
          <div className="landing-actions">
            <button className="primary-link" type="button" onClick={() => setAuthOpen(true)}>
              Начать
            </button>
            <button className="ghost-link" type="button" onClick={() => setAuthOpen(true)}>
              Авторизация
            </button>
          </div>
        </div>
      </section>

      <section className="landing-summary" aria-label="Возможности callsec">
        {LANDING_POINTS.map((point) => (
          <article className="landing-summary-item" key={point}>
            <span />
            <strong>{point}</strong>
          </article>
        ))}
      </section>

      <section className="landing-section" id="how">
        <div className="landing-section-heading">
          <p className="eyebrow landing-domain">быстрый запуск</p>
          <h2>От сценария до первого звонка</h2>
        </div>
        <div className="landing-flow">
          {LANDING_STEPS.map(([number, title, text]) => (
            <article className="landing-flow-item" key={title}>
              <span>{number}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section" id="modes">
        <div className="landing-section-heading">
          <p className="eyebrow landing-domain">один кабинет</p>
          <h2>Для звонков, записей и контроля</h2>
        </div>
        <div className="landing-mode-grid">
          {LANDING_MODES.map((mode) => (
            <article className="landing-mode-item" key={mode.title}>
              <strong>{mode.title}</strong>
              <p>{mode.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-cta">
        <div>
          <p className="eyebrow landing-domain">callsec.ru</p>
          <h2>Проверьте сценарий на тестовом звонке</h2>
        </div>
        <button className="primary-link" type="button" onClick={() => setAuthOpen(true)}>
          Войти в кабинет
        </button>
      </section>

      {authOpen && (
        <div className="modal-backdrop landing-auth-backdrop" role="presentation" onMouseDown={() => setAuthOpen(false)}>
          <div className="landing-auth-modal" role="dialog" aria-modal="true" aria-label="Вход в callsec" onMouseDown={(event) => event.stopPropagation()}>
            <button className="icon-mini-btn landing-auth-close" type="button" aria-label="Закрыть" onClick={() => setAuthOpen(false)}>
              ×
            </button>
            <AuthPanel className="auth-panel-modal" onAuthorized={onAuthorized} />
          </div>
        </div>
      )}
    </main>
  );
}
