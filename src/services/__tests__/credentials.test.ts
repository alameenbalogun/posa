import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
}));

import { validatePin } from "../credentials";

describe("validatePin", () => {
  it("accepts valid 4-6 digit owner and staff PINs", () => {
    expect(validatePin("2468")).toBeNull();
    expect(validatePin("123456")).toBeNull();
  });

  it("rejects PINs outside the 4-6 digit range", () => {
    expect(validatePin("123")).toBe("Choose a PIN between 4 and 6 digits.");
    expect(validatePin("1234567")).toBe("Choose a PIN between 4 and 6 digits.");
  });
});
