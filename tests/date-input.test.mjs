import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const dateInput = fs.readFileSync(path.join(root, "app/DateInput.tsx"), "utf8");
const workspaceApp = fs.readFileSync(path.join(root, "app/WorkspaceApp.tsx"), "utf8");
const styles = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");

test("DateInput provides one native date picker interaction without changing stored values", () => {
  assert.match(dateInput, /export function DateInput/);
  assert.match(dateInput, /inputType="date"/);
  assert.match(dateInput, /export function DateTimeInput/);
  assert.match(dateInput, /inputType="datetime-local"/);
  assert.match(dateInput, /type=\{inputType\}/);
  assert.match(dateInput, /showPicker\?\:\s*\(\) => void/);
  assert.match(dateInput, /input\.click\(\)/);
  assert.match(dateInput, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(dateInput, /event\.target !== event\.currentTarget/);
  assert.match(dateInput, /onPointerDown=\{openFromTrigger\}/);
  assert.doesNotMatch(dateInput, /onKeyDown=/);
});

test("Workspace date fields reuse DateInput and follow-ups keep a date-only business value", () => {
  assert.match(workspaceApp, /import \{ DateInput \} from "@\/app\/DateInput";/);
  assert.equal(
    workspaceApp.match(/<DateInput\b/g)?.length,
    19,
    "every current date field should use the shared control",
  );
  assert.equal(
    workspaceApp.match(/<DateTimeInput\b/g)?.length ?? 0,
    0,
    "follow-ups record their business date without requiring a time",
  );
  assert.doesNotMatch(workspaceApp, /type="date"|type="datetime-local"/);
});

test("DateInput styling exposes a dedicated calendar trigger without changing form input formatting", () => {
  assert.match(styles, /\.date-input-shell\s*\{[\s\S]*position: relative/);
  assert.match(styles, /\.date-input-picker-trigger\s*\{[\s\S]*position: absolute/);
  assert.match(styles, /\.date-input-native\s*\{[\s\S]*padding-right: 42px/);
  assert.match(styles, /\.date-input-picker-trigger::before/);
});
