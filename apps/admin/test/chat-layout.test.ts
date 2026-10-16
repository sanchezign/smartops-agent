import { describe, expect, it } from "vitest";
import { isChatPath } from "../src/components/layout/nav-items";
import { keyboardInset, MIN_INSET } from "../src/lib/use-keyboard-inset";

describe("isChatPath (phase 16 M1)", () => {
  it("a chat fills the screen; the list, the opted-out list and other pages do not", () => {
    expect(isChatPath("/conversations/0197f7a2-6a1b-7c3e-9d4f-1a2b3c4d5e6f")).toBe(true);
    expect(isChatPath("/conversations/abc/")).toBe(true);
    expect(isChatPath("/conversations")).toBe(false);
    expect(isChatPath("/conversations/opted-out")).toBe(false);
    expect(isChatPath("/conversations/opted-out/")).toBe(false);
    expect(isChatPath("/conversations/abc/extra")).toBe(false);
    expect(isChatPath("/catalog/abc")).toBe(false);
  });
});

describe("keyboardInset", () => {
  it("is the part of the layout viewport the visual viewport does not show", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    // iOS pans the visual viewport inside the layout viewport when the keyboard opens
    expect(keyboardInset(800, { height: 500, offsetTop: 120 })).toBe(180);
  });
  it("a browser bar or rounding is not a keyboard", () => {
    expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, { height: 800 - MIN_INSET, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(800, { height: 800 - MIN_INSET - 1, offsetTop: 0 })).toBe(MIN_INSET + 1);
  });
});
