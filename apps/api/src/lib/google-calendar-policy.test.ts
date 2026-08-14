import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDeterministicSchedulePolicy,
  inferRequestedStartDateTime,
  resolveCalendarAvailabilityMode
} from "./google-calendar.js";

test("extracts a customer gap when the duration is written before 'between appointments'", () => {
  const policy = extractDeterministicSchedulePolicy(
    "Мы работаем с 9 утра до 19:00. Мастер хочет отдохнуть 15 минут между записями."
  );

  assert.equal(policy.gapMinutes, 15);
  assert.deepEqual(policy.workingHours[0], {
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    date: null,
    start: "09:00",
    end: "19:00",
    label: "working hours"
  });
});

test("recovers an exact requested time from recent caller turns", () => {
  const requested = inferRequestedStartDateTime(
    {
      action: "FIND_SLOTS",
      rangeStartDateTime: "2026-08-15T09:00:00+03:00",
      rangeEndDateTime: "2026-08-15T19:00:00+03:00",
      durationMinutes: 30,
      limit: 3
    },
    [
      "User: Да, на завтра на 10 утра.",
      "Assi: Какая услуга нужна?",
      "User: Мужская."
    ].join("\n")
  );

  assert.equal(requested, "2026-08-15T10:00:00+03:00");
});

test("uses the explicit tool argument before transcript inference", () => {
  const requested = inferRequestedStartDateTime(
    {
      action: "FIND_SLOTS",
      requestedStartDateTime: "2026-08-15T10:30:00+03:00",
      rangeStartDateTime: "2026-08-15T09:00:00+03:00",
      rangeEndDateTime: "2026-08-15T19:00:00+03:00"
    },
    "User: А можно в 10:00?"
  );

  assert.equal(requested, "2026-08-15T10:30:00+03:00");
});

test("treats resource bookings as exclusive by default", () => {
  assert.equal(resolveCalendarAvailabilityMode({ action: "CREATE" }), "EXCLUSIVE");
});

test("allows scenario events such as orders to run in parallel", () => {
  assert.equal(
    resolveCalendarAvailabilityMode({ action: "CREATE", availabilityMode: "PARALLEL" }),
    "PARALLEL"
  );
});

test("preserves the availability mode when a parallel event is moved", () => {
  assert.equal(
    resolveCalendarAvailabilityMode(
      { action: "RESCHEDULE", availabilityMode: "EXCLUSIVE" },
      {
        transparency: "transparent",
        extendedProperties: { private: { callsecAvailabilityMode: "PARALLEL" } }
      }
    ),
    "PARALLEL"
  );
});
