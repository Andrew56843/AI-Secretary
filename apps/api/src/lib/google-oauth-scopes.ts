const GOOGLE_CALENDAR_EVENT_WRITE_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.owned"
]);

export function hasGoogleCalendarEventWriteScope(scope: string | null | undefined) {
  return String(scope ?? "")
    .split(/\s+/)
    .some((item) => GOOGLE_CALENDAR_EVENT_WRITE_SCOPES.has(item));
}
