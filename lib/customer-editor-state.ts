export type CustomerEditorValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CustomerEditorValue[]
  | { [key: string]: CustomerEditorValue };

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeCustomerEditorValue(
  value: CustomerEditorValue,
  kind = "text",
): CustomerEditorValue {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeCustomerEditorValue(item, kind))
      .sort((left, right) => String(left).localeCompare(String(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeCustomerEditorValue(item)]),
    );
  }
  if (kind === "checkbox") return Boolean(value);
  if (kind === "number") {
    const text = normalizeText(value);
    if (!text) return "";
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (kind === "date") return normalizeText(value).slice(0, 10);
  return normalizeText(value);
}

export function customerEditorStateSignature(
  state: Record<string, CustomerEditorValue>,
) {
  return JSON.stringify(normalizeCustomerEditorValue(state));
}

export function hasCustomerEditorChanges(
  initial: Record<string, CustomerEditorValue>,
  current: Record<string, CustomerEditorValue>,
) {
  return customerEditorStateSignature(initial) !== customerEditorStateSignature(current);
}
