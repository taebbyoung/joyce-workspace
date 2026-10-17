"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_TIMEZONE_PREFERENCE,
  getBusinessDate,
  getDeviceTimezone,
  getNextMidnightDelay,
  isValidIanaTimezone,
  normalizeTimezonePreference,
  resolveWorkspaceTimezone,
  type WorkspaceTimezonePreference,
} from "@/lib/workspace-time";

const STORAGE_KEY = "joyce-workspace-timezone-preference";

type WorkspaceTimeValue = {
  preference: WorkspaceTimezonePreference;
  deviceTimezone: string;
  workspaceTimezone: string;
  currentBusinessDate: string;
  checkRevision: number;
  invalidManualTimezone: boolean;
  savePreference: (preference: WorkspaceTimezonePreference) => Promise<void>;
  checkDateAndTimezone: () => void;
};

const WorkspaceTimeContext = createContext<WorkspaceTimeValue | null>(null);

function cachedPreference() {
  if (typeof window === "undefined") return DEFAULT_TIMEZONE_PREFERENCE;
  try {
    return normalizeTimezonePreference(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    return DEFAULT_TIMEZONE_PREFERENCE;
  }
}

export function WorkspaceTimeProvider({ children }: { children: ReactNode }) {
  const initialPreferenceRef = useRef(cachedPreference());
  const initialDeviceRef = useRef(getDeviceTimezone());
  const [preference, setPreference] = useState(initialPreferenceRef.current);
  const [deviceTimezone, setDeviceTimezone] = useState(initialDeviceRef.current);
  const initialTimezone = resolveWorkspaceTimezone(
    initialPreferenceRef.current,
    initialDeviceRef.current,
  );
  const [currentBusinessDate, setCurrentBusinessDate] = useState(() =>
    getBusinessDate(new Date(), initialTimezone),
  );
  const [checkRevision, setCheckRevision] = useState(0);
  const preferenceVersionRef = useRef(0);

  const workspaceTimezone = resolveWorkspaceTimezone(preference, deviceTimezone);
  const invalidManualTimezone =
    preference.mode === "manual" && !isValidIanaTimezone(preference.timezone);

  const applyPreference = useCallback((next: WorkspaceTimezonePreference) => {
    const normalized = normalizeTimezonePreference(next);
    setPreference(normalized);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Local storage is only a startup hint; D1 remains the source of truth.
    }
  }, []);

  const checkDateAndTimezone = useCallback(() => {
    const nextDeviceTimezone = getDeviceTimezone();
    setDeviceTimezone((current) =>
      current === nextDeviceTimezone ? current : nextDeviceTimezone,
    );
    const nextWorkspaceTimezone = resolveWorkspaceTimezone(
      preference,
      nextDeviceTimezone,
    );
    const nextDate = getBusinessDate(new Date(), nextWorkspaceTimezone);
    setCurrentBusinessDate((current) => (current === nextDate ? current : nextDate));
    setCheckRevision((current) => current + 1);
  }, [preference]);

  useEffect(() => {
    const hydrationVersion = preferenceVersionRef.current;
    const controller = new AbortController();
    fetch("/api/settings/timezone", { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new Error(String(result.error || "时区设置读取失败。"));
        if (hydrationVersion !== preferenceVersionRef.current) return;
        applyPreference(normalizeTimezonePreference(result.preference));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [applyPreference]);

  useEffect(() => {
    checkDateAndTimezone();
    const timeout = window.setTimeout(
      checkDateAndTimezone,
      getNextMidnightDelay(new Date(), workspaceTimezone),
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkDateAndTimezone();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", checkDateAndTimezone);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", checkDateAndTimezone);
    };
  }, [checkDateAndTimezone, currentBusinessDate, workspaceTimezone]);

  const savePreference = useCallback(async (next: WorkspaceTimezonePreference) => {
    const normalized = normalizeTimezonePreference(next);
    if (normalized.mode === "manual" && !isValidIanaTimezone(normalized.timezone)) {
      throw new Error("请选择有效的 IANA 时区。");
    }
    const response = await fetch("/api/settings/timezone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preference: normalized }),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(result.error || "时区设置保存失败，请重试"));
    preferenceVersionRef.current += 1;
    applyPreference(normalizeTimezonePreference(result.preference));
  }, [applyPreference]);

  const value = useMemo<WorkspaceTimeValue>(() => ({
    preference,
    deviceTimezone,
    workspaceTimezone,
    currentBusinessDate,
    checkRevision,
    invalidManualTimezone,
    savePreference,
    checkDateAndTimezone,
  }), [
    preference,
    deviceTimezone,
    workspaceTimezone,
    currentBusinessDate,
    checkRevision,
    invalidManualTimezone,
    savePreference,
    checkDateAndTimezone,
  ]);

  return (
    <WorkspaceTimeContext.Provider value={value}>
      {children}
    </WorkspaceTimeContext.Provider>
  );
}

export function useWorkspaceTime() {
  const value = useContext(WorkspaceTimeContext);
  if (!value) throw new Error("useWorkspaceTime must be used inside WorkspaceTimeProvider");
  return value;
}
