import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
const typography = styles.slice(styles.indexOf("/* Typography V1:"));

test("Typography V1 defines one readable minimum and semantic type tokens", () => {
  for (const token of [
    "--font-min-readable: 13px",
    "--font-hero:",
    "--font-page-title:",
    "--font-section-title: 18px",
    "--font-body: 14px",
    "--font-input: 14px",
    "--font-button: 13px",
    "--font-label: 13px",
    "--font-meta:",
    "--font-badge:",
    "--font-eyebrow:",
  ]) {
    assert.match(styles, new RegExp(token.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));
  }
});

test("Typography V1 makes form controls and action text readable without business changes", () => {
  assert.match(typography, /:is\(input, textarea, select\)[\s\S]*font-size: var\(--font-input\) !important/);
  assert.match(typography, /:is\(input, textarea\)::placeholder[\s\S]*font-size: inherit/);
  assert.match(typography, /\.workspace-shell label[\s\S]*font-size: var\(--font-label\) !important/);
  assert.match(typography, /\.workspace-shell button[\s\S]*font-size: var\(--font-button\) !important/);
  assert.match(typography, /:is\(small, time, em\)[\s\S]*font-size: var\(--font-meta\) !important/);
});

test("Typography V1 covers dashboard, navigation, Work, Orders, Customers, and archives", () => {
  for (const selector of [
    ".nav-item small",
    ".attention-list span",
    ".overview-task-row strong",
    ".table-row strong",
    ".customer-grade-chip",
    ".order-card-risks span",
    ".technical-case-timestamps",
    ".knowledge-detail-status",
  ]) {
    assert.ok(typography.includes(selector), `missing typography coverage for ${selector}`);
  }
  assert.match(typography, /\.workspace-shell \.greeting h1[\s\S]*var\(--font-hero\)/);
  assert.match(typography, /\.section-title h2[\s\S]*var\(--font-page-title\)/);
  assert.match(typography, /\.panel-heading h2[\s\S]*var\(--font-section-title\)/);
});

test("customer editors map all readable roles to the shared Typography V1 tokens", () => {
  for (const [selector, token] of [
    [".customer-editor-toolbar strong", "--font-page-title"],
    [".customer-editor-toolbar small", "--font-meta"],
    [".customer-editor-dialog-backdrop h3", "--font-section-title"],
    [".customer-editor-dialog-backdrop p", "--font-body"],
    [".customer-rating-status strong", "--font-body"],
    [".customer-rating-advice p", "--font-body"],
    [".customer-rating-advice small", "--font-meta"],
    [".editor-heading span", "--font-eyebrow"],
    [".editor-heading h3", "--font-section-title"],
    [".contact-editor summary strong", "--font-body"],
    [".follow-up-item p", "--font-body"],
    [".customer-editor-save-hint", "--font-meta"],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(styles, new RegExp(`${escaped}[\\s\\S]*var\\(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  }

  assert.match(
    typography,
    /\.customer-editor \.form-stack label[\s\S]*font-size: var\(--font-label\) !important/,
  );
  assert.match(
    typography,
    /\.customer-editor \.form-note[\s\S]*font-size: var\(--font-body\) !important/,
  );
  assert.match(styles, /\.detail-summary span[\s\S]*min-height: 28px;[\s\S]*var\(--font-badge\)/);
  assert.match(styles, /\.customer-grade-chip,[\s\S]*\.customer-followup[\s\S]*min-height: 28px;[\s\S]*var\(--font-badge\)/);
  assert.doesNotMatch(
    styles.slice(styles.indexOf(".customer-editor {"), styles.indexOf(".knowledge-detail {")),
    /font-size:\s*(?:[0-9]|1[0-2])(?:\.\d+)?px/,
  );
});
