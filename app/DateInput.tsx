"use client";

import {
  type ComponentPropsWithoutRef,
  type PointerEvent,
  useCallback,
  useRef,
} from "react";

type DateInputProps = Omit<ComponentPropsWithoutRef<"input">, "type">;

type NativeDateInputProps = DateInputProps & {
  inputType: "date" | "datetime-local";
};

function NativeDateInput({
  className,
  disabled,
  inputType,
  readOnly,
  ...inputProps
}: NativeDateInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openedOnPointerDown = useRef(false);

  const openPicker = useCallback(() => {
    const input = inputRef.current;
    if (!input || disabled || readOnly) return;

    input.focus({ preventScroll: true });
    const pickerInput = input as HTMLInputElement & {
      showPicker?: () => void;
    };

    try {
      if (typeof pickerInput.showPicker === "function") {
        pickerInput.showPicker();
        return;
      }
    } catch {
      // Some browsers only allow showPicker for a direct trusted click.
    }

    input.click();
  }, [disabled, readOnly]);

  const openFromTrigger = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openedOnPointerDown.current = true;
    openPicker();
  };

  const handleTriggerClick = () => {
    if (openedOnPointerDown.current) {
      openedOnPointerDown.current = false;
      return;
    }
    openPicker();
  };

  const handleShellPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    openPicker();
  };

  return (
    <span className="date-input-shell" onPointerDown={handleShellPointerDown}>
      <input
        {...inputProps}
        ref={inputRef}
        type={inputType}
        disabled={disabled}
        readOnly={readOnly}
        className={["date-input-native", className].filter(Boolean).join(" ")}
      />
      <button
        className="date-input-picker-trigger"
        type="button"
        aria-label="打开日期选择器"
        disabled={disabled || readOnly}
        onPointerDown={openFromTrigger}
        onClick={handleTriggerClick}
      />
    </span>
  );
}

export function DateInput(props: DateInputProps) {
  return <NativeDateInput {...props} inputType="date" />;
}

export function DateTimeInput(props: DateInputProps) {
  return <NativeDateInput {...props} inputType="datetime-local" />;
}
