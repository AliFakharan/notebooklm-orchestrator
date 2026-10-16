import { describe, expect, it } from "vitest";
import {
  formatJalali,
  formatJalaliNumeric,
  isLeapJalaliYear,
  jalaliMonthLength,
  JALALI_MONTHS,
  toGregorian,
  toJalali,
} from "./jalali";

describe("toJalali", () => {
  it("converts a known Gregorian date (1404/01/01 = 2025-03-21)", () => {
    // Nowruz 1404 falls on 2025-03-21 (local time).
    const d = new Date(2025, 2, 21);
    expect(toJalali(d)).toEqual({ jy: 1404, jm: 1, jd: 1 });
  });

  it("converts the Iranian New Year 1405 (2026-03-21)", () => {
    const d = new Date(2026, 2, 21);
    const j = toJalali(d);
    expect(j.jy).toBe(1405);
    expect(j.jm).toBe(1);
    expect(j.jd).toBe(1);
  });
});

describe("toGregorian", () => {
  it("round-trips with toJalali", () => {
    const original = new Date(2026, 6, 15); // 2026-07-15
    const j = toJalali(original);
    const back = toGregorian(j.jy, j.jm, j.jd);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(6);
    expect(back.getDate()).toBe(15);
  });
});

describe("month lengths", () => {
  it("first six months are 31 days, next five are 30", () => {
    expect(jalaliMonthLength(1405, 1)).toBe(31);
    expect(jalaliMonthLength(1405, 6)).toBe(31);
    expect(jalaliMonthLength(1405, 7)).toBe(30);
    expect(jalaliMonthLength(1405, 11)).toBe(30);
  });

  it("Esfand is 30 in leap years and 29 in common years", () => {
    for (let y = 1400; y < 1420; y++) {
      expect(jalaliMonthLength(y, 12)).toBe(isLeapJalaliYear(y) ? 30 : 29);
    }
    // Both variants occur in this span (the ~4-in-33 leap pattern).
    const lengths = new Set(Array.from({ length: 20 }, (_, i) => jalaliMonthLength(1400 + i, 12)));
    expect(lengths).toEqual(new Set([29, 30]));
  });
});

describe("names", () => {
  it("has 12 month names starting with Farvardin", () => {
    expect(JALALI_MONTHS).toHaveLength(12);
    expect(JALALI_MONTHS[0]).toBe("فروردین");
    expect(JALALI_MONTHS[11]).toBe("اسفند");
  });
});

describe("formatJalali", () => {
  it("formats «day month year» with Persian digits", () => {
    const d = new Date(2026, 2, 21); // 1 Farvardin 1405
    expect(formatJalali(d)).toBe("۱ فروردین ۱۴۰۵");
  });

  it("numeric form is zero-padded", () => {
    const d = new Date(2026, 2, 21);
    expect(formatJalaliNumeric(d)).toBe("۱۴۰۵/۰۱/۰۱");
  });
});
