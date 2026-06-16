import { Link } from "react-router-dom";

type LegalPageProps = {
  kind: "privacy" | "terms";
};

const CONTACT_EMAIL = "79054176285@yandex.ru";
const CONTACT_PHONE = "+79054176285";

const PRIVACY_SECTIONS = [
  {
    title: "Information we collect",
    text: [
      "Account information: phone number, authentication data, selected assistant settings, reserved phone numbers, balance and billing history.",
      "Call information: caller and recipient phone numbers, timestamps, call duration, call status, audio recordings and transcripts when call logging is enabled.",
      "Integration information: Telegram linking status and Google Calendar authorization data, including encrypted OAuth tokens and the selected calendar identifier.",
      "Technical information: server logs, request metadata and diagnostic events needed to keep the service secure and reliable."
    ]
  },
  {
    title: "How we use information",
    text: [
      "We use account and call data to operate the AI secretary service, route calls, save conversation history, calculate charges and show call records in the user dashboard.",
      "When Google Calendar is connected, we use calendar access only to create, read or update calendar events that are needed for the user's assistant workflow.",
      "We do not sell personal data. We do not use Google user data for advertising."
    ]
  },
  {
    title: "Google user data",
    text: [
      "Callsec requests Google Calendar access so the assistant can work with the user's calendar on behalf of that user.",
      "Google OAuth tokens are stored encrypted and are used only by the backend service to perform calendar actions requested through the product.",
      "Users can disconnect Google Calendar from the dashboard. They can also revoke access in their Google Account security settings."
    ]
  },
  {
    title: "Sharing and processors",
    text: [
      "We share data only with infrastructure and communication providers needed to provide the service, such as telephony, hosting, AI, speech, Telegram and payment providers.",
      "These providers process data only for service delivery, security, diagnostics and billing."
    ]
  },
  {
    title: "Retention and deletion",
    text: [
      "Account, billing and call records are retained while the account is active or while required for legal, accounting or security reasons.",
      "Users may request deletion of their account data, call recordings, transcripts or integration data by contacting us."
    ]
  },
  {
    title: "Security",
    text: [
      "We use HTTPS, access controls, encrypted secret storage where applicable, and operational monitoring to protect user data.",
      "No internet service is perfectly secure, but we work to keep access limited to the systems and people who need it to operate the service."
    ]
  }
];

const TERMS_SECTIONS = [
  {
    title: "Service",
    text: [
      "Callsec provides an AI phone secretary for incoming and outgoing calls, call transcripts, recordings, integrations and billing tools.",
      "The service is provided as a developing product and may change as features are improved."
    ]
  },
  {
    title: "User responsibilities",
    text: [
      "Users are responsible for the prompts, scripts, contact lists and business data they provide to the service.",
      "Users must have the right to call uploaded contacts and must comply with applicable telecom, privacy, advertising and consumer protection laws."
    ]
  },
  {
    title: "Payments and phone numbers",
    text: [
      "Paid balances are used for subscriptions, phone number reservation, call charges and other paid service features.",
      "Phone number availability may depend on third-party telecom providers and can change over time."
    ]
  },
  {
    title: "Recordings and transcripts",
    text: [
      "Calls may be recorded and transcribed to provide the service, show history in the dashboard and improve reliability.",
      "Users are responsible for informing callers when recording or transcription notices are legally required."
    ]
  },
  {
    title: "Integrations",
    text: [
      "Optional integrations such as Telegram and Google Calendar work only after the user connects them.",
      "Users may disconnect integrations in the dashboard or revoke external access in the provider account."
    ]
  },
  {
    title: "Limitation",
    text: [
      "AI responses, speech recognition and telephony may contain errors or delays. Users should review important call outcomes.",
      "To the maximum extent allowed by law, the service is provided without warranties beyond those expressly stated."
    ]
  }
];

function LegalSection({ title, text }: { title: string; text: string[] }) {
  return (
    <section className="legal-section">
      <h2>{title}</h2>
      {text.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </section>
  );
}

export function LegalPage({ kind }: LegalPageProps) {
  const isPrivacy = kind === "privacy";
  const title = isPrivacy ? "Privacy Policy" : "Terms of Service";
  const sections = isPrivacy ? PRIVACY_SECTIONS : TERMS_SECTIONS;

  return (
    <main className="legal-page">
      <nav className="legal-nav" aria-label="Legal navigation">
        <Link to="/" className="landing-logo">
          callsec
        </Link>
        <div>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </nav>

      <article className="legal-document">
        <p className="eyebrow">callsec.ru</p>
        <h1>{title}</h1>
        <p className="legal-updated">Last updated: June 16, 2026</p>
        <p className="legal-intro">
          This document explains how Callsec handles user data for the AI secretary service available at callsec.ru.
        </p>

        {sections.map((section) => (
          <LegalSection key={section.title} title={section.title} text={section.text} />
        ))}

        <section className="legal-section">
          <h2>Contact</h2>
          <p>
            For privacy, access or deletion requests, contact us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> or{" "}
            <a href={`tel:${CONTACT_PHONE}`}>{CONTACT_PHONE}</a>.
          </p>
        </section>
      </article>
    </main>
  );
}
