import { describe, expect, it } from "vitest";
import { cn, en, fa, faFileSize, faNumber, faPercent, formatToman } from "./utils";

describe("fa", () => {
  it("converts Latin digits to Persian digits", () => {
    expect(fa(1405)).toBe("۱۴۰۵");
    expect(fa("id-12")).toBe("id-۱۲");
  });

  it("leaves strings without digits untouched", () => {
    expect(fa("سلام")).toBe("سلام");
  });
});

describe("en", () => {
  it("converts Persian digits back to Latin", () => {
    expect(en("۱۲۳")).toBe("123");
    expect(en("a۴b")).toBe("a4b");
  });

  it("handles Arabic-Indic digits too", () => {
    expect(en("٤٥")).toBe("45");
  });
});

describe("faNumber", () => {
  it("adds the Persian thousands separator", () => {
    expect(faNumber(12450000)).toBe("۱۲٬۴۵۰٬۰۰۰");
    expect(faNumber(999)).toBe("۹۹۹");
  });
});

describe("formatToman", () => {
  it("puts the unit after the number", () => {
    expect(formatToman(1500)).toBe("۱٬۵۰۰ تومان");
  });
});

describe("faPercent", () => {
  it("uses the Persian percent sign", () => {
    expect(faPercent(18)).toBe("۱۸٪");
    expect(faPercent(12.5, 1)).toBe("۱۲٫۵٪");
  });
});

describe("faFileSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(faFileSize(512)).toBe("۵۱۲ بایت");
    expect(faFileSize(2048)).toBe("۲ کیلوبایت");
    expect(faFileSize(1258291)).toBe("۱٫۲ مگابایت");
  });
});

describe("cn", () => {
  it("joins class values and skips falsy ones", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
    expect(cn("a", ["b", ["c"]])).toBe("a b c");
    expect(cn()).toBe("");
  });
});
