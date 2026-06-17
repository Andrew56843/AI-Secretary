import { useState } from "react";
import { Link } from "react-router-dom";
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

const LANDING_CONTACTS = [
  { label: "Телефон", value: "+79054176285", href: "tel:+79054176285", actionLabel: "Позвонить" },
  { label: "Telegram", value: "@Drunlet", href: "https://t.me/Drunlet", actionLabel: "Открыть" },
  { label: "WhatsApp", value: "+79054176285", href: "https://wa.me/79054176285", actionLabel: "Написать" },
  { label: "Email", value: "79054176285@yandex.ru", href: "mailto:79054176285@yandex.ru", actionLabel: "Написать" }
];

export function LandingPage({ onAuthorized }: LandingPageProps) {
  const [authOpen, setAuthOpen] = useState(false);
  const [copiedContact, setCopiedContact] = useState<string | null>(null);

  async function copyContact(key: string, value: string) {
    let copied = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }

    setCopiedContact(key);
    window.setTimeout(() => {
      setCopiedContact((current) => (current === key ? null : current));
    }, 1600);
  }

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
            <a href="#demo">Демо</a>
            <a href="#modes">Возможности</a>
            <a href="#contacts">Контакты</a>
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
          <p className="landing-bonus">При регистрации на балансе сразу 100 ₽ для любых звонков, включая тестовые.</p>
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

      <section className="landing-section landing-demo-section" id="demo">
        <div className="landing-section-heading">
          <p className="eyebrow landing-domain">демонстрация</p>
          <h2>Видео и аудио примеры работы</h2>
        </div>
        <div className="landing-demo-grid">
          <article className="landing-video-demo">
            <div className="landing-video-frame">
              <div className="landing-play-mark" aria-hidden="true">
                <span />
              </div>
              <div>
                <strong>Видео демонстрация</strong>
                <p>Как callsec принимает звонок, ведет сценарий и сохраняет результат в кабинете.</p>
              </div>
            </div>
          </article>
          <article className="landing-audio-demo">
            <div className="landing-audio-copy">
              <strong>Аудио демонстрация</strong>
              <p>Пример живого разговора с AI-секретарем и качества голоса.</p>
            </div>
            <div className="landing-audio-wave" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <audio className="landing-audio-control" controls preload="none" aria-label="Аудио демонстрация callsec" />
          </article>
        </div>
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

      <section className="landing-contacts" id="contacts">
        <div>
          <p className="eyebrow landing-domain">связь</p>
          <h2>Контакты</h2>
        </div>
        <div className="landing-contact-list">
          {LANDING_CONTACTS.map((contact) => (
            <article className="landing-contact-card" key={contact.label}>
              <span className="landing-contact-label">{contact.label}</span>
              <a className="landing-contact-value" href={contact.href} target={contact.href.startsWith("http") ? "_blank" : undefined} rel={contact.href.startsWith("http") ? "noreferrer" : undefined}>
                {contact.value}
              </a>
              <div className="landing-contact-actions">
                <a className="landing-open-link" href={contact.href} target={contact.href.startsWith("http") ? "_blank" : undefined} rel={contact.href.startsWith("http") ? "noreferrer" : undefined}>
                  {contact.actionLabel}
                </a>
                <button className="landing-copy-button" type="button" onClick={() => void copyContact(contact.label, contact.value)}>
                  {copiedContact === contact.label ? "Скопировано" : "Копировать"}
                </button>
              </div>
              <span className="sr-only" aria-live="polite">
                {copiedContact === contact.label ? `${contact.label} скопирован` : ""}
              </span>
            </article>
          ))}
        </div>
      </section>

      <footer className="landing-footer">
        <span>© 2026 callsec</span>
        <a href="mailto:79054176285@yandex.ru">79054176285@yandex.ru</a>
        <Link to="/privacy">Политика конфиденциальности</Link>
        <Link to="/terms">Пользовательское соглашение</Link>
      </footer>

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
