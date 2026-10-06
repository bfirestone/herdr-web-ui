import { describe, expect, it } from "bun:test";

import { matchShortcut, type ShortcutEventLike, type ShortcutId, keepsArrowsForText, shortcutConflict, shortcutKeys } from "./shortcuts.ts";
import { sanitizeShortcutOverrides } from "./shortcutBindings.ts";

function keyEvent(key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...patch };
}

describe("matchShortcut", () => {
  it("uses Command on Apple platforms and Control elsewhere", () => {
    expect(matchShortcut(keyEvent("K", { metaKey: true }), true)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), false)).toBe("palette");
    expect(matchShortcut(keyEvent("k", { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(keyEvent("k", { metaKey: true }), false)).toBeNull();
  });

  it("matches every terminal-safe key", () => {
    expect(matchShortcut(keyEvent("j", { ctrlKey: true }), false)).toBe("toggle-view");
    expect(matchShortcut(keyEvent("B", { ctrlKey: true }), false)).toBe("toggle-sidebar");
    expect(matchShortcut(keyEvent("n", { ctrlKey: true }), false)).toBe("new-session");
    expect(matchShortcut(keyEvent("ArrowUp", { ctrlKey: true }), false)).toBe("previous-pane");
    expect(matchShortcut(keyEvent("ArrowDown", { ctrlKey: true }), false)).toBe("next-pane");
    expect(matchShortcut(keyEvent(",", { ctrlKey: true }), false)).toBe("settings");
    expect(matchShortcut(keyEvent("<", { ctrlKey: true, code: "Comma" }), false)).toBe("settings");
  });

  it("requires Shift and rejects extra or competing modifiers", () => {
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("k", { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(matchShortcut(keyEvent("x", { ctrlKey: true }), false)).toBeNull();
  });

  it("matches the agent order flip and lets an override rebind or disable it", () => {
    expect(matchShortcut(keyEvent("e", { ctrlKey: true }), false)).toBe("flip-order");
    expect(matchShortcut(keyEvent("E", { metaKey: true }), true)).toBe("flip-order");
    expect(matchShortcut(keyEvent("r", { ctrlKey: true }), false, { "flip-order": "r" })).toBe("flip-order");
    expect(matchShortcut(keyEvent("e", { ctrlKey: true }), false, { "flip-order": "r" })).toBeNull();
    expect(matchShortcut(keyEvent("e", { ctrlKey: true }), false, { "flip-order": null })).toBeNull();
  });
});

describe("keepsArrowsForText", () => {
  const classes = (...names: string[]) => ({ contains: (name: string) => names.includes(name) });
  it("leaves Mod+Shift+arrows to the message box and other text fields, where they select text", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", classList: classes("composer-text") })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "text", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "search", classList: classes() })).toBe(true);
    expect(keepsArrowsForText({ tagName: "DIV", isContentEditable: true, classList: classes() })).toBe(true);
  });

  it("switches panes from the terminal and anywhere that is no text field", () => {
    expect(keepsArrowsForText({ tagName: "TEXTAREA", classList: classes("xterm-helper-textarea") })).toBe(false);
    expect(keepsArrowsForText({ tagName: "INPUT", type: "checkbox", classList: classes() })).toBe(false);
    expect(keepsArrowsForText({ tagName: "BUTTON", classList: classes() })).toBe(false);
    expect(keepsArrowsForText(null)).toBe(false);
  });
});

describe("new workspace", () => {
  it("opens with Mod+Shift+O, which a browser tab lets through, and still with Mod+Shift+N", () => {
    const press = (key: string) => matchShortcut({ key, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false);
    expect(press("O")).toBe("new-session");
    expect(press("N")).toBe("new-session");
  });
});

it("overrides remove default bindings, unbinding gives keys back, and IME events never switch panes", () => {
  const key = (value: string): ShortcutEventLike => ({ key: value, ctrlKey: true, metaKey: false, shiftKey: true, altKey: false });
  expect(matchShortcut(key("k"), false, { palette: "p" })).toBeNull();
  expect(matchShortcut(key("p"), false, { palette: "p" })).toBe("palette");
  expect(matchShortcut(key("n"), false, { "new-session": null })).toBeNull();
  expect(matchShortcut({ ...key("k"), isComposing: true }, false)).toBeNull();
  expect(matchShortcut({ ...key("k"), keyCode: 229 }, false)).toBeNull();
});

it("matches shifted digits and detects alias and default-restoration conflicts", () => {
  expect(matchShortcut({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, false, { palette: "1" })).toBe("palette");
  expect(shortcutConflict("palette", ["n"], {})).toBe(true);
  expect(shortcutConflict("palette", shortcutKeys("palette", {}), { palette: "p", settings: "k" })).toBe(true);
});

describe("shortcut overrides", () => {
  it("keeps a flip-order override through the sanitizer", () => {
    expect(sanitizeShortcutOverrides({ "flip-order": "r" })).toEqual({ "flip-order": "r" });
    expect(sanitizeShortcutOverrides({ "flip-order": null })).toEqual({ "flip-order": null });
  });

  // --- Contract assertions ---
  it("holds the shared contracts", () => {
    const id: ShortcutId = "flip-order";
    void id;
  });
});
