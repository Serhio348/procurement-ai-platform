import { afterEach, describe, expect, it } from "vitest";
import { openConsolePath } from "./open-console.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("openConsolePath", () => {
  it("leaves /login so the console router can mount the inbox", () => {
    window.history.replaceState(null, "", "/login");
    openConsolePath();
    expect(window.location.pathname).toBe("/");
  });
});