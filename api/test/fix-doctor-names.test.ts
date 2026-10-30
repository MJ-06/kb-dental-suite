// The one-off clean-up of typed doctor names in the imported daily register.
import { describe, expect, it } from "vitest";
import { tidy } from "../scripts/fix-doctor-names.js";

const listed = new Map([["dr. viveyk mittel", "Dr. Viveyk Mittel"], ["dr. manika mittel", "Dr. Manika Mittel"]]);

describe("tidy", () => {
  it("rewrites the known spellings and spacing, and keeps a visit's two doctors", () => {
    expect(tidy("Dr. Viveyk", listed)).toBe("Dr. Viveyk Mittel");
    expect(tidy("Dr. Vivyek Mittel", listed)).toBe("Dr. Viveyk Mittel");
    expect(tidy("Dr.  Manika  MIttel | Dr. Viveyk", listed)).toBe("Dr. Manika Mittel | Dr. Viveyk Mittel");
  });
  it("names a doctor once when the entry named them twice", () => {
    expect(tidy("Dr. Manika Mittel | Dr. Manika", listed)).toBe("Dr. Manika Mittel");
  });
  it("leaves a spelling it was not told about exactly as typed", () => {
    expect(tidy("Dr. Somebody Else", listed)).toBe("Dr. Somebody Else");
  });
});
