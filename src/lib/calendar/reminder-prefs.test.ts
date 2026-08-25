import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_PREFS, parseReminderPrefs } from "./reminder-prefs";

describe("reminder preferences", () => {
  it("defaults to off", () => {
    // Never notify someone who has not asked to be notified.
    expect(parseReminderPrefs(null)).toEqual(DEFAULT_REMINDER_PREFS);
    expect(DEFAULT_REMINDER_PREFS.enabled).toBe(false);
  });

  it("survives corrupt storage", () => {
    expect(parseReminderPrefs("not json at all")).toEqual(DEFAULT_REMINDER_PREFS);
    expect(parseReminderPrefs("{")).toEqual(DEFAULT_REMINDER_PREFS);
  });

  it("reads a normal value", () => {
    expect(parseReminderPrefs('{"enabled":true,"leadMin":30}')).toEqual({
      enabled: true,
      leadMin: 30,
    });
  });

  it("clamps a lead time that would arm a timer days out", () => {
    expect(parseReminderPrefs('{"enabled":true,"leadMin":99999}').leadMin).toBe(120);
  });

  it("refuses a negative lead time", () => {
    expect(parseReminderPrefs('{"enabled":true,"leadMin":-5}').leadMin).toBe(0);
  });

  it("falls back when the lead time is not a number", () => {
    expect(parseReminderPrefs('{"enabled":true,"leadMin":"soon"}').leadMin).toBe(10);
  });

  it("keeps 'at the start' rather than treating zero as missing", () => {
    // 0 is falsy; a naive `|| 10` would silently turn it into ten minutes.
    expect(parseReminderPrefs('{"enabled":true,"leadMin":0}').leadMin).toBe(0);
  });
});
