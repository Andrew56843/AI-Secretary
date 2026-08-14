import assert from "node:assert/strict";
import test from "node:test";
import { hasGoogleCalendarEventWriteScope } from "./google-oauth-scopes.js";

test("accepts current and legacy Calendar event write scopes", () => {
  assert.equal(hasGoogleCalendarEventWriteScope("https://www.googleapis.com/auth/calendar.events"), true);
  assert.equal(hasGoogleCalendarEventWriteScope("https://www.googleapis.com/auth/calendar.events.owned"), true);
  assert.equal(hasGoogleCalendarEventWriteScope("https://www.googleapis.com/auth/calendar"), true);
});

test("finds a Calendar event write scope among other granted scopes", () => {
  assert.equal(
    hasGoogleCalendarEventWriteScope(
      "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events"
    ),
    true
  );
});

test("rejects read-only and unrelated scopes", () => {
  assert.equal(hasGoogleCalendarEventWriteScope("https://www.googleapis.com/auth/calendar.readonly"), false);
  assert.equal(hasGoogleCalendarEventWriteScope("https://www.googleapis.com/auth/userinfo.email"), false);
  assert.equal(hasGoogleCalendarEventWriteScope(null), false);
});
