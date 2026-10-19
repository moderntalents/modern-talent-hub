// Selected tabs/chips (Subjects levels + subjects, Activities) and the selected side-menu item use one
// shared "selected" colour pair from app/globals.css: yellow #ffd700 with dark #0f1a24 text, the same in
// light and dark mode. Before this, they used "bg-ink text-white", and in dark mode --ink turns almost
// white, so the selected label was white on white.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = read("app/globals.css");

// WCAG relative luminance / contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]?.toLowerCase();

describe("selected colour pair (app/globals.css)", () => {
  test("yellow #ffd700 with dark #0f1a24 text", () => {
    assert.equal(token("selected"), "#ffd700");
    assert.equal(token("on-selected"), "#0f1a24");
    assert.match(css, /--color-selected:\s*var\(--selected\)/);
    assert.match(css, /--color-on-selected:\s*var\(--on-selected\)/);
  });

  test("not redefined for dark mode, so it is the same in both themes", () => {
    // The dark-mode block: from the media query to the first line that is just "}" (works with LF or CRLF).
    const darkBlock = css.replace(/\r\n/g, "\n").match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}\n/)?.[0];
    assert.ok(darkBlock, "dark-mode block found");
    assert.match(darkBlock, /--ink:/, "it is the block that redefines the theme colours");
    assert.equal(/--selected:|--on-selected:/.test(darkBlock), false);
  });

  test("readable: contrast well above WCAG AA (4.5:1) for small text", () => {
    assert.ok(contrast("#ffd700", "#0f1a24") >= 4.5);
    // The rejected alternative, for the record: white text on this yellow is far too low.
    assert.ok(contrast("#ffd700", "#ffffff") < 2);
  });
});

describe("every selected tab, chip and menu item uses it", () => {
  for (const file of ["app/student/subjects/page.tsx", "app/student/marketplace/page.tsx"]) {
    test(`${file}: selected pill is yellow with dark text; unselected unchanged`, () => {
      const src = read(file);
      assert.match(src, /active \? "border-selected bg-selected text-on-selected" : "border-line bg-surface"/);
      assert.equal(src.includes("bg-ink text-white"), false);
    });
  }

  test("side menu: selected item is yellow with dark text; others unchanged", () => {
    const src = read("components/nav/AppShell.tsx");
    assert.match(src, /active \? "bg-selected text-on-selected" : "text-ink-soft hover:bg-surface-2"/);
    assert.equal(src.includes("bg-ink text-white"), false);
  });
});
