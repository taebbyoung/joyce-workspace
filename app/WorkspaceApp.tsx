"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import { DateInput } from "@/app/DateInput";
import {
  beginAsyncDataLoad,
  createAsyncDataState,
  rejectAsyncData,
  resolveAsyncData,
  type AsyncDataState,
  updateAsyncData,
} from "@/app/async-data-state";
import {
  parseKnowledgeArchive,
  parseTechnicalCaseArchive,
  type KnowledgeArchiveDraft,
} from "@/lib/structured-archive";
import { sortTasksByCompletedAt } from "@/lib/task-completion-sort";
import {
  sortUpcomingTasks,
  taskReminderDate,
} from "@/lib/upcoming-task-sort";
import {
  isDateInMonth,
  isOrderCompleted,
  sortActiveOrders,
  sortCompletedOrders,
} from "@/lib/order-workflow";
import { requiresOrderSalesImpactConfirmation } from "@/lib/order-sales-impact";
import { normalizeOrderPayments } from "@/lib/order-payments";
import {
  buildAttributedCustomerContribution,
  buildAttributedSalesTrend,
  getSalesBusinessDate,
  groupAttributedOrdersByYear,
  getShippingDateState,
  isExpectedShippingInMonth,
  sumAttributedVehicleSales,
} from "@/lib/order-sales-attribution";
import {
  attentionIdentity,
  groupHomeAttention,
  syncWorkTaskAttention,
  workAttentionMessage,
} from "@/lib/work-attention";
import { syncCustomerFollowUpAttention } from "@/lib/customer-attention";
import {
  EXISTING_CONTACT_CYCLES,
  getCustomerFollowUpState,
  POTENTIAL_CONTACT_CYCLES,
  POTENTIAL_FOLLOWUP_SUGGESTIONS,
  normalizeCustomerGrade,
  ratingReviewDue,
  sortCustomersForLifecycle,
} from "@/lib/customer-priority";
import {
  customerEditorStateSignature,
  normalizeCustomerEditorValue,
  type CustomerEditorValue,
} from "@/lib/customer-editor-state";
import {
  createWorkspaceBootstrapRequest,
  isValidHomeBootstrapResponse,
  WorkspaceBootstrapTimeoutError,
} from "@/lib/workspace-bootstrap";
import {
  findOrderImportHeaderRow,
  orderImportFields,
  primaryOrderImportFieldKeys,
} from "@/lib/order-import-mapping";
import type { HomeBootstrapData } from "@/lib/home-bootstrap";
import {
  EDITABLE_LEAD_STATUSES,
  LEAD_COMPANY_TYPES,
  LEAD_DECISION_MAKER_FITS,
  LEAD_MARKET_FITS,
  LEAD_MOTO_EV_BUSINESSES,
  LEAD_PRIORITIES,
  LEAD_SOURCES,
  leadStatusLabels,
  sortLeads,
} from "@/lib/business-development";

type Row = Record<string, any>;

const FOLLOW_UP_INITIAL_LIMIT = 6;
const FOLLOW_UP_PAGE_SIZE = 10;
const customerFollowUpCache = new Map<string, {
  followUps: Row[];
  total: number;
  hasMore: boolean;
}>();

type CustomerContactDraft = {
  name: string;
  position: string;
  email: string;
  phone: string;
  whatsapp: string;
  wechat: string;
  linkedin: string;
  notes: string;
  isPrimary: boolean;
};

function emptyCustomerContactDraft(): CustomerContactDraft {
  return {
    name: "",
    position: "",
    email: "",
    phone: "",
    whatsapp: "",
    wechat: "",
    linkedin: "",
    notes: "",
    isPrimary: false,
  };
}

type TaskActionResult =
  | { ok: true; task?: Row }
  | { ok: false; error: string };

type ProjectActionResult =
  | { ok: true; project?: Row }
  | { ok: false; error: string };

const TASK_WRITE_TIMEOUT_MS = 9_000;
const TASK_WRITE_SLOW_MS = 2_500;

function taskWriteErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (message === "TASK_WRITE_TIMEOUT") {
    return "网络连接超时，请检查网络或 VPN 后重试。";
  }
  if (
    typeof navigator !== "undefined" &&
    !navigator.onLine
  ) {
    return "网络连接异常，请检查网络或 VPN 后重试。";
  }
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return "网络连接异常，请检查网络或 VPN 后重试。";
  }
  return message || fallback;
}

function taskCompletionFailureMessage(task: Row | undefined, error: unknown) {
  const title = String(task?.title || "该任务");
  const message = error instanceof Error ? error.message : String(error || "");
  if (message === "TASK_WRITE_TIMEOUT") {
    return `“${title}”未完成：保存超时，请重试`;
  }
  if (
    (typeof navigator !== "undefined" && !navigator.onLine) ||
    /failed to fetch|networkerror|network request failed/i.test(message)
  ) {
    return `“${title}”未完成：网络异常，请重试`;
  }
  return `“${title}”未完成：保存失败，请重试`;
}

async function postWorkMutation(endpoint: string, payload: Row) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TASK_WRITE_TIMEOUT_MS);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new Error("TASK_WRITE_TIMEOUT");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function taskPatchForLocalState(action: string, fields: Row) {
  const patch: Row = { ...fields };
  if (Object.prototype.hasOwnProperty.call(patch, "reminderDate")) {
    patch.reminder_date = patch.reminderDate || null;
    delete patch.reminderDate;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "recurrenceRule")) {
    patch.recurrence_rule = patch.recurrenceRule || "none";
    delete patch.recurrenceRule;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "nextAction")) {
    patch.next_action = patch.nextAction || null;
    delete patch.nextAction;
  }
  if (action === "status" && fields.status === "snoozed") {
    patch.status = "snoozed";
    patch.snoozed_until = patch.reminder_date || null;
  }
  return patch;
}

type AttentionTarget = {
  type: "task" | "project" | "order" | "customer" | "after_sales_case";
  id: string;
};

async function readApiJson(
  response: Response,
  fallbackMessage: string,
): Promise<Row> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const body = await response.text();
  if (!contentType.includes("application/json")) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("登录状态已失效，请刷新页面并重新登录。");
    }
    if (response.status === 404) {
      throw new Error("服务器尚未提供这项功能，请刷新页面后重试。");
    }
    throw new Error("服务器返回了异常页面，未能完成操作。请刷新后重试。");
  }
  let result: Row;
  try {
    result = body ? JSON.parse(body) : {};
  } catch {
    throw new Error("服务器返回的数据格式异常，请稍后重试。");
  }
  if (!response.ok) {
    throw new Error(String(result.error || fallbackMessage));
  }
  return result;
}

type View =
  | "home"
  | "work"
  | "customers"
  | "leads"
  | "orders"
  | "after-sales"
  | "knowledge"
  | "content"
  | "settings";

function workspaceLoadingLabel(view: View) {
  const labels: Record<View, string> = {
    home: "正在加载工作概览…",
    work: "正在加载工作任务…",
    customers: "正在加载客户…",
    leads: "正在加载新客线索…",
    orders: "正在加载订单…",
    "after-sales": "正在加载售后技术案例…",
    knowledge: "正在加载知识库…",
    content: "正在加载内容运营…",
    settings: "正在加载设置…",
  };
  return labels[view];
}

type WorkspaceData = HomeBootstrapData & {
  tasks: Row[];
  customers: Row[];
  contacts: Row[];
  orders: Row[];
  orderItems: Row[];
  orderPayments: Row[];
  orderRisks: Row[];
  orderStatusHistory: Row[];
  accessorySales: Row[];
  projects: Row[];
  sourceDocuments: Row[];
  knowledge: Row[];
  playbook: Row[];
  content: Row[];
  integrity: Row;
};

function viewRequiresWorkspaceData(view: View) {
  return ["work", "customers", "orders", "knowledge", "content", "settings"].includes(view);
}

type AfterSalesPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
};

type AfterSalesListCache = {
  cases: Row[];
  modelSuggestions: string[];
  pagination: AfterSalesPagination;
  loaded: boolean;
};

type CompletedTasksCache = {
  tasks: Row[];
  offset: number;
  hasMore: boolean;
};

function emptyAfterSalesListCache(): AfterSalesListCache {
  return {
    cases: [],
    modelSuggestions: [],
    pagination: {
      page: 1,
      pageSize: 30,
      total: 0,
      totalPages: 1,
      hasNext: false,
    },
    loaded: false,
  };
}

const navItems: Array<{ id: View; label: string; hint?: string }> = [
  { id: "home", label: "首页" },
  { id: "work", label: "工作" },
  { id: "customers", label: "客户" },
  { id: "leads", label: "新客开发" },
  { id: "orders", label: "订单" },
  { id: "after-sales", label: "售后技术案例库" },
  { id: "knowledge", label: "知识库" },
  { id: "content", label: "内容运营" },
  { id: "settings", label: "设置" },
];

const mobilePrimaryViews: View[] = ["home", "work", "customers", "orders"];

const greetings = [
  "Good morning, Joyce. You don’t have to do everything today—just the right things, one by one.",
  "Morning, Joyce. May today feel lighter than yesterday and kinder than you expect.",
  "You’re doing better than you think, Joyce. Take today at your own pace.",
  "Good morning, Joyce. A clear next step is more than enough for now.",
  "Morning, Joyce. Let’s make space for the work that actually matters.",
  "Hello, Joyce. Tiny progress still counts—and coffee is allowed to help.",
  "Good morning, Joyce. Keep it thoughtful, keep it human, and let the rest unfold.",
];

function formatCny(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatDate(value: unknown) {
  const text = String(value ?? "");
  return text ? text.slice(0, 10) : "未设置";
}

function formatCompletedAt(value: unknown, emptyLabel = "完成时间未记录") {
  const text = String(value ?? "");
  if (!text) return emptyLabel;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = localDateText(date);
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (day === localDateText(now)) return `今天 ${time}`;
  if (day === localDateText(yesterday)) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
  }
  return `${day} ${time}`;
}

function dailyGreeting() {
  const iso = new Date().toISOString().slice(0, 10);
  const hash = [...iso].reduce((total, char) => total + char.charCodeAt(0), 0);
  return greetings[hash % greetings.length];
}

function statusClass(value: string) {
  if (/已完成|completed|approved|已关闭|current|confirmed|已发布/.test(value))
    return "status good";
  if (/风险|异常|延期|failed|snoozed|needs_review|pending_review|待确认|未收款/.test(value))
    return "status warning";
  return "status";
}

function knowledgeStatusValue(item: Row) {
  const aiStatus = String(item.ai_processing_status || "");
  const humanStatus = String(item.human_review_status || "");
  if (aiStatus === "failed") return "failed";
  if (aiStatus === "source_only") return "source_only";
  if (humanStatus === "approved" || item.joyce_approved) return "approved";
  return "pending_review";
}

function knowledgeStatusLabel(item: Row) {
  const labels: Record<string, string> = {
    approved: "已批准",
    pending_review: "待 Joyce 审核",
    source_only: "仅保留原文",
    failed: "处理失败",
  };
  const value = knowledgeStatusValue(item);
  return labels[value] || value;
}

function parseTags(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return String(value || "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

const parseList = parseTags;

function taskStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    pending: "待处理",
    in_progress: "进行中",
    completed: "已完成",
    snoozed: "已稍后提醒",
    cancelled: "已取消",
    待处理: "待处理",
    进行中: "进行中",
    已完成: "已完成",
    延期: "已稍后提醒",
  };
  return labels[String(value ?? "")] ?? String(value ?? "待处理");
}

function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function SectionTitle({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function Modal({
  open,
  title,
  children,
  onClose,
  viewportFixed = false,
  bodyRef,
  dismissOnBackdrop = true,
  hideClose = false,
  hideHeader = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  viewportFixed?: boolean;
  bodyRef?: { current: HTMLDivElement | null };
  dismissOnBackdrop?: boolean;
  hideClose?: boolean;
  hideHeader?: boolean;
}) {
  const [portalReady, setPortalReady] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => setPortalReady(true), []);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || !viewportFixed) return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const bodyStyle = document.body.style;
    const htmlStyle = document.documentElement.style;
    const previous = {
      bodyOverflow: bodyStyle.overflow,
      bodyPosition: bodyStyle.position,
      bodyTop: bodyStyle.top,
      bodyLeft: bodyStyle.left,
      bodyRight: bodyStyle.right,
      bodyWidth: bodyStyle.width,
      htmlOverflow: htmlStyle.overflow,
    };

    bodyStyle.overflow = "hidden";
    bodyStyle.position = "fixed";
    bodyStyle.top = `-${scrollY}px`;
    bodyStyle.left = `-${scrollX}px`;
    bodyStyle.right = "0";
    bodyStyle.width = "100%";
    htmlStyle.overflow = "hidden";

    return () => {
      bodyStyle.overflow = previous.bodyOverflow;
      bodyStyle.position = previous.bodyPosition;
      bodyStyle.top = previous.bodyTop;
      bodyStyle.left = previous.bodyLeft;
      bodyStyle.right = previous.bodyRight;
      bodyStyle.width = previous.bodyWidth;
      htmlStyle.overflow = previous.htmlOverflow;
      window.scrollTo(scrollX, scrollY);
    };
  }, [open, viewportFixed]);

  useEffect(() => {
    if (!open || !viewportFixed) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
  }, [open, viewportFixed]);

  if (!open || !portalReady) return null;
  const modal = (
    <div
      className={`modal-backdrop${viewportFixed ? " modal-backdrop-viewport" : ""}`}
      role="presentation"
      onMouseDown={
        dismissOnBackdrop
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
    >
      <section
        className={`modal-card${viewportFixed ? " modal-card-viewport" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!hideHeader ? (
          <div className="modal-head">
            <h2>{title}</h2>
            {!hideClose ? (
              <button
                className="quiet-button"
                type="button"
                onClick={onClose}
                ref={closeButtonRef}
              >
                关闭
              </button>
            ) : null}
          </div>
        ) : null}
        {viewportFixed ? (
          <div className="modal-body modal-body-viewport" ref={bodyRef}>
            {children}
          </div>
        ) : children}
      </section>
    </div>
  );
  return createPortal(modal, document.body);
}

export function WorkspaceApp() {
  const [view, setView] = useState<View>("home");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [homeState, setHomeState] = useState<AsyncDataState<HomeBootstrapData>>(
    () => beginAsyncDataLoad(createAsyncDataState()),
  );
  const [workspaceState, setWorkspaceState] = useState<
    AsyncDataState<WorkspaceData>
  >(() => createAsyncDataState());
  const homeData = homeState.data;
  const [workspaceStartupFailure, setWorkspaceStartupFailure] = useState<
    "timeout" | null
  >(null);
  const [workspaceLoadFailure, setWorkspaceLoadFailure] = useState("");
  const homeBootstrapRequestRef = useRef<{
    id: number;
    request: ReturnType<typeof createWorkspaceBootstrapRequest<HomeBootstrapData>>;
  } | null>(null);
  const homeBootstrapRequestIdRef = useRef(0);
  const workspaceBootstrapRequestRef = useRef<{
    id: number;
    request: ReturnType<typeof createWorkspaceBootstrapRequest<WorkspaceData>>;
  } | null>(null);
  const workspaceBootstrapRequestIdRef = useRef(0);
  const workspaceLoadPromiseRef = useRef<Promise<boolean> | null>(null);
  const workspaceLoadedRef = useRef(false);
  const data = workspaceState.data;
  const setData = useCallback(
    (
      value:
        | WorkspaceData
        | null
        | ((current: WorkspaceData | null) => WorkspaceData | null),
    ) => {
      setWorkspaceState((current) => {
        const nextData =
          typeof value === "function"
            ? value(current.data)
            : value;
        return updateAsyncData(current, nextData);
      });
    },
    [],
  );
  const [recordModal, setRecordModal] = useState<
    "task" | "project" | "customer" | "order" | "knowledge" | null
  >(null);
  const [recordDefaults, setRecordDefaults] = useState<Row>({});
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [customerTab, setCustomerTab] = useState<
    "existing" | "potential_customer" | "potential_lead"
  >("existing");
  const [knowledgeTab, setKnowledgeTab] = useState<
    "library" | "playbook" | "sources"
  >("library");
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Row | null>(null);
  const [customerFollowUpFocusId, setCustomerFollowUpFocusId] = useState("");
  const customerCloseRequestRef = useRef<(() => void) | null>(null);
  const [selectedKnowledge, setSelectedKnowledge] = useState<Row | null>(null);
  const [afterSalesListCache, setAfterSalesListCache] =
    useState<AfterSalesListCache>(emptyAfterSalesListCache);
  const [completedTasksState, setCompletedTasksState] = useState<
    AsyncDataState<CompletedTasksCache>
  >(() => createAsyncDataState());
  const [knowledgeCreateOpen, setKnowledgeCreateOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [attentionTarget, setAttentionTarget] = useState<AttentionTarget | null>(null);
  const consumeAttentionTarget = useCallback((consumedTarget: AttentionTarget) => {
    setAttentionTarget((current) =>
      current?.type === consumedTarget.type && current.id === consumedTarget.id ? null : current,
    );
  }, []);

  useEffect(() => {
    if (!data || attentionTarget?.type !== "customer") return;
    const customer = data.customers.find(
      (item) => String(item.id) === attentionTarget.id,
    );
    if (!customer) return;
    setSelectedCustomer(customer);
    setCustomerFollowUpFocusId(attentionTarget.id);
    consumeAttentionTarget(attentionTarget);
  }, [attentionTarget, data, consumeAttentionTarget]);

  const loadHome = useCallback(async () => {
    homeBootstrapRequestRef.current?.request.abort();
    const requestId = ++homeBootstrapRequestIdRef.current;
    const request = createWorkspaceBootstrapRequest<HomeBootstrapData>("/api/home");
    homeBootstrapRequestRef.current = { id: requestId, request };
    setWorkspaceStartupFailure(null);
    setHomeState((current) => beginAsyncDataLoad(current));
    try {
      const result = await request.promise;
      if (requestId !== homeBootstrapRequestIdRef.current) return false;
      if (!isValidHomeBootstrapResponse(result)) {
        throw new Error("首页响应格式无效，请重试。");
      }
      setHomeState(resolveAsyncData(result));
      return true;
    } catch (requestError) {
      if (
        requestId !== homeBootstrapRequestIdRef.current ||
        request.signal.aborted && !(requestError instanceof WorkspaceBootstrapTimeoutError)
      ) {
        return false;
      }
      setWorkspaceStartupFailure(
        requestError instanceof WorkspaceBootstrapTimeoutError ? "timeout" : null,
      );
      setHomeState((current) =>
        rejectAsyncData(
          current,
          requestError instanceof WorkspaceBootstrapTimeoutError
            ? "网络连接较慢，或服务暂时未响应。请重试。"
            : requestError instanceof Error
              ? requestError.message
              : "首页加载失败。",
        ),
      );
      return false;
    } finally {
      if (homeBootstrapRequestRef.current?.id === requestId) {
        homeBootstrapRequestRef.current = null;
      }
    }
  }, []);

  const loadWorkspace = useCallback(async (force = false): Promise<boolean> => {
    if (!force && workspaceLoadedRef.current) return true;
    if (!force && workspaceLoadPromiseRef.current) {
      return workspaceLoadPromiseRef.current;
    }
    workspaceBootstrapRequestRef.current?.request.abort();
    const requestId = ++workspaceBootstrapRequestIdRef.current;
    const request = createWorkspaceBootstrapRequest<WorkspaceData>("/api/workspace");
    workspaceBootstrapRequestRef.current = { id: requestId, request };
    setWorkspaceLoadFailure("");
    setWorkspaceState((current) => beginAsyncDataLoad(current));
    const pending = (async () => {
      try {
        const result = await request.promise;
        if (requestId !== workspaceBootstrapRequestIdRef.current) return false;
        workspaceLoadedRef.current = true;
        setWorkspaceState(resolveAsyncData(result));
        return true;
      } catch (requestError) {
        if (
          requestId !== workspaceBootstrapRequestIdRef.current ||
          request.signal.aborted && !(requestError instanceof WorkspaceBootstrapTimeoutError)
        ) {
          return false;
        }
        const message = requestError instanceof WorkspaceBootstrapTimeoutError
          ? "工作区加载超时，请重试。"
          : requestError instanceof Error
            ? requestError.message
            : "工作区加载失败。";
        setWorkspaceLoadFailure(message);
        setWorkspaceState((current) => rejectAsyncData(current, message));
        return false;
      } finally {
        if (workspaceBootstrapRequestRef.current?.id === requestId) {
          workspaceBootstrapRequestRef.current = null;
          workspaceLoadPromiseRef.current = null;
        }
      }
    })();
    workspaceLoadPromiseRef.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    void loadHome();
    return () => {
      homeBootstrapRequestIdRef.current += 1;
      homeBootstrapRequestRef.current?.request.abort();
      homeBootstrapRequestRef.current = null;
      workspaceBootstrapRequestIdRef.current += 1;
      workspaceBootstrapRequestRef.current?.request.abort();
      workspaceBootstrapRequestRef.current = null;
    };
  }, [loadHome]);

  useEffect(() => {
    if (viewRequiresWorkspaceData(view)) void loadWorkspace();
  }, [view, loadWorkspace]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  function openRecord(
    kind: "task" | "project" | "customer" | "order" | "knowledge",
    defaults: Row = {},
  ) {
    setRecordError("");
    setRecordDefaults(defaults);
    setRecordModal(kind);
  }

  function closeRecord(force = false) {
    if (recordBusy && !force) return;
    setRecordError("");
    setRecordModal(null);
    setRecordDefaults({});
  }

  async function updateTask(
    id: string,
    action: string,
    fields: Row = {},
  ): Promise<TaskActionResult> {
    const previousTask = data?.tasks.find((task) => String(task.id) === id);
    const isCompletion = action === "status" && fields.status === "completed";
    const previousTodayTask = homeData?.todayTasks.find(
      (task) => String(task.id) === id,
    );
    const restorePreviousTask = () => {
      if (!previousTask) return;
      setData((current) => {
        if (!current) return current;
        const tasks = current.tasks.map((task) =>
          String(task.id) === id ? previousTask : task,
        );
        const todayTasks = current.todayTasks.some(
          (task) => String(task.id) === id,
        )
          ? current.todayTasks.map((task) =>
              String(task.id) === id ? previousTask : task,
            )
          : previousTodayTask
            ? [...current.todayTasks, previousTodayTask]
            : current.todayTasks;
        const attention = syncWorkTaskAttention(
          current.attention,
          previousTask,
          localDateText(new Date()),
        );
        return { ...current, tasks, todayTasks, attention };
      });
    };
    const localFields = taskPatchForLocalState(action, fields);
    const optimisticTask = previousTask
      ? {
          ...previousTask,
          ...localFields,
          ...(action === "delete" ? { deleted_at: new Date().toISOString() } : {}),
          ...(action === "archive" ? { archived_at: new Date().toISOString() } : {}),
          ...(action === "restore" ? { archived_at: null } : {}),
          ...(action === "restore_trash" ? { deleted_at: null, purge_after: null } : {}),
        }
      : null;
    if (optimisticTask && !isCompletion) {
      setData((current) =>
        current
          ? updateTaskCollections(current, id, optimisticTask)
          : current,
      );
    }
    let response: Response;
    try {
      response = await postWorkMutation("/api/tasks", { action, id, ...fields });
    } catch (error) {
      restorePreviousTask();
      const message = isCompletion
        ? taskCompletionFailureMessage(previousTask, error)
        : taskWriteErrorMessage(error, "任务更新失败，请稍后重试。");
      showToast(message);
      return { ok: false, error: message };
    }
    let result: Row;
    try {
      result = await readApiJson(response, "任务更新失败，请稍后重试。");
    } catch (error) {
      restorePreviousTask();
      const message = isCompletion
        ? taskCompletionFailureMessage(previousTask, error)
        : taskWriteErrorMessage(error, "任务更新失败，请稍后重试。");
      showToast(message);
      return { ok: false, error: message };
    }
    if (!response.ok) {
      restorePreviousTask();
      const message = isCompletion
        ? taskCompletionFailureMessage(
            previousTask,
            new Error(String(result.error || "TASK_WRITE_FAILED")),
          )
        : response.status >= 500
          ? "更新失败，请稍后重试。"
          : String(result.error || "任务更新失败。");
      showToast(message);
      return { ok: false, error: message };
    }
    showToast("任务已更新");
    setData((current) => {
      if (!current) return current;
      const changed = result.task ?? {
          ...current.tasks.find((task) => String(task.id) === id),
          ...localFields,
          ...(action === "delete" ? { deleted_at: new Date().toISOString() } : {}),
          ...(action === "archive" ? { archived_at: new Date().toISOString() } : {}),
          ...(action === "restore" ? { archived_at: null } : {}),
          ...(action === "restore_trash" ? { deleted_at: null, purge_after: null } : {}),
        };
      return updateTaskCollections(current, id, changed);
    });
    if (result.task) {
      setHomeState((current) =>
        current.data
          ? updateAsyncData(
              current,
              updateHomeTaskCollections(current.data, id, result.task),
            )
          : current,
      );
      void loadHome();
    }
    return { ok: true, task: result.task };
  }

  async function completeHomeTodayTask(id: string): Promise<TaskActionResult> {
    const result = await updateTask(id, "status", { status: "completed" });
    if (
      result.ok &&
      result.task &&
      ["completed", "已完成", "Completed"].includes(String(result.task.status))
    ) {
      setCompletedTasksState((current) =>
        current.data
          ? resolveAsyncData({
              ...current.data,
              tasks: [
                result.task,
                ...current.data.tasks.filter(
                  (task) => String(task.id) !== String(result.task?.id),
                ),
              ],
              offset: current.data.offset + 1,
            })
          : current,
      );
    }
    return result;
  }

  async function reorderWork(
    kind: "tasks" | "projects",
    section: "today" | "upcoming" | "projects",
    ids: string[],
  ) {
    let response: Response;
    let result: Row;
    try {
      response = await postWorkMutation("/api/work-priority", { kind, section, ids });
      result = await readApiJson(response, "排序保存失败，请稍后重试。");
    } catch (error) {
      showToast(taskWriteErrorMessage(error, "排序保存失败，请稍后重试。"));
      return false;
    }
    if (!response.ok) {
      showToast(result.error || "排序保存失败。");
      return false;
    }
    setData((current) => {
      if (!current) return current;
      const positions = new Map(ids.map((itemId, index) => [itemId, (index + 1) * 100]));
      const key = kind === "tasks" ? "tasks" : "projects";
      return {
        ...current,
        [key]: current[key].map((item) =>
          positions.has(String(item.id))
            ? { ...item, work_sort_order: positions.get(String(item.id)) }
            : item,
        ),
      };
    });
    return true;
  }

  async function updateProject(
    id: string,
    action: string,
    fields: Row = {},
  ): Promise<ProjectActionResult> {
    let response: Response;
    let result: Row;
    try {
      response = await postWorkMutation("/api/projects", { id, action, ...fields });
      result = await readApiJson(response, "项目保存失败，请稍后重试。");
    } catch (error) {
      const message = taskWriteErrorMessage(error, "项目保存失败，请稍后重试。");
      showToast(message);
      return { ok: false, error: message };
    }
    if (!response.ok || (action !== "delete" && !result.project)) {
      const message = response.status >= 500
        ? "项目保存失败，请稍后重试。"
        : String(result.error || "项目保存失败。");
      showToast(message);
      return { ok: false, error: message };
    }
    setData((current) => {
      if (!current) return current;
      if (action === "delete") {
        return {
          ...current,
          projects: current.projects.filter((project) => String(project.id) !== id),
          tasks: current.tasks.map((task) =>
            String(task.project_id || "") === id ? { ...task, project_id: null } : task,
          ),
          todayTasks: current.todayTasks.map((task) =>
            String(task.project_id || "") === id ? { ...task, project_id: null } : task,
          ),
        };
      }
      return {
        ...current,
        projects: current.projects.map((project) =>
          String(project.id) === id ? result.project : project,
        ),
      };
    });
    showToast(action === "delete" ? "项目已删除，关联任务已保留" : action === "complete" ? "项目已完成" : "项目已更新");
    return { ok: true, project: result.project };
  }

  function applyOrderUpdate(result: Row) {
    if (!result.order) return;
    setData((current) => {
      if (!current) return current;
      const exists = current.orders.some((order) => order.id === result.order.id);
      const orders = exists
        ? current.orders.map((order) => order.id === result.order.id ? result.order : order)
        : [result.order, ...current.orders];
      const today = getSalesBusinessDate();
      const year = today.slice(0, 4);
      const currentYearVehicleSales = sumAttributedVehicleSales(orders, year, today);
      const activeOrderValue = orders.reduce(
        (sum, order) =>
          order.currency_status === "confirmed" && !isCompletedOrder(order)
            ? sum + Number(order.cny_amount || 0)
            : sum,
        0,
      );
      return {
        ...current,
        orders,
        salesTrend: buildAttributedSalesTrend(orders, year, today),
        contribution: buildAttributedCustomerContribution(orders, year, today).slice(0, 8),
        metrics: {
          ...current.metrics,
          currentYearVehicleSales,
          activeOrderValue,
          currentYearSales:
            currentYearVehicleSales + current.metrics.currentYearAccessorySales,
        },
        orderItems: result.orderItems
          ? [
              ...current.orderItems.filter((item) => item.order_id !== result.order.id),
              ...result.orderItems,
            ]
          : current.orderItems,
        orderPayments: result.orderPayments
          ? [
              ...current.orderPayments.filter((payment) => payment.order_id !== result.order.id),
              ...result.orderPayments,
            ]
          : current.orderPayments,
        orderRisks: [
          ...current.orderRisks.filter((risk) => risk.order_id !== result.order.id),
          ...(result.orderRisks || []),
        ],
        attention: [
          ...current.attention.filter((item) => item.order_id !== result.order.id),
          ...(result.orderRisks || []).map((risk: Row) => ({
            kind: "order",
            source_type: "order",
            source_id: result.order.id,
            id: risk.id,
            order_id: result.order.id,
            title:
              result.order.order_no ||
              result.order.pi_no ||
              result.order.customer_code ||
              "订单",
            message: `${risk.title}：${risk.reason}`,
            risk_level: risk.risk_level,
            evidence_source: risk.evidence_source,
          })),
        ],
      };
    });
    void loadHome();
  }

  async function reorderOpenOrders(ids: string[]) {
    let response: Response;
    let result: Row;
    try {
      response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reorder_open", ids }),
      });
      result = await readApiJson(response, "排序保存失败，请重试。");
    } catch (error) {
      showToast("排序保存失败，请重试");
      return false;
    }
    if (!response.ok) {
      showToast("排序保存失败，请重试");
      return false;
    }
    setData((current) => {
      if (!current) return current;
      const positions = new Map(ids.map((id, index) => [id, (index + 1) * 100]));
      return {
        ...current,
        orders: current.orders.map((order) =>
          positions.has(String(order.id))
            ? { ...order, open_sort_order: positions.get(String(order.id)) }
            : order,
        ),
      };
    });
    return true;
  }

  function removeOrder(id: string) {
    setData((current) => {
      if (!current) return current;
      const orders = current.orders.filter((order) => order.id !== id);
      const today = getSalesBusinessDate();
      const year = today.slice(0, 4);
      const vehicle = sumAttributedVehicleSales(orders, year, today);
      const activeOrderValue = orders.reduce(
        (sum, order) =>
          order.currency_status === "confirmed" && !isCompletedOrder(order)
            ? sum + Number(order.cny_amount || 0)
            : sum,
        0,
      );
      return {
        ...current,
        orders,
        salesTrend: buildAttributedSalesTrend(orders, year, today),
        contribution: buildAttributedCustomerContribution(orders, year, today).slice(0, 8),
        metrics: {
          ...current.metrics,
          currentYearVehicleSales: vehicle,
          activeOrderValue,
          currentYearSales: vehicle + current.metrics.currentYearAccessorySales,
        },
        orderItems: current.orderItems.filter((item) => item.order_id !== id),
        orderPayments: current.orderPayments.filter((payment) => payment.order_id !== id),
        orderRisks: current.orderRisks.filter((risk) => risk.order_id !== id),
        attention: current.attention.filter((item) => item.order_id !== id),
      };
    });
    void loadHome();
  }

  function applyAccessorySales(entry: Row) {
    setData((current) => {
      if (!current) return current;
      const year = String(entry.sales_year);
      const currentYear = String(new Date().getFullYear());
      const amount = year === currentYear
        ? Number(entry.amount_cny || 0)
        : current.metrics.currentYearAccessorySales;
      return {
        ...current,
        accessorySales: [
          ...current.accessorySales.filter((item) => String(item.sales_year) !== year),
          entry,
        ],
        metrics: {
          ...current.metrics,
          currentYearAccessorySales: amount,
          currentYearSales: current.metrics.currentYearVehicleSales + amount,
        },
      };
    });
    void loadHome();
  }

  function applyCustomerSnapshot(snapshot: Row) {
    const customerId = String(snapshot.customer?.id || "");
    if (!customerId) return;
    setSelectedCustomer((current) =>
      current && String(current.id) === customerId
        ? { ...current, ...snapshot.customer }
        : current,
    );
    setData((current) => {
      if (!current) return current;
      const customers = current.customers.map((item) =>
        String(item.id) === customerId
          ? { ...item, ...snapshot.customer }
          : item,
      );
      const updatedCustomer = customers.find((item) => String(item.id) === customerId);
      return {
        ...current,
        customers,
        attention: syncCustomerFollowUpAttention(
          current.attention,
          updatedCustomer,
          localDateText(new Date()),
        ),
        contacts: [
          ...current.contacts.filter((item) => String(item.customer_id) !== customerId),
          ...reportRows(snapshot.contacts),
        ],
        metrics: {
          ...current.metrics,
          existingCustomers: customers.filter((item) => item.lifecycle === "existing").length,
          aPotentialCustomers: customers.filter(
            (item) => item.lifecycle === "potential_customer" && item.grade === "1",
          ).length,
          potentialLeads: customers.filter(
            (item) => item.lifecycle === "potential_lead",
          ).length,
        },
      };
    });
    void loadHome();
  }

  function closeSelectedCustomer() {
    customerCloseRequestRef.current = null;
    setCustomerFollowUpFocusId("");
    setSelectedCustomer(null);
  }

  function removeCustomer(customerId: string) {
    customerFollowUpCache.delete(customerId);
    setAttentionTarget((current) =>
      current?.type === "customer" && current.id === customerId ? null : current,
    );
    setCustomerFollowUpFocusId((current) => current === customerId ? "" : current);
    setSelectedCustomer((current) =>
      current && String(current.id) === customerId ? null : current,
    );
    setData((current) => {
      if (!current) return current;
      const customers = current.customers.filter((item) => String(item.id) !== customerId);
      return {
        ...current,
        customers,
        contacts: current.contacts.filter((item) => String(item.customer_id) !== customerId),
        attention: current.attention.filter(
          (item) => !(
            String(item.source_type || item.kind) === "customer" &&
            String(item.source_id || item.id) === customerId
          ),
        ),
        metrics: {
          ...current.metrics,
          existingCustomers: customers.filter((item) => item.lifecycle === "existing").length,
          aPotentialCustomers: customers.filter(
            (item) => item.lifecycle === "potential_customer" && item.grade === "1",
          ).length,
          potentialLeads: customers.filter((item) => item.lifecycle === "potential_lead").length,
        },
      };
    });
    void loadHome();
  }

  function applyOrderSnapshot(snapshot: Row) {
    setData((current) => {
      if (!current) return current;
      const orders = snapshot.orders || current.orders;
      const today = getSalesBusinessDate();
      const year = today.slice(0, 4);
      const vehicle = sumAttributedVehicleSales(orders, year, today);
      const activeOrderValue = orders.reduce(
        (sum: number, order: Row) =>
          order.currency_status === "confirmed" && !isCompletedOrder(order)
            ? sum + Number(order.cny_amount || 0)
            : sum,
        0,
      );
      return {
        ...current,
        orders,
        salesTrend: buildAttributedSalesTrend(orders, year, today),
        contribution: buildAttributedCustomerContribution(orders, year, today).slice(0, 8),
        metrics: {
          ...current.metrics,
          currentYearVehicleSales: vehicle,
          activeOrderValue,
          currentYearSales: vehicle + current.metrics.currentYearAccessorySales,
        },
        orderItems: snapshot.orderItems || current.orderItems,
        orderPayments: snapshot.orderPayments || current.orderPayments,
        orderRisks: snapshot.orderRisks || current.orderRisks,
        orderStatusHistory: snapshot.orderStatusHistory || current.orderStatusHistory,
        accessorySales: snapshot.accessorySales || current.accessorySales,
      };
    });
    void loadHome();
  }

  async function acknowledgeOrderRisk(id: string) {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "acknowledge_risk", id }),
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "提醒确认失败。");
      return;
    }
    setData((current) => current ? {
      ...current,
      attention: current.attention.filter((item) => item.id !== id),
      orderRisks: current.orderRisks.filter((risk) => risk.id !== id),
    } : current);
    void loadHome();
    showToast("已确认，此提醒不会重复出现");
  }

  async function submitRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recordModal || recordBusy) return false;
    setRecordBusy(true);
    setRecordError("");
    const formData = new FormData(event.currentTarget);
    const payload: Row = { kind: recordModal };
    formData.forEach((value, key) => {
      payload[key] = value;
    });
    if (recordModal === "order") {
      payload.confirmFinancialRisk =
        formData.get("confirmFinancialRisk") === "on";
    }
    if (recordModal === "knowledge") {
      payload.tags = String(formData.get("tags") || "")
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    const optimisticId = recordModal === "task" ? crypto.randomUUID() : "";
    const optimisticTask =
      recordModal === "task"
        ? {
            id: optimisticId,
            title: String(payload.title || ""),
            status: String(payload.status || "pending"),
            reminder_date: payload.reminderDate || null,
            recurrence_rule: payload.recurrenceRule || "none",
            next_action: payload.nextAction || null,
            notes: payload.notes || null,
            work_sort_order:
              Math.max(0, ...(data?.tasks ?? []).map((task) => Number(task.work_sort_order) || 0)) +
              100,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        : null;
    const optimisticTaskDate = optimisticTask
      ? String(optimisticTask.reminder_date ?? "")
      : "";
    if (optimisticTask) {
      payload.id = optimisticId;
      setData((current) =>
        current
          ? {
              ...current,
              tasks: [...current.tasks, optimisticTask],
                todayTasks:
                  optimisticTaskDate &&
                  optimisticTaskDate <= new Date().toISOString().slice(0, 10)
                    ? [...current.todayTasks, optimisticTask]
                    : current.todayTasks,
                attention: syncWorkTaskAttention(
                  current.attention,
                  optimisticTask,
                  localDateText(new Date()),
                ),
            }
          : current,
      );
    }
    try {
      const response = await postWorkMutation("/api/workspace", payload);
      const result = await readApiJson(response, "保存失败，请稍后重试。");
      if (!response.ok) {
        throw new Error(String(result.error || "保存失败。"));
      }
      if (optimisticTask) {
        if (result.record) {
          setData((current) =>
            current ? updateTaskCollections(current, optimisticId, result.record) : current,
          );
        }
        closeRecord(true);
        showToast("任务已保存");
        return true;
      }
      if (recordModal === "project" && result.record) {
        setData((current) =>
          current
            ? {
                ...current,
                projects: [result.record, ...current.projects],
              }
            : current,
        );
        closeRecord(true);
        showToast("项目已保存");
        return true;
      }
      closeRecord(true);
      showToast("已保存");
      await loadWorkspace(true);
      void loadHome();
      return true;
    } catch (error) {
      if (optimisticTask) {
        setData((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.filter((task) => task.id !== optimisticId),
                todayTasks: current.todayTasks.filter(
                  (task) => task.id !== optimisticId),
                attention: current.attention.filter(
                  (item) =>
                    !(
                      String(item.source_type || item.kind) === "task" &&
                      String(item.source_id || item.id) === optimisticId
                    ),
                ),
              }
            : current,
        );
      }
      const message = taskWriteErrorMessage(error, "保存失败，请稍后重试。");
      setRecordError(message);
      showToast(message);
      return false;
    } finally {
      setRecordBusy(false);
    }
  }

  const headerTitle = navItems.find((item) => item.id === view)?.label ?? "首页";
  const mobilePrimaryItems = navItems.filter((item) =>
    mobilePrimaryViews.includes(item.id),
  );
  const mobileMoreItems = navItems.filter(
    (item) => !mobilePrimaryViews.includes(item.id),
  );
  const mobileMoreActive = mobileMoreItems.some((item) => item.id === view);

  function navigateTo(nextView: View) {
    setView(nextView);
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAttentionTarget(item: Row) {
    const type = String(item.source_type || item.kind || "") as AttentionTarget["type"];
    const id = String(item.source_id || (type === "order" ? item.order_id : item.id) || "");
    const viewByType: Record<AttentionTarget["type"], View> = {
      task: "work",
      project: "work",
      order: "orders",
      customer: "customers",
      after_sales_case: "after-sales",
    };
    const targetView = viewByType[type];
    if (!targetView || !id) {
      showToast("该提醒缺少有效的来源对象。");
      return;
    }
    const collections: Partial<Record<AttentionTarget["type"], Row[]>> = {
      task: data?.tasks,
      project: data?.projects,
      order: data?.orders,
      customer: data?.customers,
    };
    const collection = collections[type];
    if (data && collection && !collection.some((record) => String(record.id) === id)) {
      setAttentionTarget(null);
      navigateTo(targetView);
      showToast(`原关联${type === "task" ? "任务" : type === "project" ? "项目" : type === "order" ? "订单" : "客户"}已不存在。`);
      return;
    }
    setAttentionTarget({ type, id });
    navigateTo(targetView);
  }

  function openTaskFromHome(task: Row) {
    setAttentionTarget({ type: "task", id: String(task.id) });
    navigateTo("work");
  }

  return (
    <div className="workspace-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => navigateTo("home")}>
          <span className="brand-mark">J</span>
          <span>
            <strong>Joyce Workspace</strong>
            <small>Personal foreign-trade OS</small>
          </span>
        </button>
        <nav aria-label="主导航">
          {navItems.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id)}
            >
              <span>{item.label}</span>
              {item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </nav>
      </aside>

      <main className="workspace-main">
        <header className="mobile-header">
          <div>
            <small>Joyce Workspace</small>
            <strong>{headerTitle}</strong>
          </div>
        </header>

        <nav className="mobile-top-nav" aria-label="手机主导航">
          {mobilePrimaryItems.map((item) => (
            <button
              className={view === item.id ? "active" : ""}
              key={item.id}
              type="button"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => navigateTo(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button
            className={mobileMoreActive || mobileMenuOpen ? "active" : ""}
            type="button"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-more-menu"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            更多
          </button>
        </nav>

        {!homeState.hasLoaded && homeState.isInitialLoading ? (
          <div className="loading-state">
            <span />
            <p>{workspaceLoadingLabel("home")}</p>
          </div>
        ) : !homeState.hasLoaded && homeState.error ? (
          <div className="error-state">
            <strong>
              {workspaceStartupFailure === "timeout"
                ? "工作台加载超时"
                : "暂时无法打开工作区"}
            </strong>
            <p>
              {workspaceStartupFailure === "timeout"
                ? "网络连接较慢，或服务暂时未响应。请重试。"
                : homeState.error}
            </p>
            <button type="button" onClick={loadHome}>
              重试
            </button>
          </div>
        ) : homeData ? (
          <>
            {view === "home" && (
              <HomeView
                data={homeData}
                onTaskComplete={completeHomeTodayTask}
                onOpenTask={openTaskFromHome}
                onNavigate={navigateTo}
                onOpenAttention={openAttentionTarget}
                onAcknowledgeRisk={acknowledgeOrderRisk}
              />
            )}
            {view === "leads" && <BusinessDevelopmentView />}
            {view === "after-sales" && (
              <AfterSalesView
                listCache={afterSalesListCache}
                onListCacheChange={setAfterSalesListCache}
                attentionTarget={attentionTarget}
                onAttentionTargetConsumed={consumeAttentionTarget}
              />
            )}
            {viewRequiresWorkspaceData(view) && !workspaceState.hasLoaded && workspaceState.isInitialLoading ? (
              <div className="loading-state module-loading-state">
                <span />
                <p>{workspaceLoadingLabel(view)}</p>
              </div>
            ) : null}
            {viewRequiresWorkspaceData(view) && !workspaceState.hasLoaded && workspaceState.error ? (
              <div className="error-state module-loading-state">
                <strong>模块加载失败</strong>
                <p>{workspaceLoadFailure || workspaceState.error}</p>
                <button type="button" onClick={() => void loadWorkspace(true)}>
                  重试
                </button>
              </div>
            ) : null}
            {data && view === "work" && (
              <WorkView
                data={data}
                onTaskAction={updateTask}
                onProjectAction={updateProject}
                onAdd={openRecord}
                onReorder={reorderWork}
                attentionTarget={attentionTarget}
                onAttentionTargetConsumed={consumeAttentionTarget}
                completedTasksState={completedTasksState}
                onCompletedTasksStateChange={setCompletedTasksState}
              />
            )}
            {data && view === "customers" && (
              <CustomersView
                data={data}
                tab={customerTab}
                onTab={setCustomerTab}
                query={customerQuery}
                onQuery={setCustomerQuery}
                onSelect={setSelectedCustomer}
                onAdd={() => openRecord("customer")}
              />
            )}
            {data && view === "orders" && (
              <OrdersView
                data={data}
                onNavigate={navigateTo}
                onOrderSaved={applyOrderUpdate}
                onOrderArchived={removeOrder}
                onAccessorySalesSaved={applyAccessorySales}
                onOrdersSnapshot={applyOrderSnapshot}
                onOrderReorder={reorderOpenOrders}
                attentionTarget={attentionTarget}
                onAttentionTargetConsumed={consumeAttentionTarget}
              />
            )}
            {data && view === "knowledge" && (
              <KnowledgeView
                data={data}
                tab={knowledgeTab}
                onTab={setKnowledgeTab}
                onAdd={() => setKnowledgeCreateOpen(true)}
                onSelect={setSelectedKnowledge}
                onPlaybookRemoved={(id) =>
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          playbook: current.playbook.filter((item) => item.id !== id),
                        }
                      : current,
                  )
                }
                onPlaybookUpdated={(item) =>
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          playbook: current.playbook.map((entry) =>
                            entry.id === item.id ? item : entry,
                          ),
                        }
                      : current,
                  )
                }
              />
            )}
            {data && view === "content" && <ContentView data={data} />}
            {data && view === "settings" && (
              <SettingsView data={data} onReload={() => loadWorkspace(true)} />
            )}
          </>
        ) : null}
      </main>

      {mobileMenuOpen ? (
        <div
          className="mobile-menu-backdrop"
          role="presentation"
          onMouseDown={() => setMobileMenuOpen(false)}
        >
          <section
            className="mobile-more-menu"
            id="mobile-more-menu"
            role="dialog"
            aria-modal="true"
            aria-label="更多功能"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>JOYCE WORKSPACE</small>
                <strong>更多功能</strong>
              </div>
              <button type="button" onClick={() => setMobileMenuOpen(false)}>
                关闭
              </button>
            </header>
            <div>
              {mobileMoreItems.map((item) => (
                <button
                  className={view === item.id ? "active" : ""}
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                >
                  <span>{item.label}</span>
                  {item.hint ? <small>{item.hint}</small> : null}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <RecordModal
        kind={recordModal}
        defaults={recordDefaults}
        busy={recordBusy}
        error={recordError}
        onClose={closeRecord}
        onSubmit={submitRecord}
      />

      <KnowledgeDetailModal
        key={selectedKnowledge?.id || "knowledge-detail"}
        item={selectedKnowledge}
        onClose={() => setSelectedKnowledge(null)}
        onSaved={async (item) => {
          setData((current) =>
            current
              ? {
                  ...current,
                  knowledge: current.knowledge.map((entry) =>
                    entry.id === item.id ? item : entry,
                  ),
                }
              : current,
          );
          setSelectedKnowledge(null);
          showToast("知识已保存");
        }}
        onDeleted={async (id) => {
          setData((current) =>
            current
              ? {
                  ...current,
                  knowledge: current.knowledge.filter((entry) => entry.id !== id),
                }
              : current,
          );
          setSelectedKnowledge(null);
          showToast("知识已删除");
        }}
        onPlaybookAdded={(item) => {
          setData((current) =>
            current ? { ...current, playbook: [item, ...current.playbook] } : current,
          );
          showToast("原则已加入 Sales Playbook");
        }}
      />

      <KnowledgeArchiveModal
        open={knowledgeCreateOpen}
        onClose={() => setKnowledgeCreateOpen(false)}
        onSaved={(item) => {
          setData((current) =>
            current
              ? { ...current, knowledge: [item, ...current.knowledge] }
              : current,
          );
          setKnowledgeCreateOpen(false);
          showToast("知识已保存");
        }}
      />

      <Modal
        open={Boolean(selectedCustomer)}
        title={selectedCustomer?.company || "客户详情"}
        onClose={() => customerCloseRequestRef.current?.() ?? closeSelectedCustomer()}
        viewportFixed
        hideClose
        hideHeader
      >
        {selectedCustomer ? (
          <CustomerDetail
            key={String(selectedCustomer.id)}
            customer={
              data?.customers.find((item) => item.id === selectedCustomer.id) ??
              selectedCustomer
            }
            orders={data?.orders ?? []}
            contacts={(data?.contacts ?? []).filter(
              (item) => item.customer_id === selectedCustomer.id,
            )}
            onSaved={applyCustomerSnapshot}
            onDeleted={removeCustomer}
            onClose={closeSelectedCustomer}
            focusFollowUps={customerFollowUpFocusId === String(selectedCustomer.id)}
            onFollowUpsFocused={() => setCustomerFollowUpFocusId("")}
            closeRequestRef={customerCloseRequestRef}
            onFeedback={showToast}
            onKnowledge={(id) => {
              const knowledge = data?.knowledge.find((item) => item.id === id);
              if (knowledge) {
                setSelectedCustomer(null);
                setSelectedKnowledge(knowledge);
              }
            }}
          />
        ) : null}
      </Modal>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function HomeView({
  data,
  onTaskComplete,
  onOpenTask,
  onNavigate,
  onOpenAttention,
  onAcknowledgeRisk,
}: {
  data: HomeBootstrapData;
  onTaskComplete: (id: string) => Promise<TaskActionResult>;
  onOpenTask: (task: Row) => void;
  onNavigate: (view: View) => void;
  onOpenAttention: (item: Row) => void;
  onAcknowledgeRisk: (id: string) => void;
}) {
  const maxTrend = Math.max(...data.salesTrend.map((item) => item.amount), 1);
  const contributionTotal = data.contribution.reduce(
    (sum, item) => sum + Number(item.amount),
    0,
  );
  const colors = ["#315f52", "#729386", "#a9bbb4", "#d9e2de", "#b08a62"];
  const homeAttention = groupHomeAttention(data.attention);
  const [allAttentionOpen, setAllAttentionOpen] = useState(false);
  const [completingTodayTasks, setCompletingTodayTasks] = useState<Record<string, Row>>({});
  const [todayCompletionErrors, setTodayCompletionErrors] = useState<Record<string, string>>({});
  const visibleAttention = homeAttention.visibleItems;
  const attentionToday = localDateText(new Date());
  const displayedTodayTasks = [
    ...data.todayTasks.filter((task) => !completingTodayTasks[String(task.id)]),
    ...Object.values(completingTodayTasks),
  ].slice(0, 6);

  async function completeTodayTask(task: Row) {
    const id = String(task.id);
    if (completingTodayTasks[id]) return;
    setTodayCompletionErrors((current) => {
      const { [id]: _previousError, ...remaining } = current;
      return remaining;
    });
    setCompletingTodayTasks((current) => ({ ...current, [id]: task }));
    const result = await onTaskComplete(id);
    if (!result.ok) {
      setCompletingTodayTasks((current) => {
        const { [id]: _completedTask, ...remaining } = current;
        return remaining;
      });
      setTodayCompletionErrors((current) => ({ ...current, [id]: result.error }));
      return;
    }
    window.setTimeout(() => {
      setCompletingTodayTasks((current) => {
        const { [id]: _completedTask, ...remaining } = current;
        return remaining;
      });
    }, 380);
  }

  function renderAttentionItem(item: Row, fromFullList = false) {
    return (
      <div
        className="attention-item"
        key={`${attentionIdentity(item)}:${String(item.id)}`}
      >
        <button
          type="button"
          onClick={() => {
            if (fromFullList) setAllAttentionOpen(false);
            onOpenAttention(item);
          }}
        >
          <span>{item.title}</span>
          <p>
            {String(item.source_type || item.kind) === "task"
              ? workAttentionMessage(item, attentionToday)
              : item.message}
          </p>
        </button>
        {item.kind === "order" ? (
          <button type="button" onClick={() => onAcknowledgeRisk(String(item.id))}>
            已确认
          </button>
        ) : null}
      </div>
    );
  }
  let offset = 0;
  const gradient = data.contribution.length
    ? `conic-gradient(${data.contribution
        .map((item, index) => {
          const start = offset;
          offset += (Number(item.amount) / contributionTotal) * 100;
          return `${colors[index % colors.length]} ${start}% ${offset}%`;
        })
        .join(",")})`
    : "conic-gradient(#e8ecea 0 100%)";

  return (
    <div className="view-stack home-view">
      <section className="greeting">
        <span className="eyebrow">FOR JOYCE</span>
        <h1>{dailyGreeting()}</h1>
      </section>

      <section className="metrics-grid" aria-label="核心业务指标">
        <article>
          <span>本年度销售额</span>
          <strong>{formatCny(data.metrics.currentYearSales)}</strong>
          <small>
            整车订单 {formatCny(data.metrics.currentYearVehicleSales)} · 配件销售{" "}
            {formatCny(data.metrics.currentYearAccessorySales)}
          </small>
        </article>
        <article>
          <span>进行中订单金额</span>
          <strong>{formatCny(data.metrics.activeOrderValue)}</strong>
          <small>
            {data.metrics.currencyReviewCount
              ? `${data.metrics.currencyReviewCount} 笔待确认币种/汇率`
              : "按 CNY 统一统计"}
          </small>
        </article>
        <article>
          <span>老客户</span>
          <strong>{data.metrics.existingCustomers}</strong>
          <small>来自同一客户生命周期</small>
        </article>
        <article>
          <span>1级潜在客户</span>
          <strong>{data.metrics.aPotentialCustomers}</strong>
          <small>{data.metrics.potentialLeads} 条潜在线索待筛选</small>
        </article>
      </section>

      <section className="insight-grid">
        <article className="plain-panel trend-panel">
          <div className="panel-heading">
            <div>
              <span>SALES</span>
              <h2>销售趋势</h2>
            </div>
            <small>Current year · CNY</small>
          </div>
          {data.salesTrend.length ? (
            <div className="bar-chart" aria-label="月度销售趋势">
              {data.salesTrend.map((item) => (
                <div className="bar-column" key={item.month}>
                  <div
                    className="bar"
                    style={{ height: `${Math.max(8, (item.amount / maxTrend) * 100)}%` }}
                    title={`${item.month} ${formatCny(item.amount)}`}
                  />
                  <span>{item.month.slice(5)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="等待已确认订单"
              detail="导入订单并确认固定汇率后，这里会自动生成月度趋势。"
            />
          )}
        </article>

        <article className="plain-panel contribution-panel">
          <div className="panel-heading">
            <div>
              <span>CUSTOMERS</span>
              <h2>客户销售贡献</h2>
            </div>
          </div>
          <div className="donut-layout">
            <div
              className="donut"
              style={{ background: gradient }}
              aria-label="客户销售贡献圆环图"
            >
              <span>{data.contribution.length ? "CNY" : "—"}</span>
            </div>
            <div className="donut-legend">
              {data.contribution.length ? (
                data.contribution.slice(0, 5).map((item, index) => (
                  <button
                    type="button"
                    key={item.customer_code}
                    onClick={() => onNavigate("customers")}
                  >
                    <i style={{ background: colors[index % colors.length] }} />
                    <b>{item.customer_code}</b>
                    <span>{formatCny(item.amount)}</span>
                    <small>
                      {Math.round((item.amount / contributionTotal) * 100)}%
                    </small>
                  </button>
                ))
              ) : (
                <p>订单确认后，仅显示客户代码与 CNY 贡献。</p>
              )}
            </div>
          </div>
        </article>
      </section>

      <section className="today-grid">
        <article className="plain-panel">
          <div className="panel-heading">
            <div>
              <span>TODAY</span>
              <h2>今天</h2>
            </div>
            <button type="button" onClick={() => onNavigate("work")}>
              查看工作
            </button>
          </div>
          {displayedTodayTasks.length ? (
            <div className="task-list">
              {displayedTodayTasks.map((task) => {
                const completing = Boolean(completingTodayTasks[String(task.id)]);
                return (
                <div
                  className={`task-list-item${completing ? " is-completing" : ""}`}
                  key={task.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`完成任务：${task.title}`}
                    checked={completing}
                    disabled={completing}
                    onChange={() => void completeTodayTask(task)}
                  />
                  <button
                    className="home-today-task-open"
                    type="button"
                    onClick={() => onOpenTask(task)}
                  >
                    <strong>{task.title}</strong>
                    <small>
                      {completing
                        ? "正在完成…"
                        : formatDate(task.due_date)}
                      {!completing ? ` · ${task.priority}` : ""}
                    </small>
                  </button>
                  {!completing && todayCompletionErrors[String(task.id)] ? (
                    <p className="task-list-completion-error" role="alert">
                      {todayCompletionErrors[String(task.id)]}
                    </p>
                  ) : null}
                </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="今天没有明确待办"
              detail="用随手记写下一件事，我会把清晰的低风险任务放到这里。"
            />
          )}
        </article>

        <article className="plain-panel attention-panel">
          <div className="panel-heading">
            <div>
              <span>NEED YOUR ATTENTION</span>
              <h2>需要你关注</h2>
            </div>
            <div className="attention-panel-actions">
              <span className="attention-total">{homeAttention.total} 条</span>
              {homeAttention.total > visibleAttention.length ? (
                <button type="button" onClick={() => setAllAttentionOpen(true)}>
                  查看全部
                </button>
              ) : null}
            </div>
          </div>
          {visibleAttention.length ? (
            <div className="attention-list">
              {visibleAttention.map((item) => renderAttentionItem(item))}
            </div>
          ) : (
            <EmptyState
              title="暂时没有高价值提醒"
              detail="这里不会堆满红色警报，只显示真正值得处理的 3–5 件事。"
            />
          )}
          <Modal
            open={allAttentionOpen}
            title={`全部需要关注 · ${homeAttention.total} 条`}
            onClose={() => setAllAttentionOpen(false)}
            viewportFixed
          >
            <div className="attention-all-list">
              {homeAttention.allItems.map((item) => renderAttentionItem(item, true))}
            </div>
          </Modal>
        </article>
      </section>
    </div>
  );
}

const repeatRuleOptions = [
  ["none", "不重复"],
  ["daily", "每天"],
  ["weekly", "每周"],
  ["monthly", "每月"],
  ["yearly", "每年"],
] as const;

function WorkView({
  data,
  onTaskAction,
  onProjectAction,
  onAdd,
  onReorder,
  attentionTarget,
  onAttentionTargetConsumed,
  completedTasksState,
  onCompletedTasksStateChange,
}: {
  data: WorkspaceData;
  onTaskAction: (id: string, action: string, fields?: Row) => Promise<TaskActionResult>;
  onProjectAction: (id: string, action: string, fields?: Row) => Promise<ProjectActionResult>;
  onAdd: (kind: "task" | "project", defaults?: Row) => void;
  onReorder: (
    kind: "tasks" | "projects",
    section: "today" | "upcoming" | "projects",
    ids: string[],
  ) => Promise<boolean>;
  attentionTarget: AttentionTarget | null;
  onAttentionTargetConsumed: (target: AttentionTarget) => void;
  completedTasksState: AsyncDataState<CompletedTasksCache>;
  onCompletedTasksStateChange: (
    updater: (
      current: AsyncDataState<CompletedTasksCache>,
    ) => AsyncDataState<CompletedTasksCache>,
  ) => void;
}) {
  const [workSection, setWorkSection] = useState<
    "overview" | "reports" | "completed" | "trash"
  >("overview");
  const [editingTask, setEditingTask] = useState<Row | null>(null);
  const [taskEditorFocusField, setTaskEditorFocusField] = useState<
    "nextStep" | null
  >(null);
  const taskNextStepRef = useRef<HTMLTextAreaElement>(null);
  const [snoozingTask, setSnoozingTask] = useState<Row | null>(null);
  const [snoozeReminderDate, setSnoozeReminderDate] = useState("");
  const [selectedProject, setSelectedProject] = useState<Row | null>(null);
  const [editingProject, setEditingProject] = useState<Row | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const [busyProjectId, setBusyProjectId] = useState("");
  const [slowProjectId, setSlowProjectId] = useState("");
  const [projectWriteError, setProjectWriteError] = useState("");
  const [busyTaskId, setBusyTaskId] = useState("");
  const [slowTaskId, setSlowTaskId] = useState("");
  const [taskWriteError, setTaskWriteError] = useState("");
  const [taskCompletionErrors, setTaskCompletionErrors] = useState<Record<string, string>>({});
  const [manualOrders, setManualOrders] = useState<Record<string, string[]>>({});
  const manualOrdersRef = useRef<Record<string, string[]>>({});
  const draggingRef = useRef<{ scope: string; id: string } | null>(null);
  const [draggingId, setDraggingId] = useState("");
  const [openTaskMenuId, setOpenTaskMenuId] = useState("");
  const [openProjectMenuId, setOpenProjectMenuId] = useState("");
  const completedTasks = completedTasksState.data?.tasks || [];
  const completedTasksOffset = completedTasksState.data?.offset || 0;
  const completedTasksHasMore = completedTasksState.data?.hasMore || false;

  useEffect(() => {
    manualOrdersRef.current = {};
    setManualOrders({});
  }, [data.generatedAt]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest("[data-task-more-menu]") &&
        !event.target.closest("[data-project-more-menu]")
      ) {
        setOpenTaskMenuId("");
        setOpenProjectMenuId("");
      }
    };
    const closeOnScroll = () => {
      setOpenTaskMenuId("");
      setOpenProjectMenuId("");
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, []);

  useEffect(() => {
    setOpenTaskMenuId("");
    setOpenProjectMenuId("");
  }, [workSection]);

  const loadCompletedTasks = useCallback(async (offset: number, append: boolean) => {
    onCompletedTasksStateChange((current) => beginAsyncDataLoad(current));
    try {
      const response = await fetch(`/api/tasks?view=completed&limit=30&offset=${offset}`);
      const result = await readApiJson(response, "已完成任务加载失败。");
      const rows = Array.isArray(result.tasks) ? result.tasks : [];
      onCompletedTasksStateChange((current) =>
        resolveAsyncData({
          tasks: append ? [...(current.data?.tasks || []), ...rows] : rows,
          offset: offset + rows.length,
          hasMore: Boolean(result.hasMore),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "已完成任务加载失败。";
      onCompletedTasksStateChange((current) => rejectAsyncData(current, message));
    }
  }, [onCompletedTasksStateChange]);

  useEffect(() => {
    if (
      workSection === "completed" &&
      !completedTasksState.hasLoaded &&
      !completedTasksState.isRefreshing
    ) {
      void loadCompletedTasks(0, false);
    }
  }, [
    completedTasksState.hasLoaded,
    completedTasksState.isRefreshing,
    loadCompletedTasks,
    workSection,
  ]);

  useEffect(() => {
    if (!attentionTarget || !["task", "project"].includes(attentionTarget.type)) return;
    if (attentionTarget.type === "task") {
      const task = data.tasks.find((item) => String(item.id) === attentionTarget.id);
      if (task) {
        setEditingTask(task);
        onAttentionTargetConsumed(attentionTarget);
      }
    } else {
      const project = data.projects.find((item) => String(item.id) === attentionTarget.id);
      if (project) {
        setSelectedProject(project);
        onAttentionTargetConsumed(attentionTarget);
      }
    }
  }, [attentionTarget, data.tasks, data.projects, onAttentionTargetConsumed]);

  useEffect(() => {
    if (!editingTask || taskEditorFocusField !== "nextStep") return;
    const frame = window.requestAnimationFrame(() => {
      const field = taskNextStepRef.current;
      if (!field) {
        setTaskEditorFocusField(null);
        return;
      }
      field.scrollIntoView({ block: "center", inline: "nearest" });
      field.focus({ preventScroll: true });
      const cursor = field.value.length;
      field.setSelectionRange(cursor, cursor);
      setTaskEditorFocusField(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editingTask, taskEditorFocusField]);
  const today = localDateText(new Date());
  const tomorrowDate = new Date(`${today}T12:00:00`);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = localDateText(tomorrowDate);
  const weekEndDate = new Date(`${today}T12:00:00`);
  weekEndDate.setDate(
    weekEndDate.getDate() + ((7 - weekEndDate.getDay()) % 7),
  );
  const weekEnd = localDateText(weekEndDate);

  const availableTasks = data.tasks.filter(
    (task) => !task.deleted_at && !task.archived_at,
  );
  const activeTasks = availableTasks.filter((task) =>
    ["pending", "in_progress", "snoozed", "待处理", "进行中"].includes(
      String(task.status),
    ),
  );
  // Legacy dates remain readable, but all new Work actions use reminder_date.
  const taskDate = (task: Row) => taskReminderDate(task);
  function sortedItems(items: Row[], scope: string) {
    const stored = manualOrders[scope] ?? manualOrdersRef.current[scope];
    if (stored?.length) {
      const byId = new Map(items.map((item) => [String(item.id), item]));
      return [
        ...stored.map((id) => byId.get(id)).filter(Boolean),
        ...items.filter((item) => !stored.includes(String(item.id))),
      ] as Row[];
    }
    return [...items].sort((a, b) => {
      const aOrder = Number(a.work_sort_order) || Number.MAX_SAFE_INTEGER;
      const bOrder = Number(b.work_sort_order) || Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    });
  }

  function moveDraggedItem(scope: string, overId: string, fallbackIds: string[]) {
    const drag = draggingRef.current;
    if (!drag || drag.scope !== scope || drag.id === overId) return;
    if (scope.startsWith("upcoming-")) {
      const draggedTask = data.tasks.find(
        (task) => String(task.id) === drag.id,
      );
      const overTask = data.tasks.find((task) => String(task.id) === overId);
      if (
        !draggedTask ||
        !overTask ||
        taskDate(draggedTask) !== taskDate(overTask)
      ) {
        return;
      }
    }
    const current = [
      ...(manualOrdersRef.current[scope] ?? fallbackIds),
    ];
    const from = current.indexOf(drag.id);
    const to = current.indexOf(overId);
    if (from < 0 || to < 0) return;
    current.splice(from, 1);
    current.splice(to, 0, drag.id);
    manualOrdersRef.current = {
      ...manualOrdersRef.current,
      [scope]: current,
    };
    setManualOrders(manualOrdersRef.current);
  }

  function beginDrag(scope: string, id: string) {
    draggingRef.current = { scope, id };
    setDraggingId(id);
  }

  async function finishDrag(
    scope: string,
    kind: "tasks" | "projects",
    section: "today" | "upcoming" | "projects",
    fallbackIds: string[],
  ) {
    const drag = draggingRef.current;
    if (!drag || drag.scope !== scope) return;
    draggingRef.current = null;
    setDraggingId("");
    let ids = manualOrdersRef.current[scope] ?? fallbackIds;
    if (section === "upcoming") {
      ids = upcomingGroups.flatMap((group) => {
        const groupScope = `upcoming-${group.id}`;
        const groupIds = group.tasks.map((task) => String(task.id));
        return sortUpcomingTasks(
          group.tasks,
          manualOrdersRef.current[groupScope] ?? groupIds,
        ).map((task) => String(task.id));
      });
    }
    await onReorder(kind, section, ids);
  }

  function touchDragMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    scope: string,
    fallbackIds: string[],
  ) {
    if (event.pointerType === "mouse") return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(`[data-sort-scope="${scope}"]`);
    const overId = target?.dataset.workItemId;
    if (overId) moveDraggedItem(scope, overId, fallbackIds);
  }

  const todayTasks = sortedItems(availableTasks.filter((task) => {
    const date = taskDate(task);
    const status = String(task.status);
    return (
      (activeTasks.includes(task) && (!date || date <= today)) ||
      (["snoozed", "延期"].includes(status) && Boolean(date) && date <= today)
    );
  }), "today");
  const upcomingTasks = sortUpcomingTasks(availableTasks.filter((task) => {
    const status = String(task.status);
    const date = taskDate(task);
    return (
      Boolean(date) &&
      date > today &&
      (activeTasks.includes(task) || ["snoozed", "延期"].includes(status))
    );
  }));
  const upcomingGroups = [
    {
      id: "tomorrow",
      label: "Tomorrow / 明天",
      tasks: sortUpcomingTasks(
        upcomingTasks.filter((task) => taskDate(task) === tomorrow),
        manualOrders["upcoming-tomorrow"] ??
          manualOrdersRef.current["upcoming-tomorrow"],
      ),
    },
    {
      id: "week",
      label: "This Week / 本周",
      tasks: sortUpcomingTasks(
        upcomingTasks.filter((task) => {
          const date = taskDate(task);
          return date > tomorrow && date <= weekEnd;
        }),
        manualOrders["upcoming-week"] ??
          manualOrdersRef.current["upcoming-week"],
      ),
    },
    {
      id: "later",
      label: "Later / 以后",
      tasks: sortUpcomingTasks(
        upcomingTasks.filter((task) => {
          const date = taskDate(task);
          return date !== tomorrow && date > weekEnd;
        }),
        manualOrders["upcoming-later"] ??
          manualOrdersRef.current["upcoming-later"],
      ),
    },
  ];
  const activeProjects = sortedItems(data.projects.filter(
    (project) =>
      !["已完成", "completed", "archived", "已归档"].includes(
        String(project.status).toLowerCase(),
      ),
  ), "projects");

  const historicalTasks = data.tasks.filter((task) => {
    const status = String(task.status);
    const active = ["pending", "in_progress", "待处理", "进行中"].includes(
      status,
    );
    if (workSection === "trash") return Boolean(task.deleted_at);
    if (task.deleted_at) return false;
    if (task.archived_at) return false;
    if (active) return false;
    return false;
  });
  const displayedHistoricalTasks = workSection === "completed"
    ? sortTasksByCompletedAt(completedTasks)
    : historicalTasks;
  const completedTasksInitialLoading =
    workSection === "completed" &&
    !completedTasksState.hasLoaded &&
    !completedTasksState.error;
  const completedTasksInitialError =
    workSection === "completed" &&
    !completedTasksState.hasLoaded &&
    completedTasksState.error;
  const completedProjects = sortTasksByCompletedAt(
    data.projects.filter((project) =>
      ["completed", "已完成"].includes(String(project.status).toLowerCase()),
    ),
  );

  function openTaskEditor(
    task: Row,
    options: { focusField?: "nextStep" } = {},
  ) {
    setTaskWriteError("");
    setTaskEditorFocusField(options.focusField ?? null);
    setEditingTask(task);
  }

  function closeTaskEditor() {
    if (editingTask && busyTaskId === String(editingTask.id)) return;
    setTaskWriteError("");
    setTaskEditorFocusField(null);
    setEditingTask(null);
  }

  function openSnooze(task: Row) {
    setTaskWriteError("");
    setSnoozeReminderDate(taskDate(task));
    setSnoozingTask(task);
  }

  function closeSnooze() {
    if (snoozingTask && busyTaskId === String(snoozingTask.id)) return;
    setTaskWriteError("");
    setSnoozingTask(null);
  }

  function closeProjectEditor() {
    if (
      editingProject &&
      (savingProject || busyProjectId === String(editingProject.id))
    ) {
      return;
    }
    setProjectWriteError("");
    setEditingProject(null);
  }

  function openProjectEditor(project: Row) {
    setProjectWriteError("");
    setEditingProject(project);
  }

  async function act(task: Row, action: string, fields: Row = {}) {
    const id = String(task.id);
    const isCompletion = action === "status" && fields.status === "completed";
    if (busyTaskId === id) return false;
    setTaskWriteError("");
    if (isCompletion) {
      setTaskCompletionErrors((current) => {
        const { [id]: _previousError, ...remaining } = current;
        return remaining;
      });
    }
    setBusyTaskId(id);
    const slowTimer = window.setTimeout(() => setSlowTaskId(id), TASK_WRITE_SLOW_MS);
    try {
      const result = await onTaskAction(id, action, fields);
      if (!result.ok) {
        setTaskWriteError(result.error);
        if (isCompletion) {
          setTaskCompletionErrors((current) => ({ ...current, [id]: result.error }));
        }
        return false;
      }
      if (
        action === "status" &&
        fields.status === "completed" &&
        result.task &&
        ["completed", "已完成", "Completed"].includes(String(result.task.status))
      ) {
        onCompletedTasksStateChange((current) =>
          current.data
            ? resolveAsyncData({
                ...current.data,
                tasks: [
                  result.task,
                  ...current.data.tasks.filter(
                    (item) => String(item.id) !== String(result.task?.id),
                  ),
                ],
                offset: current.data.offset + 1,
              })
            : current,
        );
      }
      if (action === "delete") {
        onCompletedTasksStateChange((current) =>
          current.data
            ? resolveAsyncData({
              ...current.data,
              tasks: current.data.tasks.filter(
                (item) => String(item.id) !== String(task.id),
              ),
              offset: Math.max(0, current.data.offset - 1),
              })
            : current,
        );
      }
      return true;
    } finally {
      window.clearTimeout(slowTimer);
      setBusyTaskId((current) => (current === id ? "" : current));
      setSlowTaskId((current) => (current === id ? "" : current));
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTask || busyTaskId === String(editingTask.id)) return;
    const form = new FormData(event.currentTarget);
    const nextValues: Row = {
      title: String(form.get("title") ?? ""),
      reminderDate: String(form.get("reminderDate") ?? ""),
      recurrenceRule: String(form.get("recurrenceRule") ?? "none"),
      nextAction: String(form.get("nextAction") ?? ""),
      notes: String(form.get("notes") ?? ""),
    };
    const currentValues: Row = {
      title: String(editingTask.title ?? ""),
      reminderDate: taskDate(editingTask),
      recurrenceRule: String(editingTask.recurrence_rule ?? "none"),
      nextAction: String(editingTask.next_action ?? ""),
      notes: String(editingTask.notes ?? ""),
    };
    const fields = Object.fromEntries(
      Object.entries(nextValues).filter(
        ([key, value]) => value !== currentValues[key],
      ),
    );
    if (!Object.keys(fields).length) {
      closeTaskEditor();
      return;
    }
    if (await act(editingTask, "update", fields)) {
      setTaskWriteError("");
      setTaskEditorFocusField(null);
      setEditingTask(null);
    }
  }

  async function saveSnooze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snoozingTask || busyTaskId === String(snoozingTask.id)) return;
    const reminderDate = snoozeReminderDate;
    if (
      await act(snoozingTask, "status", {
        status: "snoozed",
        reminderDate,
      })
    ) {
      setTaskWriteError("");
      setSnoozingTask(null);
    }
  }

  async function saveProjectEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingProject || savingProject) return;
    const form = new FormData(event.currentTarget);
    const fields = {
      title: String(form.get("title") ?? ""),
      status: String(form.get("status") ?? ""),
      nextStep: String(form.get("nextStep") ?? ""),
      notes: String(form.get("notes") ?? ""),
      finalResult: String(form.get("finalResult") ?? ""),
    };
    setSavingProject(true);
    try {
      if (await actProject(editingProject, "update", fields)) {
        setProjectWriteError("");
        setEditingProject(null);
      }
    } finally {
      setSavingProject(false);
    }
  }

  async function actProject(project: Row, action: string, fields: Row = {}) {
    const id = String(project.id);
    if (busyProjectId === id) return false;
    setProjectWriteError("");
    setBusyProjectId(id);
    const slowTimer = window.setTimeout(
      () => setSlowProjectId(id),
      TASK_WRITE_SLOW_MS,
    );
    try {
      const result = await onProjectAction(id, action, fields);
      if (!result.ok) {
        setProjectWriteError(result.error);
        return false;
      }
      return true;
    } finally {
      window.clearTimeout(slowTimer);
      setBusyProjectId((current) => (current === id ? "" : current));
      setSlowProjectId((current) => (current === id ? "" : current));
    }
  }

  async function completeProject(project: Row) {
    const id = String(project.id);
    if (await actProject(project, "complete")) {
      if (String(selectedProject?.id || "") === id) setSelectedProject(null);
      if (String(editingProject?.id || "") === id) setEditingProject(null);
    }
  }

  async function deleteProject(project: Row) {
    if (!window.confirm("确定删除这个项目吗？")) return;
    const id = String(project.id);
    if (await actProject(project, "delete")) {
      if (String(selectedProject?.id || "") === id) setSelectedProject(null);
      if (String(editingProject?.id || "") === id) setEditingProject(null);
    }
  }

  async function reopenProject(project: Row) {
    const id = String(project.id);
    if (await actProject(project, "reopen")) {
      setOpenProjectMenuId("");
      if (String(selectedProject?.id || "") === id) setSelectedProject(null);
    }
  }

  function renderOverviewTask(task: Row, scope: string, items: Row[]) {
    const fallbackIds = items.map((item) => String(item.id));
    const section = scope === "today" ? "today" : "upcoming";
    const completing = busyTaskId === String(task.id);
    const completionError = taskCompletionErrors[String(task.id)];
    return (
      <div
        className={`overview-task-row ${
          draggingId === task.id ? "is-dragging" : ""
        }`}
        data-sort-scope={scope}
        data-work-item-id={task.id}
        draggable
        key={task.id}
        onDragStart={(event: DragEvent<HTMLDivElement>) => {
          beginDrag(scope, String(task.id));
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          moveDraggedItem(scope, String(task.id), fallbackIds);
        }}
        onDragEnd={() =>
          finishDrag(scope, "tasks", section, fallbackIds)
        }
      >
        <button
          className="work-drag-handle"
          type="button"
          aria-label={`拖动调整 ${task.title} 的顺序`}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            beginDrag(scope, String(task.id));
          }}
          onPointerMove={(event) => touchDragMove(event, scope, fallbackIds)}
          onPointerUp={() =>
            finishDrag(scope, "tasks", section, fallbackIds)
          }
          onPointerCancel={() => {
            draggingRef.current = null;
            setDraggingId("");
          }}
        >
          ⠿
        </button>
        <div className="overview-task-content">
          <button
            className="overview-task-open-button"
            type="button"
            onClick={() => openTaskEditor(task)}
          >
            <strong>{task.title}</strong>
            <small>
              {taskDate(task)
                ? formatDate(taskDate(task))
                : "今天 · 未设置具体时间"}
            </small>
          </button>
          <button
            className="overview-task-next-step"
            type="button"
            aria-label={`编辑 ${task.title} 的下一步`}
            onClick={() => openTaskEditor(task, { focusField: "nextStep" })}
          >
            {task.next_action || task.notes || "未设置下一步"}
          </button>
          {completing ? <small className="task-completion-pending">正在完成…</small> : null}
          {!completing && completionError ? (
            <p className="task-completion-error" role="alert">{completionError}</p>
          ) : null}
        </div>
        <div className="overview-task-actions">
          <button
            className="complete-task-button"
            type="button"
            disabled={busyTaskId === String(task.id)}
            onClick={() => act(task, "status", { status: "completed" })}
          >
            {busyTaskId === String(task.id)
              ? slowTaskId === String(task.id)
                ? "仍在完成…"
                : "完成中…"
              : "Complete / 完成"}
          </button>
          <button
            type="button"
            disabled={busyTaskId === String(task.id)}
            onClick={() => openSnooze(task)}
          >
            Snooze / 稍后
          </button>
          <div className="task-more" data-task-more-menu>
            <button
              type="button"
              disabled={busyTaskId === String(task.id)}
              aria-expanded={openTaskMenuId === String(task.id)}
              aria-haspopup="menu"
              onClick={() =>
                setOpenTaskMenuId((current) =>
                  current === String(task.id) ? "" : String(task.id),
                )
              }
            >
              More / 更多
            </button>
            {openTaskMenuId === String(task.id) ? (
              <div role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={busyTaskId === String(task.id)}
                onClick={() => {
                  setOpenTaskMenuId("");
                  openTaskEditor(task);
                }}
              >
                Edit / 编辑
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busyTaskId === String(task.id)}
                onClick={() => {
                  setOpenTaskMenuId("");
                  void act(task, "archive");
                }}
              >
                Archive / 归档
              </button>
              <button
                className="danger-button"
                type="button"
                role="menuitem"
                disabled={busyTaskId === String(task.id)}
                onClick={() => {
                  setOpenTaskMenuId("");
                  void act(task, "delete");
                }}
              >
                Delete / 删除
              </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function renderTasks() {
    return (
      <article className="plain-panel">
        <div className="panel-heading">
          <h2>
            {workSection === "completed"
              ? "已完成任务"
              : "Trash / 回收站"}
          </h2>
          <span>{displayedHistoricalTasks.length}</span>
        </div>
        <div className="rows-list">
          {completedTasksInitialLoading ? (
            <div className="compact-async-state" role="status">
              <span aria-hidden="true" />
              <p>正在加载已完成内容…</p>
            </div>
          ) : completedTasksInitialError ? (
            <div className="compact-async-state compact-async-error" role="alert">
              <strong>已完成内容加载失败，请重试</strong>
              <p>{completedTasksInitialError}</p>
              <button type="button" onClick={() => void loadCompletedTasks(0, false)}>
                重试
              </button>
            </div>
          ) : displayedHistoricalTasks.length ? (
            displayedHistoricalTasks.map((task) => {
              const completed = ["completed", "已完成"].includes(task.status);
              const inTrash = workSection === "trash";
              const historical = workSection === "completed";
              return (
                <div className="work-row" key={task.id}>
                  <input
                    type="checkbox"
                    aria-label={`完成 ${task.title}`}
                    checked={completed}
                    disabled={
                      busyTaskId === String(task.id) || historical || inTrash
                    }
                    onChange={(event) =>
                      act(task, "status", {
                        status: event.target.checked ? "completed" : "pending",
                      })
                    }
                  />
                  <div>
                    <strong>{task.title}</strong>
                    <p>{task.next_action || task.notes || "未设置下一步"}</p>
                    <small>
                      {inTrash
                        ? `30 天后永久删除：${formatDate(task.purge_after)}`
                        : completed
                          ? `完成：${formatCompletedAt(task.completed_at)}`
                          : task.archived_at
                            ? `归档：${formatDate(task.archived_at)}`
                            : `提醒：${formatDate(taskDate(task))}`}
                    </small>
                  </div>
                  <span className={statusClass(task.status)}>
                    {task.archived_at ? "已归档" : taskStatusLabel(task.status)}
                  </span>
                  <div className="task-actions">
                    {!historical && !inTrash ? (
                      <>
                        <button
                          type="button"
                          disabled={busyTaskId === String(task.id)}
                          onClick={() =>
                            act(task, "status", { status: "in_progress" })
                          }
                        >
                          开始
                        </button>
                        <button
                          type="button"
                          disabled={busyTaskId === String(task.id)}
                          onClick={() => openSnooze(task)}
                        >
                          稍后
                        </button>
                      </>
                    ) : null}
                    {inTrash ? (
                      <button
                        type="button"
                        disabled={busyTaskId === String(task.id)}
                        onClick={() => act(task, "restore_trash")}
                      >
                        恢复任务
                      </button>
                    ) : null}
                    {!task.archived_at && !inTrash ? (
                      <button type="button" disabled={busyTaskId === String(task.id)} onClick={() => openTaskEditor(task)}>
                        编辑
                      </button>
                    ) : null}
                    {task.archived_at && !inTrash ? (
                      <button type="button" disabled={busyTaskId === String(task.id)} onClick={() => act(task, "restore")}>
                        恢复使用
                      </button>
                    ) : !inTrash ? (
                      <button type="button" disabled={busyTaskId === String(task.id)} onClick={() => act(task, "archive")}>
                        归档
                      </button>
                    ) : null}
                    {!inTrash ? (
                      <button
                        className="danger-button"
                        type="button"
                        onClick={() => act(task, "delete")}
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState
              title={workSection === "completed" ? "暂无已完成内容" : "这里暂时没有任务"}
              detail={
                workSection === "trash"
                    ? "删除的任务会在这里保留约 30 天。"
                    : "可在 Work 中新增任务并安排提醒日期。"
              }
            />
          )}
        </div>
        {workSection === "completed" && completedTasksState.isRefreshing ? (
          <p className="async-refreshing" role="status">正在更新…</p>
        ) : null}
        {workSection === "completed" && completedTasksState.hasLoaded && completedTasksState.error ? (
          <p className="async-refresh-error" role="status">
            更新失败，当前显示上次已完成内容。
          </p>
        ) : null}
        {workSection === "completed" && completedTasksHasMore ? (
          <button
            className="load-more-button"
            type="button"
            disabled={completedTasksState.isRefreshing}
            onClick={() => void loadCompletedTasks(completedTasksOffset, true)}
          >
            {completedTasksState.isRefreshing ? "加载中…" : "加载更多"}
          </button>
        ) : null}
      </article>
    );
  }

  function renderCompletedProjects() {
    return (
      <article className="plain-panel">
        <div className="panel-heading">
          <h2>已完成项目</h2>
          <span>{completedProjects.length}</span>
        </div>
        <div className="compact-project-list">
          {completedProjects.length ? (
            completedProjects.map((project) => (
              <article className="compact-project-row completed-project-row" key={project.id}>
                <button
                  className="project-open-button"
                  type="button"
                  onClick={() => setSelectedProject(project)}
                >
                  <span>
                    <strong>{project.title}</strong>
                    <em className={statusClass(project.status)}>已完成</em>
                  </span>
                  <p>{project.final_result || "暂无最终结论"}</p>
                  <small>备注：{project.notes || "暂无备注"}</small>
                  <small>完成：{formatCompletedAt(project.completed_at)}</small>
                </button>
                <div className="project-row-actions">
                  <button type="button" onClick={() => setSelectedProject(project)}>
                    查看详情
                  </button>
                  <button type="button" onClick={() => openProjectEditor(project)}>编辑</button>
                  <div className="project-more-menu" data-project-more-menu>
                    <button
                      type="button"
                      disabled={busyProjectId === String(project.id)}
                      aria-expanded={openProjectMenuId === String(project.id)}
                      onClick={() => setOpenProjectMenuId((current) => current === String(project.id) ? "" : String(project.id))}
                    >
                      更多
                    </button>
                    {openProjectMenuId === String(project.id) ? (
                      <div role="menu">
                        <button type="button" role="menuitem" onClick={() => void reopenProject(project)}>重新打开</button>
                        <button className="danger-button" type="button" role="menuitem" onClick={() => void deleteProject(project)}>删除</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            ))
          ) : (
            <p className="overview-empty">暂无已完成项目。</p>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="view-stack work-view">
      <SectionTitle
        eyebrow="WORK"
        title="工作概览"
        detail="一眼看清今天、接下来的安排和正在推进的长期项目。"
      />
      <nav className="work-sections" aria-label="工作模块">
        {[
          ["overview", "Work Overview / 工作概览"],
          ["reports", "Reports / 报告"],
          ["completed", "Completed / 已完成"],
          ["trash", "Trash / 回收站"],
        ].map(([id, label]) => (
          <button
            className={workSection === id ? "active" : ""}
            key={id}
            type="button"
            onClick={() => setWorkSection(id as typeof workSection)}
          >
            {label}
          </button>
        ))}
      </nav>

      {workSection === "overview" ? (
        <section className="work-overview-grid">
          <div className="work-overview-left">
            <article className="plain-panel overview-section">
              <div className="panel-heading overview-section-heading">
                <div>
                  <h2>Today / 今天</h2>
                  <span>{todayTasks.length}</span>
                </div>
                <button
                  type="button"
                  aria-label="新增今天的任务"
                  onClick={() =>
                    onAdd("task", {
                      reminderDate: today,
                    })
                  }
                >
                  +
                </button>
              </div>
              <div className="overview-task-list">
                {todayTasks.length ? (
                  todayTasks.map((task) =>
                    renderOverviewTask(task, "today", todayTasks),
                  )
                ) : (
                  <p className="overview-empty">今天没有待办任务。</p>
                )}
              </div>
            </article>

            <article className="plain-panel overview-section">
              <div className="panel-heading overview-section-heading">
                <div>
                  <h2>Upcoming / 即将进行</h2>
                  <span>{upcomingTasks.length}</span>
                </div>
                <button
                  type="button"
                  aria-label="新增未来任务"
                  onClick={() =>
                    onAdd("task", {
                      reminderDate: tomorrow,
                    })
                  }
                >
                  +
                </button>
              </div>
              <div className="upcoming-groups">
                {upcomingTasks.length ? (
                  upcomingGroups.map((group) => (
                    <section key={group.id}>
                      <header>
                        <h3>{group.label}</h3>
                        <span>{group.tasks.length}</span>
                      </header>
                      {group.tasks.length ? (
                        group.tasks.map((task) =>
                          renderOverviewTask(
                            task,
                            `upcoming-${group.id}`,
                            group.tasks,
                          ),
                        )
                      ) : (
                        <p className="overview-empty">暂无安排</p>
                      )}
                    </section>
                  ))
                ) : (
                  <p className="overview-empty">暂无即将进行的安排。</p>
                )}
              </div>
            </article>
          </div>

          <aside className="plain-panel overview-section projects-overview">
            <div className="panel-heading overview-section-heading">
              <div>
                <h2>Projects / 项目</h2>
                <span>{activeProjects.length}</span>
              </div>
              <button
                type="button"
                aria-label="新增项目"
                onClick={() => onAdd("project")}
              >
                +
              </button>
            </div>
            <div className="compact-project-list">
              {activeProjects.length ? (
                activeProjects.map((project) => {
                  const fallbackIds = activeProjects.map((item) =>
                    String(item.id),
                  );
                  return (
                  <article
                    key={project.id}
                    className={`compact-project-row ${
                      draggingId === project.id ? "is-dragging" : ""
                    }`}
                    data-sort-scope="projects"
                    data-work-item-id={project.id}
                    draggable
                    onDragStart={(event: DragEvent<HTMLElement>) => {
                      beginDrag("projects", String(project.id));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event: DragEvent<HTMLElement>) => {
                      event.preventDefault();
                      moveDraggedItem(
                        "projects",
                        String(project.id),
                        fallbackIds,
                      );
                    }}
                    onDragEnd={() =>
                      finishDrag(
                        "projects",
                        "projects",
                        "projects",
                        fallbackIds,
                      )
                    }
                  >
                    <button
                      className="work-drag-handle"
                      type="button"
                      aria-label={`拖动调整 ${project.title} 的顺序`}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse") return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        beginDrag("projects", String(project.id));
                      }}
                      onPointerMove={(event) =>
                        touchDragMove(event, "projects", fallbackIds)
                      }
                      onPointerUp={() =>
                        finishDrag(
                          "projects",
                          "projects",
                          "projects",
                          fallbackIds,
                        )
                      }
                      onPointerCancel={() => {
                        draggingRef.current = null;
                        setDraggingId("");
                      }}
                    >
                      ⠿
                    </button>
                    <button
                      className="project-open-button"
                      type="button"
                      onClick={() => setSelectedProject(project)}
                    >
                      <span>
                        <strong>{project.title}</strong>
                        <em className={statusClass(project.status)}>
                          {project.status}
                        </em>
                      </span>
                      <p>{project.next_step || "还没有写下一步"}</p>
                    </button>
                    <div className="project-row-actions">
                      <button type="button" onClick={() => setSelectedProject(project)}>
                        查看详情
                      </button>
                      <button type="button" onClick={() => openProjectEditor(project)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        disabled={busyProjectId === String(project.id)}
                        onClick={() => void completeProject(project)}
                      >
                        {busyProjectId === String(project.id)
                          ? slowProjectId === String(project.id)
                            ? "仍在完成…"
                            : "完成中…"
                          : "完成"}
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={busyProjectId === String(project.id)}
                        onClick={() => void deleteProject(project)}
                      >
                        {busyProjectId === String(project.id)
                          ? slowProjectId === String(project.id)
                            ? "仍在删除…"
                            : "删除中…"
                          : "删除"}
                      </button>
                    </div>
                  </article>
                  );
                })
              ) : (
                <p className="overview-empty">还没有进行中的长期项目。</p>
              )}
            </div>
          </aside>
        </section>
      ) : null}

      {workSection === "completed" ? (
        <section className="completed-work-sections">
          {renderTasks()}
          {renderCompletedProjects()}
        </section>
      ) : null}
      {workSection === "trash" ? renderTasks() : null}
      {workSection === "reports" ? <ReportsView /> : null}

      <Modal
        open={Boolean(editingTask)}
        title="编辑任务"
        onClose={closeTaskEditor}
      >
        {editingTask ? (
          <form className="form-stack" onSubmit={saveEdit}>
            <label>
              任务内容
              <input name="title" defaultValue={editingTask.title} required />
            </label>
            <label>
              提醒日期
              <DateInput
                name="reminderDate"
                defaultValue={taskDate(editingTask)}
              />
            </label>
            <label>
              重复规则
              <select
                name="recurrenceRule"
                defaultValue={String(editingTask.recurrence_rule || "none")}
              >
                {repeatRuleOptions.map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
                <option value="custom" disabled>自定义（后续扩展）</option>
              </select>
            </label>
            <label>
              下一步
              <textarea
                ref={taskNextStepRef}
                name="nextAction"
                rows={3}
                defaultValue={editingTask.next_action || ""}
              />
            </label>
            <label>
              备注
              <textarea name="notes" rows={4} defaultValue={editingTask.notes || ""} />
            </label>
            {taskWriteError ? <p className="inline-warning" role="alert">{taskWriteError}</p> : null}
            <button
              className="primary-button"
              type="submit"
              disabled={busyTaskId === String(editingTask.id)}
            >
              {busyTaskId === String(editingTask.id)
                ? slowTaskId === String(editingTask.id)
                  ? "仍在保存…"
                  : "保存中…"
                : "保存任务"}
            </button>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(snoozingTask)}
        title="稍后提醒"
        onClose={closeSnooze}
      >
        <form className="form-stack" onSubmit={saveSnooze}>
          <p className="form-note">
            选择新的提醒日期；到达该日期后，任务会自动回到“今天”。
          </p>
          <label>
            提醒日期
            <DateInput
              name="reminderDate"
              required
              value={snoozeReminderDate}
              disabled={busyTaskId === String(snoozingTask?.id)}
              onChange={(event) => setSnoozeReminderDate(event.target.value)}
            />
          </label>
          {taskWriteError ? <p className="inline-warning" role="alert">{taskWriteError}</p> : null}
          <button
            className="primary-button"
            type="submit"
            disabled={busyTaskId === String(snoozingTask?.id)}
          >
            {busyTaskId === String(snoozingTask?.id)
              ? slowTaskId === String(snoozingTask?.id)
                ? "仍在更新提醒时间…"
                : "保存中…"
              : "确认稍后提醒"}
          </button>
        </form>
      </Modal>

      <Modal
        open={Boolean(selectedProject)}
        title={selectedProject?.title || "项目详情"}
        onClose={() => setSelectedProject(null)}
      >
        {selectedProject ? (
          <div className="project-detail">
            <dl>
              <div>
                <dt>状态</dt>
                <dd>{selectedProject.status || "未设置"}</dd>
              </div>
            </dl>
            <section>
              <span>下一步</span>
              <p>{selectedProject.next_step || "还没有写下一步"}</p>
            </section>
            <section>
              <span>备注</span>
              <p>{selectedProject.notes || "暂无备注"}</p>
            </section>
            <section>
              <span>最终结果 / 结论</span>
              <p>{selectedProject.final_result || "暂无最终结论"}</p>
            </section>
          </div>
        ) : null}
      </Modal>
      <ProjectEditModal
        key={editingProject ? String(editingProject.id) : "project-edit"}
        project={editingProject}
        saving={savingProject}
        slow={slowProjectId === String(editingProject?.id)}
        error={projectWriteError}
        onClose={closeProjectEditor}
        onSave={saveProjectEdit}
      />
    </div>
  );
}

function ProjectEditModal({
  project,
  saving,
  slow,
  error,
  onClose,
  onSave,
}: {
  project: Row | null;
  saving: boolean;
  slow: boolean;
  error: string;
  onClose: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal open={Boolean(project)} title="编辑项目" onClose={onClose}>
      {project ? (
        <form className="form-stack" onSubmit={onSave}>
          <label>
            项目名称
            <input name="title" defaultValue={project.title} required />
          </label>
          <label>
            状态
            <select name="status" defaultValue={String(project.status || "进行中")}>
              {!['规划中', '进行中', '暂停', '已完成'].includes(String(project.status)) && project.status ? (
                <option value={String(project.status)}>{String(project.status)}</option>
              ) : null}
              <option value="规划中">规划中</option>
              <option value="进行中">进行中</option>
              <option value="暂停">暂停</option>
              <option value="已完成">已完成</option>
            </select>
          </label>
          <label>
            下一步
            <textarea name="nextStep" rows={3} defaultValue={project.next_step || ""} />
          </label>
          <label>
            备注
            <textarea name="notes" rows={5} defaultValue={project.notes || ""} />
          </label>
          <label>
            最终结果 / 结论
            <textarea name="finalResult" rows={4} defaultValue={project.final_result || ""} />
          </label>
          <div className="modal-form-actions">
            <button type="button" onClick={onClose} disabled={saving}>取消</button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving ? (slow ? "仍在保存…" : "保存中…") : "保存修改"}
            </button>
          </div>
          {error ? <p className="inline-warning" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </Modal>
  );
}

const reportScopeOptions = [
  ["customer_followup", "客户跟进"],
  ["orders", "订单"],
  ["after_sales", "售后"],
  ["lead_development", "新客开发"],
  ["projects", "项目"],
  ["internal", "内部工作"],
  ["content", "内容运营"],
] as const;

const fixedReportStatuses = ["已完成", "进行中", "待跟进", "暂缓"];

function localDateText(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateAfterLocalDays(today: string, days: number) {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return localDateText(date);
}

function updateTaskCollections(
  current: WorkspaceData,
  id: string,
  changed: Row,
) {
  const priorTodayIds = new Set(
    current.todayTasks.map((task) => String(task.id)),
  );
  const tasks = current.tasks.map((task) =>
    String(task.id) === id ? { ...task, ...changed } : task,
  );
  const today = localDateText(new Date());
  const todayTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived_at) return false;
    if (
      !["pending", "in_progress", "snoozed", "待处理", "进行中"].includes(
        String(task.status),
      )
    ) {
      return false;
    }
    const reminderDate = String(
      task.reminder_date ?? task.next_action_date ?? task.due_date ?? "",
    ).slice(0, 10);
    return reminderDate
      ? reminderDate <= today
      : priorTodayIds.has(String(task.id));
  });
  const updatedTask = tasks.find((task) => String(task.id) === id);
  const attention = syncWorkTaskAttention(current.attention, updatedTask, today);
  return { ...current, tasks, todayTasks, attention };
}

function updateHomeTaskCollections(
  current: HomeBootstrapData,
  id: string,
  changed: Row,
) {
  const today = localDateText(new Date());
  const previousIndex = current.todayTasks.findIndex((task) => String(task.id) === id);
  const previousTask = previousIndex >= 0 ? current.todayTasks[previousIndex] : undefined;
  const updatedTask = { ...previousTask, ...changed };
  const status = String(updatedTask.status ?? "");
  const reminderDate = String(
    updatedTask.reminder_date ?? updatedTask.next_action_date ?? updatedTask.due_date ?? "",
  ).slice(0, 10);
  const isTodayTask = Boolean(
    !updatedTask.deleted_at &&
      !updatedTask.archived_at &&
      !["completed", "已完成", "Completed", "cancelled", "Cancelled"].includes(status) &&
      ["pending", "in_progress", "待处理", "进行中"].includes(status) &&
      reminderDate &&
      reminderDate <= today,
  );
  const withoutTask = current.todayTasks.filter((task) => String(task.id) !== id);
  const todayTasks = isTodayTask
    ? [updatedTask, ...withoutTask].slice(0, 6)
    : withoutTask;
  return {
    ...current,
    todayTasks,
    todayTaskTotal: Math.max(
      0,
      current.todayTaskTotal +
        (isTodayTask && previousIndex < 0 ? 1 : 0) -
        (!isTodayTask && previousIndex >= 0 ? 1 : 0),
    ),
    attention: syncWorkTaskAttention(current.attention, updatedTask, today),
  };
}

function weeklyRange(period: "current" | "previous") {
  const now = new Date();
  const weekday = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - weekday);
  if (period === "previous") {
    monday.setDate(monday.getDate() - 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { startDate: localDateText(monday), endDate: localDateText(sunday) };
  }
  return { startDate: localDateText(monday), endDate: localDateText(now) };
}

function reportRows(value: unknown) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function reportObject(value: unknown, fallback: Row | Row[] = {}) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function copyReportTable(items: Row[]) {
  const lines = [
    ["序号", "目标客户", "内容", "状态", "备注"],
    ...items.map((item, index) => [
      String(index + 1),
      String(item.target ?? ""),
      String(item.content ?? ""),
      String(item.status ?? ""),
      String(item.remark ?? ""),
    ]),
  ];
  return navigator.clipboard.writeText(
    lines.map((line) => line.join("\t")).join("\n"),
  );
}

function exportReportExcel(title: string, items: Row[]) {
  const sheet = XLSX.utils.json_to_sheet(
    items.map((item, index) => ({
      序号: index + 1,
      目标客户: item.target,
      内容: item.content,
      状态: item.status,
      备注: item.remark,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "工作报告");
  XLSX.writeFile(workbook, `${title || "工作报告"}.xlsx`);
}

function exportReportWord(title: string, items: Row[]) {
  const escapeHtml = (value: unknown) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const rows = items
    .map(
      (item, index) => `<tr>
        <td>${index + 1}</td><td>${escapeHtml(item.target)}</td>
        <td>${escapeHtml(item.content)}</td><td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.remark)}</td>
      </tr>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>body{font-family:Arial,"Microsoft YaHei",sans-serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:8px;text-align:left;vertical-align:top}h1{font-size:18px}</style>
    </head><body><h1>${escapeHtml(title)}</h1><table>
    <thead><tr><th>序号</th><th>目标客户</th><th>内容</th><th>状态</th><th>备注</th></tr></thead>
    <tbody>${rows}</tbody></table></body></html>`;
  const url = URL.createObjectURL(
    new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title || "工作报告"}.doc`;
  link.click();
  URL.revokeObjectURL(url);
}

function ReportsView() {
  const current = weeklyRange("current");
  const [reportType, setReportType] = useState<"weekly" | "custom">("weekly");
  const [weeklyPeriod, setWeeklyPeriod] = useState<"current" | "previous">(
    "current",
  );
  const [startDate, setStartDate] = useState(current.startDate);
  const [endDate, setEndDate] = useState(current.endDate);
  const [scopes, setScopes] = useState(
    new Set(reportScopeOptions.map(([id]) => id)),
  );
  const [draft, setDraft] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showSources, setShowSources] = useState(false);

  const loadHistory = useCallback(async () => {
    const response = await fetch("/api/reports");
    const result = await response.json();
    if (response.ok) setHistory(result.reports ?? []);
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  function setPeriod(period: "current" | "previous") {
    setWeeklyPeriod(period);
    const range = weeklyRange(period);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }

  async function generateReport() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "generate",
          reportType,
          startDate,
          endDate,
          scopes: [...scopes],
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "报告生成失败。");
      setDraft(result.draft);
      setReadOnly(false);
      setShowSources(false);
      setMessage(
        result.draft.provider === "gemini"
          ? "已根据真实记录生成 AI 草稿，请确认后保存。"
          : "已根据真实记录生成可靠草稿，请确认后保存。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "报告生成失败。");
    } finally {
      setBusy(false);
    }
  }

  function updateItem(index: number, field: string, value: string) {
    if (!draft || readOnly) return;
    const items = reportRows(draft.items).map((item) => ({ ...item }));
    items[index][field] = value;
    setDraft({ ...draft, items });
  }

  function moveItem(index: number, offset: number) {
    if (!draft || readOnly) return;
    const items = reportRows(draft.items).map((item) => ({ ...item }));
    const next = index + offset;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    setDraft({ ...draft, items });
  }

  async function saveReport() {
    if (!draft || readOnly) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          ...draft,
          reportType: draft.reportType ?? reportType,
          startDate: draft.startDate ?? startDate,
          endDate: draft.endDate ?? endDate,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "报告保存失败。");
      setReadOnly(true);
      setMessage("报告已确认并保存为历史快照。");
      await loadHistory();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "报告保存失败。");
    } finally {
      setBusy(false);
    }
  }

  function openHistory(report: Row, mode: "view" | "duplicate" | "version") {
    setDraft({
      reportType: report.report_type,
      title:
        mode === "duplicate" ? `${report.title}（副本）` : report.title,
      startDate: report.start_date,
      endDate: report.end_date,
      scopes: reportRows(report.scopes),
      items: reportRows(report.items).map((item) => ({ ...item })),
      sourceSummary: reportObject(report.source_summary),
      sourceDetails: reportRows(report.source_details),
      versionOf: mode === "version" ? report.id : undefined,
    });
    setReadOnly(mode === "view");
    setShowSources(false);
    setMessage(
      mode === "view"
        ? "正在查看已确认快照。"
        : mode === "version"
          ? "已创建可编辑的新版本，旧报告不会改变。"
          : "已复制为新草稿。",
    );
  }

  const items = reportRows(draft?.items);
  const sourceSummary = (draft?.sourceSummary ?? {}) as Row;
  const sourceDetails = reportRows(draft?.sourceDetails);

  return (
    <div className="reports-stack">
      <section className="plain-panel report-builder">
        <div className="panel-heading">
          <div>
            <span>REPORT GENERATOR</span>
            <h2>生成工作报告</h2>
          </div>
        </div>
        <div className="report-mode-tabs">
          <button
            className={reportType === "weekly" ? "active" : ""}
            type="button"
            onClick={() => {
              setReportType("weekly");
              setPeriod(weeklyPeriod);
            }}
          >
            Weekly Report / 周报
          </button>
          <button
            className={reportType === "custom" ? "active" : ""}
            type="button"
            onClick={() => setReportType("custom")}
          >
            Custom Date Range / 自定义日期
          </button>
        </div>
        {reportType === "weekly" ? (
          <div className="weekly-options">
            <label>
              <input
                type="radio"
                checked={weeklyPeriod === "current"}
                onChange={() => setPeriod("current")}
              />
              本周（周一至今天）
            </label>
            <label>
              <input
                type="radio"
                checked={weeklyPeriod === "previous"}
                onChange={() => setPeriod("previous")}
              />
              上一个完整周（周一至周日）
            </label>
          </div>
        ) : null}
        <div className="form-grid report-date-range">
          <label>
            开始日期
            <DateInput
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            结束日期
            <DateInput
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
        </div>
        <fieldset className="report-scopes">
          <legend>工作范围</legend>
          {reportScopeOptions.map(([id, label]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={scopes.has(id)}
                onChange={(event) => {
                  const next = new Set(scopes);
                  if (event.target.checked) next.add(id);
                  else next.delete(id);
                  setScopes(next);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <button
          className="primary-button"
          type="button"
          disabled={busy || !scopes.size}
          onClick={generateReport}
        >
          {busy ? "正在整理真实工作记录…" : "Generate Report / 生成报告"}
        </button>
        {message ? <p className="form-note">{message}</p> : null}
      </section>

      {draft ? (
        <section className="plain-panel report-preview">
          <div className="panel-heading">
            <div>
              <span>REPORT PREVIEW</span>
              <h2>{draft.title}</h2>
              <p>
                {draft.startDate} → {draft.endDate}
                {readOnly ? " · 已确认快照" : " · 可编辑草稿"}
              </p>
            </div>
            <div className="button-group">
              <button
                type="button"
                onClick={() => copyReportTable(items).then(() => setMessage("表格已复制。"))}
              >
                复制表格
              </button>
              <button
                type="button"
                onClick={() => exportReportExcel(String(draft.title), items)}
              >
                Excel
              </button>
              <button
                type="button"
                onClick={() => exportReportWord(String(draft.title), items)}
              >
                Word
              </button>
            </div>
          </div>
          <div className="report-table">
            <div className="report-table-head">
              <span>序号</span>
              <span>目标客户</span>
              <span>内容</span>
              <span>状态</span>
              <span>备注</span>
              <span>操作</span>
            </div>
            {items.map((item, index) => (
              <div className="report-table-row" key={`${index}-${item.target}`}>
                <span>{index + 1}</span>
                {readOnly ? (
                  <span>{item.target}</span>
                ) : (
                  <input
                    value={item.target ?? ""}
                    onChange={(event) =>
                      updateItem(index, "target", event.target.value)
                    }
                  />
                )}
                {readOnly ? (
                  <span>{item.content}</span>
                ) : (
                  <textarea
                    rows={4}
                    value={item.content ?? ""}
                    onChange={(event) =>
                      updateItem(index, "content", event.target.value)
                    }
                  />
                )}
                {readOnly ? (
                  <span>{item.status}</span>
                ) : (
                  <select
                    value={item.status ?? "进行中"}
                    onChange={(event) =>
                      updateItem(index, "status", event.target.value)
                    }
                  >
                    {fixedReportStatuses.map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                )}
                {readOnly ? (
                  <span>{item.remark}</span>
                ) : (
                  <textarea
                    rows={3}
                    value={item.remark ?? ""}
                    onChange={(event) =>
                      updateItem(index, "remark", event.target.value)
                    }
                  />
                )}
                {!readOnly ? (
                  <div className="report-row-actions">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveItem(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === items.length - 1}
                      onClick={() => moveItem(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          items: items.filter((_, itemIndex) => itemIndex !== index),
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                ) : (
                  <span>—</span>
                )}
              </div>
            ))}
          </div>
          {!readOnly ? (
            <div className="report-preview-actions">
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    items: [
                      ...items,
                      { target: "", content: "", status: "进行中", remark: "" },
                    ],
                  })
                }
              >
                + 添加一行
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !items.length}
                onClick={saveReport}
              >
                Confirm and Save Report / 确认并保存
              </button>
            </div>
          ) : null}
          <div className="source-summary">
            <p>
              Based on / 数据来源：{sourceSummary.activityCount ?? 0} 条工作活动，
              {sourceSummary.customerCount ?? 0} 个客户，
              {sourceSummary.projectCount ?? 0} 个项目
            </p>
            <button type="button" onClick={() => setShowSources((open) => !open)}>
              {showSources ? "收起来源" : "View Sources / 查看来源"}
            </button>
          </div>
          {showSources ? (
            <div className="report-source-details">
              {sourceDetails.map((detail) => (
                <article key={detail.target}>
                  <strong>{detail.target}</strong>
                  <ul>
                    {Object.entries(detail.counts ?? {}).map(([type, count]) => (
                      <li key={type}>
                        {type}：{String(count)}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="plain-panel report-history">
        <div className="panel-heading">
          <h2>Report History / 报告历史</h2>
          <span>{history.length}</span>
        </div>
        {history.length ? (
          <div className="report-history-list">
            {history.map((report) => {
              const historicalItems = reportRows(report.items);
              return (
                <article key={report.id}>
                  <div>
                    <strong>{report.title}</strong>
                    <p>
                      {report.start_date} → {report.end_date} · 确认于{" "}
                      {formatDate(report.confirmed_at)}
                    </p>
                  </div>
                  <div className="task-actions">
                    <button type="button" onClick={() => openHistory(report, "view")}>
                      查看
                    </button>
                    <button
                      type="button"
                      onClick={() => openHistory(report, "duplicate")}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      onClick={() => openHistory(report, "version")}
                    >
                      编辑为新版本
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        copyReportTable(historicalItems).then(() =>
                          setMessage("历史报告表格已复制。"),
                        )
                      }
                    >
                      Copy Table
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        exportReportExcel(report.title, historicalItems)
                      }
                    >
                      Excel
                    </button>
                    <button
                      type="button"
                      onClick={() => exportReportWord(report.title, historicalItems)}
                    >
                      Word
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="还没有已确认报告"
            detail="先生成草稿，审核后点击“确认并保存”。"
          />
        )}
      </section>
    </div>
  );
}

function CustomersView({
  data,
  tab,
  onTab,
  query,
  onQuery,
  onSelect,
  onAdd,
}: {
  data: WorkspaceData;
  tab: "existing" | "potential_customer" | "potential_lead";
  onTab: (tab: "existing" | "potential_customer" | "potential_lead") => void;
  query: string;
  onQuery: (query: string) => void;
  onSelect: (row: Row) => void;
  onAdd: () => void;
}) {
  const [gradeFilter, setGradeFilter] = useState("all");
  const labels = {
    existing: "老客户",
    potential_customer: "潜在客户",
    potential_lead: "潜在线索",
  };
  const today = localDateText(new Date());
  useEffect(() => setGradeFilter("all"), [tab]);
  const lifecycleRows = data.customers.filter((customer) => {
    if (customer.lifecycle !== tab) return false;
    const haystack = JSON.stringify(customer).toLowerCase();
    return !query || haystack.includes(query.toLowerCase());
  });
  const reviewDueCount = lifecycleRows.filter((customer) =>
    ratingReviewDue(customer, today),
  ).length;
  const rows = sortCustomersForLifecycle(
    lifecycleRows.filter((customer) => {
      if (tab === "potential_lead" || gradeFilter === "all") return true;
      if (gradeFilter === "review_due") return ratingReviewDue(customer, today);
      const grade = normalizeCustomerGrade(tab, customer.grade);
      return gradeFilter === "unrated" ? !grade : grade === gradeFilter;
    }),
    tab,
    today,
  );
  const gradeFilters =
    tab === "potential_customer"
      ? ["all", "1", "2", "3", "4", "unrated", "review_due"]
      : tab === "existing"
        ? ["all", "A", "B", "C", "D", "unrated", "review_due"]
        : [];
  const filterLabel = (value: string) =>
    value === "all"
      ? "全部"
      : value === "unrated"
        ? "未评级"
        : value === "review_due"
          ? `待复盘 ${reviewDueCount}`
          : tab === "existing"
            ? `${value}类`
            : `${value}级`;
  const gradeGuide =
    tab === "existing"
      ? "A 高价值长期合作 · 7天｜B 有培养价值 · 15天｜C 低活跃/有风险 · 30天｜D 清理型客户 · 45天"
      : tab === "potential_customer"
        ? "1 有能力+有意向 · 7天｜2 有意向但能力受限 · 15天｜3 有能力但意向不足 · 30天｜4 能力/意向都弱 · 45天"
        : "";
  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="CUSTOMERS"
        title="客户"
        detail="从潜在线索到成交客户，历史始终留在同一个客户实体上。"
        action={
          <button className="primary-button" type="button" onClick={onAdd}>
            新增客户
          </button>
        }
      />
      <div className="subnav">
        {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            type="button"
            onClick={() => onTab(key)}
          >
            {labels[key]}
            <span>
              {
                data.customers.filter(
                  (customer) => customer.lifecycle === key,
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      {gradeFilters.length ? (
        <div className="customer-grade-filter-row">
          <div className="customer-grade-filters" aria-label="客户等级筛选">
            {gradeFilters.map((value) => (
              <button
                className={gradeFilter === value ? "active" : ""}
                key={value}
                type="button"
                onClick={() => setGradeFilter(value)}
              >
                {filterLabel(value)}
              </button>
            ))}
          </div>
          {gradeGuide ? <p className="customer-grade-guide">{gradeGuide}</p> : null}
        </div>
      ) : null}
      <div className="list-toolbar">
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="搜索客户代码、公司、国家、联系人…"
        />
        <small>{rows.length} 条记录</small>
      </div>
      <section className={`customer-table customer-priority-table ${tab}`}>
        <div className="table-head">
          <span>客户</span>
          <span>国家 / 类型</span>
          {tab === "potential_customer" ? (
            <>
              <span>潜客等级</span>
              <span>当前需求</span>
              <span>下次跟进</span>
              <span>跟进状态</span>
            </>
          ) : tab === "existing" ? (
            <>
              <span>客户等级</span>
              <span>上次联系</span>
              <span>跟进状态</span>
              <span>下一步</span>
              <span>合作概况</span>
            </>
          ) : (
            <>
              <span>来源</span>
              <span>下一步</span>
            </>
          )}
        </div>
        {rows.map((customer) => {
          const grade = normalizeCustomerGrade(tab, customer.grade);
          const followup = getCustomerFollowUpState(customer, today);
          return (
            <button
              className="table-row"
              type="button"
              key={customer.id}
              onClick={() => onSelect(customer)}
            >
              <span>
                <strong>{customer.company}</strong>
                {tab === "existing" ? <small>{customer.customer_code || "缺少客户代码"}</small> : null}
              </span>
              <span>
                <strong>{customer.country || "未填写"}</strong>
                <small>{customer.customer_type || "未分类"}</small>
              </span>
              {tab === "potential_customer" ? (
                <>
                  <span>
                    <em className={`customer-grade-chip grade-${grade || "unrated"}`}>
                      {grade ? `${grade}级` : "未评级"}
                    </em>
                    {ratingReviewDue(customer, today) ? (
                      <small>超过30天未复盘等级</small>
                    ) : null}
                  </span>
                  <span>
                    <strong>{customer.next_action || "尚未记录需求"}</strong>
                    <small>{customer.rating_reason || "暂无评级依据"}</small>
                  </span>
                  <span>
                    <strong>{customer.next_follow ? formatDate(customer.next_follow) : "—"}</strong>
                    <small>{POTENTIAL_FOLLOWUP_SUGGESTIONS[grade] || "先完成评级"}</small>
                  </span>
                  <span>
                    <em className={`customer-followup ${followup.kind} ${followup.overdueDays >= 7 ? "severe" : ""}`}>
                      {followup.label}
                    </em>
                  </span>
                </>
              ) : tab === "existing" ? (
                <>
                  <span>
                    <em className={`customer-grade-chip grade-${grade || "unrated"}`}>
                      {grade ? `${grade}类` : "未评级"}
                    </em>
                    {ratingReviewDue(customer, today) ? (
                      <small>超过30天未复盘等级</small>
                    ) : null}
                  </span>
                  <span>
                    <strong>{customer.last_follow ? formatDate(customer.last_follow) : "—"}</strong>
                    <small>{grade ? `默认${EXISTING_CONTACT_CYCLES[grade]}天` : "评级后显示周期"}</small>
                  </span>
                  <span>
                    <em className={`customer-followup ${followup.kind} ${followup.overdueDays >= 7 ? "severe" : ""}`}>
                      {followup.label}
                    </em>
                  </span>
                  <span>
                    <strong className="customer-next-action">
                      {customer.next_action || "—"}
                    </strong>
                  </span>
                  <span>
                    <strong>{formatCny(customer.total_sales_cny)}</strong>
                    <small>{customer.order_count} 笔订单</small>
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <strong>{customer.source || "未记录来源"}</strong>
                  </span>
                  <span>
                    <strong>{customer.next_action || "尚未设置"}</strong>
                  </span>
                </>
              )}
            </button>
          );
        })}
        {!rows.length ? (
          <EmptyState
            title={`没有匹配的${labels[tab]}`}
            detail="更换搜索条件，或新增一条客户记录。"
          />
        ) : null}
      </section>
    </div>
  );
}

function customerFormSignature(form: HTMLFormElement) {
  const state: Record<string, CustomerEditorValue> = {};
  const controls = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input[name], select[name], textarea[name]",
    ),
  );
  for (const control of controls) {
    if (control.disabled || control.dataset.dirtyIgnore === "true") continue;
    if (control instanceof HTMLInputElement && control.type === "radio") {
      if (!control.checked) continue;
      state[control.name] = control.value;
      continue;
    }
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      state[control.name] = control.checked;
      continue;
    }
    if (control instanceof HTMLSelectElement && control.multiple) {
      state[control.name] = Array.from(control.selectedOptions, (option) => option.value);
      continue;
    }
    const kind =
      control instanceof HTMLInputElement && control.type === "number"
        ? "number"
        : control instanceof HTMLInputElement && control.type === "date"
          ? "date"
          : "text";
    state[control.name] = normalizeCustomerEditorValue(control.value, kind);
  }
  return customerEditorStateSignature(state);
}

function customerEditorFormMap(root: HTMLDivElement | null) {
  const forms = new Map<string, HTMLFormElement>();
  if (!root) return forms;
  root.querySelectorAll<HTMLFormElement>("form[data-customer-form]").forEach((form) => {
    const key = form.dataset.customerForm;
    if (key) forms.set(key, form);
  });
  return forms;
}

function useCustomerCloseGuard({
  isDirty,
  isSaving,
  onClose,
  onSavingClose,
}: {
  isDirty: () => boolean;
  isSaving: () => boolean;
  onClose: () => void;
  onSavingClose?: () => void;
}) {
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const requestClose = useCallback(() => {
    if (isSaving()) {
      onSavingClose?.();
      return;
    }
    if (isDirty()) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  }, [isDirty, isSaving, onClose, onSavingClose]);
  const discardChanges = useCallback(() => {
    setCloseConfirmOpen(false);
    onClose();
  }, [onClose]);

  return {
    closeConfirmOpen,
    requestClose,
    continueEditing: () => setCloseConfirmOpen(false),
    discardChanges,
  };
}

function CustomerEditorDialog({
  ariaLabel,
  editorRoot,
  children,
}: {
  ariaLabel: string;
  editorRoot: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [portalReady, setPortalReady] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!portalReady) return;
    const scrollContainer = editorRoot.current?.closest<HTMLElement>(".modal-card");
    const previousContainerOverflow = scrollContainer?.style.overflow || "";
    const previousBodyOverflow = document.body.style.overflow;

    if (scrollContainer) scrollContainer.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('button:not([disabled])')
        ?.focus({ preventScroll: true });
    });

    return () => {
      if (scrollContainer) scrollContainer.style.overflow = previousContainerOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [editorRoot, portalReady]);

  if (!portalReady) return null;
  return createPortal(
    <div className="customer-editor-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}

function CustomerUnsavedChangesDialog({
  open,
  editorRoot,
  onContinue,
  onDiscard,
}: {
  open: boolean;
  editorRoot: React.RefObject<HTMLDivElement | null>;
  onContinue: () => void;
  onDiscard: () => void;
}) {
  if (!open) return null;
  return (
    <CustomerEditorDialog ariaLabel="未保存修改" editorRoot={editorRoot}>
      <h3>当前有未保存的修改，确定关闭吗？</h3>
      <p>放弃修改后，本次尚未保存的内容不会写入客户资料。</p>
      <div className="dialog-actions">
        <button type="button" onClick={onContinue}>
          继续编辑
        </button>
        <button className="danger-button" type="button" onClick={onDiscard}>
          放弃修改
        </button>
      </div>
    </CustomerEditorDialog>
  );
}

function sortFollowUps(rows: Row[]) {
  return [...rows].sort((left, right) => {
    const byDate = String(right.follow_up_at || "").localeCompare(String(left.follow_up_at || ""));
    if (byDate) return byDate;
    return String(right.created_at || "").localeCompare(String(left.created_at || ""));
  });
}

function FollowUpHistoryItem({
  followUp,
  lifecycle,
  today,
  editing,
  confirmingDelete,
  actionBusy,
  error,
  onStartEdit,
  onCancelEdit,
  onRequestDelete,
  onCancelDelete,
  onSave,
  onDelete,
}: {
  followUp: Row;
  lifecycle: string;
  today: string;
  editing: boolean;
  confirmingDelete: boolean;
  actionBusy: boolean;
  error: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: () => void;
}) {
  const content = String(followUp.content || "");
  const contentRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [content]);

  useEffect(() => {
    if (expanded) return;
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setIsTruncated(element.scrollHeight > element.clientHeight + 1);
    const frame = window.requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [content, expanded]);

  if (editing) {
    return (
      <article className="follow-up-item editing">
        <form className="follow-up-form follow-up-inline-editor" onSubmit={onSave}>
          <label>
            跟进日期
            <DateInput
              name="followUpDate"
              required
              max={today}
              defaultValue={String(followUp.follow_up_at || "").slice(0, 10)}
            />
          </label>
          <label>
            跟进内容
            <textarea name="content" rows={3} required defaultValue={content} />
          </label>
          {error ? <p className="inline-warning" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" disabled={actionBusy} onClick={onCancelEdit}>取消</button>
            <button className="primary-button" type="submit" disabled={actionBusy}>
              {actionBusy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </article>
    );
  }

  return (
    <article className="follow-up-item">
      <div className="follow-up-item-header">
        <time>{formatDate(followUp.follow_up_at)}</time>
        {confirmingDelete ? (
          <span className="follow-up-delete-confirm">
            确认删除这条跟进记录？
            <button type="button" disabled={actionBusy} onClick={onCancelDelete}>取消</button>
            <button className="danger-button" type="button" disabled={actionBusy} onClick={onDelete}>
              {actionBusy ? "删除中…" : "删除"}
            </button>
          </span>
        ) : (
          <span className="follow-up-item-actions">
            <button type="button" disabled={actionBusy} onClick={onStartEdit}>编辑</button>
            <button className="danger-button" type="button" disabled={actionBusy} onClick={onRequestDelete}>删除</button>
          </span>
        )}
      </div>
      {error ? <p className="inline-warning" role="alert">{error}</p> : null}
      <p ref={contentRef} className={expanded ? "expanded" : ""}>{content}</p>
      {isTruncated ? (
        <button className="follow-up-expand" type="button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      ) : null}
      {followUp.next_follow_up_date ? <small>下次跟进：{formatDate(followUp.next_follow_up_date)}</small> : null}
    </article>
  );
}

function CustomerDetail({
  customer,
  orders,
  contacts,
  onSaved,
  onDeleted,
  onClose,
  closeRequestRef,
  onFeedback,
  onKnowledge,
  focusFollowUps,
  onFollowUpsFocused,
}: {
  customer: Row;
  orders: Row[];
  contacts: Row[];
  onSaved: (snapshot: Row) => void;
  onDeleted: (customerId: string) => void;
  onClose: () => void;
  closeRequestRef: MutableRefObject<(() => void) | null>;
  onFeedback: (message: string) => void;
  onKnowledge: (id: string) => void;
  focusFollowUps: boolean;
  onFollowUpsFocused: () => void;
}) {
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [advice, setAdvice] = useState<Row | null>(null);
  const [ratingAdvice, setRatingAdvice] = useState<Row | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const baselineRef = useRef(new Map<string, string>());
  const savingRef = useRef(false);
  const [profileLifecycle, setProfileLifecycle] = useState(String(customer.lifecycle));
  const [grade, setGrade] = useState(
    normalizeCustomerGrade(customer.lifecycle, customer.grade),
  );
  const [purchaseIntent, setPurchaseIntent] = useState(
    String(customer.purchase_intent || "unconfirmed"),
  );
  const [purchaseAbility, setPurchaseAbility] = useState(
    String(customer.purchase_ability || "unconfirmed"),
  );
  const [ratingReason, setRatingReason] = useState(
    String(customer.rating_reason || ""),
  );
  const [nextFollow, setNextFollow] = useState(
    String(customer.next_follow || "").slice(0, 10),
  );
  const [nextFollowSaveState, setNextFollowSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null);
  const [deletingFollowUpId, setDeletingFollowUpId] = useState<string | null>(null);
  const [followUpActionId, setFollowUpActionId] = useState<string | null>(null);
  const [followUpActionError, setFollowUpActionError] = useState("");
  const [followUps, setFollowUps] = useState<Row[]>([]);
  const [followUpTotal, setFollowUpTotal] = useState(0);
  const [followUpHasMore, setFollowUpHasMore] = useState(false);
  const [followUpLoadState, setFollowUpLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [followUpLoadError, setFollowUpLoadError] = useState("");
  const [followUpLoadingMore, setFollowUpLoadingMore] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const newContactRef = useRef<HTMLFormElement | null>(null);
  const followUpRef = useRef<HTMLFormElement | null>(null);
  const followUpSectionRef = useRef<HTMLElement | null>(null);
  const basicInformationRef = useRef<HTMLElement | null>(null);
  const followUpCardRef = useRef<HTMLElement | null>(null);
  const followUpHistoryRef = useRef<HTMLDivElement | null>(null);
  const [followUpHistoryHeight, setFollowUpHistoryHeight] = useState<number | null>(null);
  const customerOrders = orders.filter(
    (order) =>
      order.customer_id === customer.id ||
      (customer.lifecycle === "existing" && customer.customer_code &&
        order.customer_code === customer.customer_code),
  );
  const busy = isSaving || aiBusy || isDeleting;

  async function loadFollowUpPage(
    offset: number,
    append: boolean,
    signal?: AbortSignal,
  ) {
    const customerId = String(customer.id);
    if (append) setFollowUpLoadingMore(true);
    else if (!customerFollowUpCache.has(customerId)) setFollowUpLoadState("loading");
    setFollowUpLoadError("");
    try {
      const limit = append ? FOLLOW_UP_PAGE_SIZE : FOLLOW_UP_INITIAL_LIMIT;
      const response = await fetch(
        `/api/customers?customerId=${encodeURIComponent(customerId)}&limit=${limit}&offset=${offset}`,
        { signal },
      );
      const result = await readApiJson(response, "跟进记录读取失败。");
      if (signal?.aborted) return false;
      const incoming = reportRows(result.followUps);
      const existingIds = new Set(followUps.map((row) => String(row.id)));
      const nextRows = append
        ? [...followUps, ...incoming.filter((row) => !existingIds.has(String(row.id)))]
        : incoming;
      setFollowUps(nextRows);
      const total = Number(result.total || 0);
      const hasMore = Boolean(result.hasMore);
      setFollowUpTotal(total);
      setFollowUpHasMore(hasMore);
      setFollowUpLoadState("ready");
      customerFollowUpCache.set(customerId, { followUps: nextRows, total, hasMore });
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      const message = error instanceof Error ? error.message : "跟进记录读取失败。";
      setFollowUpLoadError(message);
      if (!append && !customerFollowUpCache.has(customerId)) {
        setFollowUpLoadState("error");
        setFollowUps([]);
      }
      return false;
    } finally {
      if (!signal?.aborted) setFollowUpLoadingMore(false);
    }
  }

  useEffect(() => {
    const customerId = String(customer.id);
    const cached = customerFollowUpCache.get(customerId);
    if (cached) {
      setFollowUps(cached.followUps);
      setFollowUpTotal(cached.total);
      setFollowUpHasMore(cached.hasMore);
      setFollowUpLoadState("ready");
    } else {
      setFollowUps([]);
      setFollowUpTotal(0);
      setFollowUpHasMore(false);
      setFollowUpLoadState("loading");
    }
    const controller = new AbortController();
    void loadFollowUpPage(0, false, controller.signal);
    return () => controller.abort();
  }, [customer.id]);

  useEffect(() => {
    if (!focusFollowUps) return;
    const frame = window.requestAnimationFrame(() => {
      followUpSectionRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
      onFollowUpsFocused();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusFollowUps, onFollowUpsFocused]);

  useEffect(() => {
    const basicInformation = basicInformationRef.current;
    const followUpCard = followUpCardRef.current;
    const followUpHistory = followUpHistoryRef.current;
    if (!basicInformation || !followUpCard || !followUpHistory) return;

    let frame = 0;
    const syncHistoryViewport = () => {
      if (!window.matchMedia("(min-width: 921px)").matches) {
        setFollowUpHistoryHeight((current) => (current === null ? current : null));
        return;
      }

      const basicInformationBottom = basicInformation.getBoundingClientRect().bottom;
      const historyTop = followUpHistory.getBoundingClientRect().top;
      const cardBottom = followUpCard.getBoundingClientRect().bottom;
      const historyBottom = followUpHistory.getBoundingClientRect().bottom;
      const cardSpaceAfterHistory = Math.max(0, cardBottom - historyBottom);
      const nextHeight = Math.max(
        0,
        Math.floor(basicInformationBottom - historyTop - cardSpaceAfterHistory),
      );

      setFollowUpHistoryHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    const scheduleSync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncHistoryViewport);
    };

    scheduleSync();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(basicInformation);
    window.addEventListener("resize", scheduleSync);
    const media = window.matchMedia("(min-width: 921px)");
    media.addEventListener("change", scheduleSync);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      media.removeEventListener("change", scheduleSync);
    };
  }, [customer.id, followUpOpen, followUps.length, followUpHasMore, followUpLoadState]);

  const ratingFormChanged = useCallback(() => {
    const gradeChanged =
      grade !== normalizeCustomerGrade(customer.lifecycle, customer.grade);
    const ratingReasonChanged = ratingReason !== String(customer.rating_reason || "");
    if (customer.lifecycle !== "potential_customer") {
      return gradeChanged || ratingReasonChanged;
    }
    return (
      gradeChanged ||
      ratingReasonChanged ||
      purchaseIntent !== String(customer.purchase_intent || "unconfirmed") ||
      purchaseAbility !== String(customer.purchase_ability || "unconfirmed")
    );
  }, [
    customer.grade,
    customer.lifecycle,
    customer.purchase_ability,
    customer.purchase_intent,
    customer.rating_reason,
    grade,
    purchaseAbility,
    purchaseIntent,
    ratingReason,
  ]);

  const refreshDirty = useCallback(() => {
    const forms = customerEditorFormMap(editorRef.current);
    const baseline = baselineRef.current;
    const changed =
      forms.size !== baseline.size ||
      Array.from(forms).some(
        ([key, form]) => baseline.get(key) !== customerFormSignature(form),
      );
    setIsDirty(changed || ratingFormChanged());
  }, [ratingFormChanged]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      baselineRef.current = new Map(
        Array.from(customerEditorFormMap(editorRef.current), ([key, form]) => [
          key,
          customerFormSignature(form),
        ]),
      );
      setIsDirty(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [customer.id]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(refreshDirty);
    return () => window.cancelAnimationFrame(frame);
  }, [grade, profileLifecycle, purchaseAbility, purchaseIntent, ratingReason, refreshDirty]);

  async function requestCustomerSave(action: string, payload: Row) {
    const response = await fetch("/api/customers", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action, customerId: customer.id, ...payload }),
    });
    return readApiJson(response, "保存失败。");
  }

  async function requestCustomerDelete() {
    if (busy) return;
    if (isDirty) {
      setDeleteError("请先保存当前修改，或放弃修改后再删除客户。");
      return;
    }
    setDeleteError("");
    setIsDeleting(true);
    try {
      const result = await requestCustomerSave("check_delete", {});
      if (!result.eligible) {
        setDeleteError(String(result.message || "该客户存在关联的正式业务记录，无法删除。"));
        return;
      }
      setDeleteConfirmOpen(true);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除检查失败，请稍后重试。");
    } finally {
      setIsDeleting(false);
    }
  }

  async function deleteCustomer() {
    if (busy) return;
    setDeleteError("");
    setIsDeleting(true);
    savingRef.current = true;
    try {
      const result = await requestCustomerSave("delete_customer", {});
      if (!result.deleted) throw new Error("客户删除失败，请稍后重试。");
      customerFollowUpCache.delete(String(customer.id));
      setDeleteConfirmOpen(false);
      onDeleted(String(customer.id));
      onFeedback("客户已删除");
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "客户删除失败，请稍后重试。");
    } finally {
      savingRef.current = false;
      setIsDeleting(false);
    }
  }

  function formValues(form: HTMLFormElement) {
    const data = new FormData(form);
    const values: Row = {};
    data.forEach((value, key) => {
      values[key] = value;
    });
    return values;
  }

  function operationForForm(key: string, form: HTMLFormElement) {
    const values = formValues(form);
    if (key === "rating") {
      return {
        action: "update_rating",
        payload: { grade, purchaseIntent, purchaseAbility, ratingReason },
      };
    }
    if (key === "profile") return { action: "update_profile", payload: values };
    if (key.startsWith("contact:")) {
      values.isPrimary = new FormData(form).get("isPrimary") === "on";
      return { action: "save_contact", payload: values };
    }
    return null;
  }

  async function saveAll(
    extraOperations: Array<{ action: string; payload: Row }> = [],
    closeAfterSave = false,
  ) {
    if (savingRef.current) return false;
    const forms = customerEditorFormMap(editorRef.current);
    const changedForms = Array.from(forms).filter(
      ([key, form]) => baselineRef.current.get(key) !== customerFormSignature(form),
    );
    const formsToSave =
      profileLifecycle !== String(customer.lifecycle)
        ? changedForms.filter(([key]) => key !== "rating")
        : changedForms;
    const ratingForm = forms.get("rating");
    if (
      ratingForm &&
      profileLifecycle === String(customer.lifecycle) &&
      ratingFormChanged() &&
      !formsToSave.some(([key]) => key === "rating")
    ) {
      formsToSave.push(["rating", ratingForm]);
    }
    for (const [, form] of formsToSave) {
      if (!form.reportValidity()) return false;
    }
    const operations = [
      ...formsToSave
        .map(([key, form]) => operationForForm(key, form))
        .filter((operation): operation is { action: string; payload: Row } => Boolean(operation)),
      ...extraOperations,
    ];
    if (!operations.length) return true;

    savingRef.current = true;
    setIsSaving(true);
    setSaveError("");
    setMessage("");
    try {
      let latestSnapshot: Row | null = null;
      for (const operation of operations) {
        const result = await requestCustomerSave(operation.action, operation.payload);
        if (result.snapshot) latestSnapshot = result.snapshot;
      }
      baselineRef.current = new Map(
        Array.from(customerEditorFormMap(editorRef.current), ([key, form]) => [
          key,
          customerFormSignature(form),
        ]),
      );
      setIsDirty(false);
      if (latestSnapshot) onSaved(latestSnapshot);
      onFeedback("已保存");
      if (closeAfterSave) onClose();
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请稍后重试。");
      setIsDirty(true);
      return false;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function submitAll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveAll();
  }

  const closeGuard = useCustomerCloseGuard({
    isDirty: () => isDirty,
    isSaving: () => savingRef.current,
    onClose,
    onSavingClose: () => setMessage("正在保存，请稍候。"),
  });

  closeRequestRef.current = closeGuard.requestClose;

  async function generateAdvice() {
    setAiBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/sales-advice", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          kind: customer.lifecycle === "existing" ? "existing_customer" : "potential_customer",
          id: customer.id,
        }),
      });
      setAdvice(await readApiJson(response, "销售建议生成失败。"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "销售建议生成失败。");
    } finally {
      setAiBusy(false);
    }
  }

  async function generateRatingAdvice() {
    if (customer.lifecycle === "potential_lead") return;
    setAiBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/sales-advice", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          mode: "customer_rating",
          kind: customer.lifecycle === "existing" ? "existing_customer" : "potential_customer",
          id: customer.id,
        }),
      });
      const result = await readApiJson(response, "客户等级分析失败。");
      setRatingAdvice(result.ratingAdvice || null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "客户等级分析失败。");
    } finally {
      setAiBusy(false);
    }
  }

  function adoptRatingAdvice() {
    if (!ratingAdvice) return;
    setGrade(String(ratingAdvice.suggested_grade || ""));
    setRatingReason(String(ratingAdvice.rating_reason || ""));
    if (customer.lifecycle === "potential_customer") {
      setPurchaseIntent(String(ratingAdvice.purchase_intent || "unconfirmed"));
      setPurchaseAbility(String(ratingAdvice.purchase_ability || "unconfirmed"));
    }
    setMessage("建议已填入，检查后请手动保存。");
  }

  async function loadMoreFollowUps() {
    if (followUpLoadingMore || !followUpHasMore) return;
    await loadFollowUpPage(followUps.length, true);
  }

  async function saveNewContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = newContactRef.current;
    if (!form || savingRef.current || !form.reportValidity()) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const values = formValues(form);
      values.isPrimary = new FormData(form).get("isPrimary") === "on";
      const result = await requestCustomerSave("save_contact", values);
      if (result.snapshot) onSaved(result.snapshot);
      form.reset();
      setNewContactOpen(false);
      onFeedback("联系人已保存");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "联系人保存失败。");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function saveNextFollow(nextValue: string) {
    if (nextFollowSaveState === "saving") return;
    const previousValue = nextFollow;
    setNextFollow(nextValue);
    setNextFollowSaveState("saving");
    try {
      const result = await requestCustomerSave("save_next_follow_up", { nextFollow: nextValue });
      if (result.snapshot) onSaved(result.snapshot);
      setNextFollow(String(result.snapshot?.customer?.next_follow || nextValue).slice(0, 10));
      setNextFollowSaveState("saved");
    } catch {
      setNextFollow(previousValue);
      setNextFollowSaveState("error");
      setMessage("下次跟进日期保存失败，请重试");
    }
  }

  async function saveFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = followUpRef.current;
    if (!form || savingRef.current || !form.reportValidity()) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const values = formValues(form);
      const result = await requestCustomerSave("record_follow_up", values);
      if (result.snapshot) onSaved(result.snapshot);
      const created = result.followUp as Row | undefined;
      const total = followUpTotal + 1;
      setFollowUps((current) => {
        const rows = sortFollowUps(created ? [created, ...current] : current);
        customerFollowUpCache.set(String(customer.id), {
          followUps: rows,
          total,
          hasMore: followUpHasMore,
        });
        return rows;
      });
      setFollowUpTotal(total);
      setFollowUpLoadState("ready");
      form.reset();
      setFollowUpOpen(false);
      onFeedback("跟进已记录");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "跟进记录保存失败。");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  async function saveFollowUpEdit(followUp: Row, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (savingRef.current || !form.reportValidity()) return;
    const followUpId = String(followUp.id);
    savingRef.current = true;
    setIsSaving(true);
    setFollowUpActionId(followUpId);
    setFollowUpActionError("");
    try {
      const result = await requestCustomerSave("update_follow_up", {
        followUpId,
        ...formValues(form),
      });
      if (result.snapshot) onSaved(result.snapshot);
      const updated = result.followUp as Row | undefined;
      if (updated) {
        setFollowUps((current) => {
          const rows = sortFollowUps(
            current.map((item) => String(item.id) === followUpId ? updated : item),
          );
          customerFollowUpCache.set(String(customer.id), {
            followUps: rows,
            total: followUpTotal,
            hasMore: followUpHasMore,
          });
          return rows;
        });
      }
      setEditingFollowUpId(null);
      onFeedback("跟进已更新");
    } catch (error) {
      setFollowUpActionError(error instanceof Error ? error.message : "跟进记录保存失败。");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
      setFollowUpActionId(null);
    }
  }

  async function deleteFollowUp(followUp: Row) {
    const followUpId = String(followUp.id);
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    setFollowUpActionId(followUpId);
    setFollowUpActionError("");
    try {
      const result = await requestCustomerSave("delete_follow_up", { followUpId });
      if (result.snapshot) onSaved(result.snapshot);
      const total = Math.max(0, followUpTotal - 1);
      setFollowUps((current) => {
        const rows = current.filter((item) => String(item.id) !== followUpId);
        customerFollowUpCache.set(String(customer.id), {
          followUps: rows,
          total,
          hasMore: followUpHasMore,
        });
        return rows;
      });
      setFollowUpTotal(total);
      setDeletingFollowUpId(null);
      onFeedback("跟进记录已删除");
    } catch (error) {
      setFollowUpActionError(error instanceof Error ? error.message : "跟进记录删除失败。");
    } finally {
      savingRef.current = false;
      setIsSaving(false);
      setFollowUpActionId(null);
    }
  }

  const today = localDateText(new Date());
  const savedGrade = normalizeCustomerGrade(customer.lifecycle, customer.grade);
  const ratingFollowup = getCustomerFollowUpState(
    { ...customer, grade, next_follow: nextFollow || null },
    today,
  );

  return (
    <div
      className="customer-editor"
      ref={editorRef}
      onInput={refreshDirty}
      onChange={refreshDirty}
    >
      <div className="customer-editor-toolbar">
        <div>
          <strong>{customer.company}</strong>
          <small>{isDirty ? "有未保存修改" : "所有修改已保存"}</small>
        </div>
        <div className="customer-editor-toolbar-actions">
          <button
            className="quiet-button"
            type="button"
            disabled={isSaving}
            onClick={closeGuard.requestClose}
          >
            关闭
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!isDirty || isSaving}
            onClick={() => void saveAll()}
          >
            {isSaving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
      <div className="detail-summary">
        {customer.lifecycle === "existing" ? <span>{customer.customer_code || "未设置代码"}</span> : null}
        <span>{customer.lifecycle}</span>
        {customer.lifecycle !== "potential_lead" ? (
          <span>
            {savedGrade
              ? customer.lifecycle === "existing"
                ? `${savedGrade}类`
                : `${savedGrade}级`
              : "未评级"}
          </span>
        ) : null}
        <span>{customerOrders.length} 笔订单</span>
        <span>{formatCny(customer.total_sales_cny)}</span>
      </div>

      {message ? <p className="inline-warning">{message}</p> : null}

      <div className="customer-editor-columns">
      <div className="customer-editor-profile-column">
      <section className="editor-section sales-advice-panel">
        <div className="editor-heading">
          <div>
            <span>SALES ADVICE</span>
            <h3>客户跟进建议</h3>
          </div>
          <button type="button" disabled={busy} onClick={generateAdvice}>
            {busy ? "正在生成…" : "生成跟进建议"}
          </button>
        </div>
        {advice ? (
          <>
            <dl className="sales-advice-grid">
              {[
                ["当前客户判断", advice.advice?.judgement],
                ["下一步最值得做的动作", advice.advice?.next_action],
                ["沟通重点", advice.advice?.communication_focus],
                ["当前风险或遗漏", advice.advice?.risks],
                ["建议话术", advice.advice?.suggested_message],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>{String(value || "—")}</dd>
                </div>
              ))}
            </dl>
            {reportRows(advice.usedPlaybook).length ? (
              <div className="playbook-references">
                <strong>参考 Playbook</strong>
                {reportRows(advice.usedPlaybook).map((reference) => (
                  <button
                    type="button"
                    key={reference.id}
                    onClick={() =>
                      reference.knowledgeItemId &&
                      onKnowledge(String(reference.knowledgeItemId))
                    }
                  >
                    {reference.principle}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted-copy">
            仅在主动点击时调用 AI；Playbook 匹配在本地完成，最多使用三条相关原则。
          </p>
        )}
      </section>

      {customer.lifecycle !== "potential_lead" ? (
        <section className="editor-section customer-priority-editor">
          <div className="editor-heading">
            <div>
              <span>RESOURCE PRIORITY</span>
              <h3>客户等级与资源投入</h3>
            </div>
            <button type="button" disabled={busy} onClick={generateRatingAdvice}>
              {busy ? "正在分析…" : "分析客户等级"}
            </button>
          </div>
          <form
            className="form-stack"
            data-customer-form="rating"
            onSubmit={submitAll}
          >
            <div className="form-grid customer-rating-grid">
              <label>
                客户等级
                <select
                  name="grade"
                  value={grade}
                  onChange={(event) => setGrade(event.target.value)}
                >
                  <option value="">未评级</option>
                  {(customer.lifecycle === "existing"
                    ? ["A", "B", "C", "D"]
                    : ["1", "2", "3", "4"]
                  ).map((value) => (
                    <option key={value} value={value}>
                      {customer.lifecycle === "existing" ? `${value}类` : `${value}级`}
                    </option>
                  ))}
                </select>
              </label>
              {customer.lifecycle === "potential_customer" ? (
                <>
                  <label>
                    购买意愿
                    <select
                      name="purchaseIntent"
                      value={purchaseIntent}
                      onChange={(event) => setPurchaseIntent(event.target.value)}
                    >
                      <option value="unconfirmed">未确认</option>
                      <option value="high">高</option>
                      <option value="medium">中</option>
                      <option value="low">低</option>
                    </select>
                  </label>
                  <label>
                    购买能力
                    <select
                      name="purchaseAbility"
                      value={purchaseAbility}
                      onChange={(event) => setPurchaseAbility(event.target.value)}
                    >
                      <option value="unconfirmed">未确认</option>
                      <option value="strong">强</option>
                      <option value="limited">有限</option>
                      <option value="weak">弱</option>
                    </select>
                  </label>
                </>
              ) : null}
            </div>
            <label>
              评级依据
              <textarea
                name="ratingReason"
                rows={3}
                value={ratingReason}
                onChange={(event) => setRatingReason(event.target.value)}
                placeholder="用1–3句话记录本次评级的事实依据"
              />
            </label>
            <div className="customer-rating-status">
              <span>
                <small>最后评级</small>
                <strong>
                  {customer.last_reviewed_at
                    ? formatDate(customer.last_reviewed_at)
                    : "未记录"}
                </strong>
              </span>
              <span>
                <small>
                  {customer.lifecycle === "existing" ? "默认联系周期" : "建议跟进频率"}
                </small>
                <strong>
                  {customer.lifecycle === "existing"
                    ? grade
                      ? `${EXISTING_CONTACT_CYCLES[grade]}天`
                      : "评级后显示"
                    : grade
                      ? `${POTENTIAL_CONTACT_CYCLES[grade]}天`
                      : "评级后显示"}
                </strong>
              </span>
              <span>
                <small>当前状态</small>
                <strong className={`customer-followup ${ratingFollowup.kind}`}>
                  {ratingFollowup.label}
                </strong>
              </span>
            </div>
            {ratingAdvice ? (
              <div className="customer-rating-advice">
                <strong>
                  AI建议：{ratingAdvice.suggested_grade}
                  {customer.lifecycle === "existing" ? "类" : "级"}
                </strong>
                <p>{ratingAdvice.rating_reason}</p>
                <small>
                  {ratingAdvice.next_action || ratingAdvice.maintenance_strategy || "—"}
                </small>
                <button type="button" onClick={adoptRatingAdvice}>
                  采用建议并填入
                </button>
                <em>尚未保存，Joyce确认后才会写入。</em>
              </div>
            ) : (
              <p className="muted-copy">
                AI只在主动点击时分析，不会自动修改等级或后台扫描客户。
              </p>
            )}
          </form>
        </section>
      ) : null}

      <section ref={basicInformationRef} className="editor-section">
        <div className="editor-heading">
          <div>
            <span>BASIC INFORMATION</span>
            <h3>基本信息</h3>
          </div>
          <small>所有字段均可编辑</small>
        </div>
        <form
          className="form-stack"
          data-customer-form="profile"
          onSubmit={submitAll}
        >
          <div className="form-grid">
            {profileLifecycle === "existing" ? (
              <label>
                客户代码
                <input name="customerCode" defaultValue={customer.customer_code || ""} required />
              </label>
            ) : null}
            <label>
              公司名称
              <input name="company" defaultValue={customer.company || ""} required />
            </label>
            <label>
              国家
              <input name="country" defaultValue={customer.country || ""} />
            </label>
            <label>
              城市
              <input name="city" defaultValue={customer.city || ""} />
            </label>
            <label>
              网站
              <input name="website" defaultValue={customer.website || ""} />
            </label>
            <label>
              客户类型
              <input
                name="customerType"
                defaultValue={customer.customer_type || ""}
              />
            </label>
            <label>
              来源
              <input name="source" defaultValue={customer.source || ""} />
            </label>
            <label>
              生命周期
              <select
                name="lifecycle"
                value={profileLifecycle}
                onChange={(event) => setProfileLifecycle(event.target.value)}
              >
                <option value="potential_lead">潜在线索</option>
                <option value="potential_customer">潜在客户</option>
                <option value="existing">老客户</option>
              </select>
            </label>
          </div>
          {profileLifecycle !== customer.lifecycle ? (
            <p className="form-note">
              生命周期转换后，新的客户等级将初始化为“未评级”；不会把潜客1–4级自动映射为老客户A–D类。
            </p>
          ) : null}
          <label>
            地址
            <textarea name="address" rows={2} defaultValue={customer.address || ""} />
          </label>
          <label>
            下一步
            <textarea
              name="nextAction"
              rows={2}
              defaultValue={customer.next_action || ""}
            />
          </label>
          <label>
            维护策略
            <textarea name="strategy" rows={3} defaultValue={customer.strategy || ""} />
          </label>
          <label>
            原客户画像 / 注意事项
            <textarea name="profile" rows={4} defaultValue={customer.profile || ""} />
          </label>
          <label>
            公司背景与合作备注
            <textarea
              name="companyBackgroundNotes"
              rows={4}
              defaultValue={customer.company_background_notes || ""}
              placeholder="公司主营、决策流程、采购与合作特点等长期信息"
            />
          </label>
        </form>
      </section>

      <section className="editor-section">
        <div className="editor-heading">
          <div>
            <span>CONTACTS</span>
            <h3>联系人</h3>
          </div>
          <small>支持多个联系人</small>
        </div>
        <div className="contact-editors">
          {contacts.map((contact) => (
            <details className="contact-editor" key={contact.id}>
              <summary>
                <span>
                  <strong>{contact.name || "未命名联系人"}</strong>
                  <small>
                    {contact.position || contact.role || "未填写职位"}
                    {contact.wechat ? ` · 微信：${contact.wechat}` : ""}
                  </small>
                </span>
                {contact.notes ? <em>{contact.notes}</em> : null}
              </summary>
              <form data-customer-form={`contact:${contact.id}`} onSubmit={submitAll}>
              <input name="contactId" type="hidden" value={contact.id} />
              <ContactFieldSet contact={contact} />
              <div className="dialog-actions">
                <button
                  className="danger-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void saveAll([
                      { action: "archive_contact", payload: { contactId: contact.id } },
                    ])
                  }
                >
                  归档
                </button>
              </div>
              </form>
            </details>
          ))}
          <button
            className="add-contact-button"
            type="button"
            disabled={busy}
            onClick={() => setNewContactOpen(true)}
          >
            + 新增联系人
          </button>
          {newContactOpen ? (
          <form className="contact-editor new" ref={newContactRef} onSubmit={saveNewContact}>
            <strong>新增联系人</strong>
            <ContactFieldSet contact={{}} />
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setNewContactOpen(false)}>
                取消
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                保存联系人
              </button>
            </div>
          </form>
          ) : null}
        </div>
      </section>

      </div>
      <aside ref={followUpSectionRef} className="customer-editor-followup-column" aria-label="客户联系与跟进">
      <section ref={followUpCardRef} className="editor-section customer-followup-editor">
        <div className="customer-followup-top">
        <div className="editor-heading">
          <div>
            <span>CUSTOMER FOLLOW-UPS</span>
            <h3>客户联系与跟进</h3>
          </div>
        </div>
        <div className="customer-followup-summary">
          <p><span>最近有效联系</span><strong>{customer.last_contact_at || customer.last_follow ? formatDate(customer.last_contact_at || customer.last_follow) : "未记录"}</strong></p>
          <div className="customer-next-follow-control">
            <label>
              下次跟进
              <DateInput
                value={nextFollow}
                disabled={nextFollowSaveState === "saving"}
                onChange={(event) => void saveNextFollow(event.target.value)}
              />
            </label>
            <div className="customer-next-follow-shortcuts" aria-label="下次跟进快捷日期">
              {[7, 15, 30, 45].map((days) => (
                <button
                  key={days}
                  type="button"
                  disabled={nextFollowSaveState === "saving"}
                  onClick={() => void saveNextFollow(dateAfterLocalDays(today, days))}
                >
                  +{days}天
                </button>
              ))}
            </div>
            <small className={nextFollowSaveState === "error" ? "inline-warning" : ""}>
              {nextFollowSaveState === "saving" ? "正在保存…" : nextFollowSaveState === "saved" ? "已保存" : nextFollowSaveState === "error" ? "下次跟进日期保存失败，请重试" : ratingFollowup.label}
            </small>
          </div>
        </div>
        <div className="follow-up-actions">
          <button type="button" disabled={busy} onClick={() => setFollowUpOpen(true)}>+ 记录跟进</button>
        </div>
        {followUpOpen ? (
          <form className="follow-up-form" ref={followUpRef} onSubmit={saveFollowUp}>
            <label>跟进日期<DateInput name="followUpDate" required max={today} defaultValue={today} /></label>
            <label>跟进内容<textarea name="content" rows={3} required placeholder="记录本次真实沟通内容、结论或关键反馈" /></label>
            <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setFollowUpOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={busy}>保存跟进</button></div>
          </form>
        ) : null}
        </div>
        <div
          ref={followUpHistoryRef}
          className="customer-followup-history"
          aria-label="历史跟进记录"
          style={followUpHistoryHeight === null ? undefined : { height: `${followUpHistoryHeight}px` }}
        >
          <div className="follow-up-history-heading"><h4>历史跟进记录</h4>{followUpTotal ? <small>{followUpTotal} 条</small> : null}</div>
          {followUpLoadState === "loading" && !followUps.length ? <p className="muted-copy">正在加载跟进记录…</p> : null}
          {followUpLoadState === "error" && !followUps.length ? <p className="inline-warning" role="alert">{followUpLoadError}</p> : null}
          <div className="follow-up-list customer-followup-history-list">
            {followUps.map((followUp) => {
              const followUpId = String(followUp.id);
              return (
                <FollowUpHistoryItem
                  key={followUpId}
                  followUp={followUp}
                  lifecycle={String(customer.lifecycle)}
                  today={today}
                  editing={editingFollowUpId === followUpId}
                  confirmingDelete={deletingFollowUpId === followUpId}
                  actionBusy={followUpActionId === followUpId}
                  error={
                    editingFollowUpId === followUpId || deletingFollowUpId === followUpId
                      ? followUpActionError
                      : ""
                  }
                  onStartEdit={() => {
                    setDeletingFollowUpId(null);
                    setFollowUpActionError("");
                    setEditingFollowUpId(followUpId);
                  }}
                  onCancelEdit={() => {
                    setFollowUpActionError("");
                    setEditingFollowUpId(null);
                  }}
                  onRequestDelete={() => {
                    setEditingFollowUpId(null);
                    setFollowUpActionError("");
                    setDeletingFollowUpId(followUpId);
                  }}
                  onCancelDelete={() => setDeletingFollowUpId(null)}
                  onSave={(event) => void saveFollowUpEdit(followUp, event)}
                  onDelete={() => void deleteFollowUp(followUp)}
                />
              );
            })}
            {followUpLoadState === "ready" && !followUps.length ? <p className="muted-copy">还没有正式跟进记录。</p> : null}
          </div>
          {followUpLoadError && followUps.length ? <p className="inline-warning" role="alert">{followUpLoadError}</p> : null}
          {followUpHasMore ? <button className="follow-up-load-more" type="button" disabled={followUpLoadingMore} onClick={() => void loadMoreFollowUps()}>{followUpLoadingMore ? "加载中…" : "加载更多"}</button> : null}
        </div>
      </section>
      </aside>
      </div>

      {["existing", "potential_customer"].includes(String(customer.lifecycle)) ? (
        <section className="editor-section customer-delete-zone">
          <div>
            <span>危险操作</span>
            <h3>删除客户</h3>
            <p>仅当该客户没有订单、售后或其他正式业务关联时，才可以永久删除。</p>
          </div>
          {deleteError ? <p className="inline-warning" role="alert">{deleteError}</p> : null}
          <button
            className="danger-button"
            type="button"
            disabled={busy}
            onClick={() => void requestCustomerDelete()}
          >
            {isDeleting ? "检查中…" : "删除客户"}
          </button>
        </section>
      ) : null}

      {saveError ? (
        <CustomerEditorDialog ariaLabel="保存失败" editorRoot={editorRef}>
          <h3>保存失败</h3>
          <p>{saveError}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setSaveError("")}>确定</button>
            <button
              className="primary-button"
              type="button"
              disabled={isSaving}
              onClick={() => void saveAll()}
            >
              重新尝试保存
            </button>
          </div>
        </CustomerEditorDialog>
      ) : null}

      {deleteConfirmOpen ? (
        <CustomerEditorDialog ariaLabel="确认删除客户" editorRoot={editorRef}>
          <h3>确认删除「{customer.company}」？</h3>
          <p>该客户及其联系人、跟进记录等从属信息将被删除。此操作不可恢复。</p>
          {deleteError ? <p className="inline-warning" role="alert">{deleteError}</p> : null}
          <div className="dialog-actions">
            <button type="button" disabled={isDeleting} onClick={() => setDeleteConfirmOpen(false)}>
              取消
            </button>
            <button
              className="danger-button confirmed"
              type="button"
              disabled={isDeleting}
              onClick={() => void deleteCustomer()}
            >
              {isDeleting ? "正在删除…" : "确认删除"}
            </button>
          </div>
        </CustomerEditorDialog>
      ) : null}

      <CustomerUnsavedChangesDialog
        open={closeGuard.closeConfirmOpen}
        editorRoot={editorRef}
        onContinue={closeGuard.continueEditing}
        onDiscard={closeGuard.discardChanges}
      />
    </div>
  );
}

function LeadsView({ data }: { data: WorkspaceData }) {
  const leads = data.customers.filter(
    (customer) => customer.lifecycle === "potential_lead",
  );
  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="FIND LEADS"
        title="新客开发"
        detail="Phase 1 先保留并筛选潜在线索；多语言自动发现将在 Phase 3 启用。"
      />
      <div className="phase-banner">
        <strong>潜在线索已经进入统一客户生命周期</strong>
        <p>
          当前保留 {leads.length} 条 V1 线索。Google + Maps、多语言宽进严出搜索、
          证据背调与 Doohan Product Knowledge 匹配将在 Phase 3 实现。
        </p>
      </div>
      <section className="lead-grid">
        {leads.slice(0, 45).map((lead) => (
          <article key={lead.id}>
            <div>
              <span>{lead.source || "新线索"}</span>
              <small>{lead.country}</small>
            </div>
            <h3>{lead.company}</h3>
            <p>{lead.profile || "V1 研究资料已完整保留。"}</p>
            <a href={lead.website} target="_blank" rel="noreferrer">
              查看官网
            </a>
          </article>
        ))}
      </section>
    </div>
  );
}

type LeadSnapshot = { lead: Row; contacts: Row[] };

const leadQuickViews = [
  ["all", "全部线索"],
  ["due", "今天要处理"],
  ["high", "高优先级"],
  ["first", "待首次开发"],
  ["replied", "已回复"],
] as const;

const leadPriorityLabels: Record<string, string> = {
  High: "高 · High",
  Medium: "中 · Medium",
  Low: "低 · Low",
};
const leadMarketFitLabels = leadPriorityLabels;
const leadMotoEvBusinessLabels: Record<string, string> = {
  Confirmed: "已确认 · Confirmed",
  Likely: "可能 · Likely",
  Unknown: "未确认 · Unknown",
  No: "无相关业务 · No",
};
const leadCompanyTypeLabels: Record<string, string> = {
  Importer: "进口商 · Importer",
  Distributor: "经销商 · Distributor",
  Dealer: "经销商 · Dealer",
  Brand: "品牌商 · Brand",
  Retailer: "零售商 · Retailer",
  "Rental / Fleet": "租赁 / 车队 · Rental / Fleet",
  "E-commerce": "电商 · E-commerce",
  Other: "其他 · Other",
};
const leadSourceLabels: Record<string, string> = {
  "Online Prospecting": "自主网络开发 · Online Prospecting",
  "Exhibition List": "展会名单 · Exhibition List",
  "Exhibition Contact": "展会接触 · Exhibition Contact",
  "Info Inquiry": "Info 邮箱询盘 · Info Inquiry",
  Referral: "转介绍 · Referral",
  Manual: "手动录入 · Manual",
  Other: "其他 · Other",
};
const leadDecisionMakerFitLabels = leadPriorityLabels;
const leadStatusDetailLabels: Record<string, string> = {
  research_pending: "待研究 · Research Pending",
  first_outreach_due: "待首次开发 · First Outreach Due",
  waiting_reply: "已开发待回复 · Waiting Reply",
  following_up: "跟进中 · Following Up",
  replied_pending_conversion: "已回复 · 待转 Potential",
  paused: "暂停 · Paused",
  abandoned: "放弃 · Abandoned",
};

function leadDisplayLabel(value: unknown, labels: Record<string, string>, fallback = "未判断") {
  const raw = String(value || "");
  return labels[raw] || raw || fallback;
}

function leadFormPayload(form: HTMLFormElement): Row {
  const values = new FormData(form);
  return {
    companyName: values.get("companyName"),
    country: values.get("country"),
    city: values.get("city"),
    website: values.get("website"),
    linkedinCompany: values.get("linkedinCompany"),
    source: values.get("source"),
    companyType: values.get("companyType"),
    motoEvBusiness: values.get("motoEvBusiness"),
    existingBrands: values.get("existingBrands"),
    relevantProducts: values.get("relevantProducts"),
    targetModels: values.get("targetModels"),
    marketFit: values.get("marketFit"),
    priority: values.get("priority"),
    whyWorthDeveloping: values.get("whyWorthDeveloping"),
    riskDoubt: values.get("riskDoubt"),
    status: values.get("status"),
    nextFollowUpDate: values.get("nextFollowUpDate"),
    nextStep: values.get("nextStep"),
  };
}

function leadFormSignature(form: HTMLFormElement | null) {
  if (!form) return "";
  return JSON.stringify(leadFormPayload(form));
}

function leadStatusLabel(value: unknown) {
  return leadStatusLabels[String(value) as keyof typeof leadStatusLabels] || "待研究";
}

function LeadContactFields({ contact = {} }: { contact?: Row }) {
  return (
    <>
      <div className="form-grid">
        <label>姓名（Name）<input name="name" defaultValue={contact.name || ""} /></label>
        <label>职位（Title）<input name="title" defaultValue={contact.title || ""} /></label>
        <label>邮箱（Email）<input name="email" type="email" defaultValue={contact.email || ""} /></label>
        <label>电话（Phone）<input name="phone" defaultValue={contact.phone || ""} /></label>
        <label>WhatsApp<input name="whatsapp" defaultValue={contact.whatsapp || ""} /></label>
        <label>微信（WeChat）<input name="wechat" defaultValue={contact.wechat || ""} /></label>
        <label>LinkedIn<input name="linkedin" defaultValue={contact.linkedin || ""} /></label>
        <label>
          决策人匹配度（Decision Maker Fit）
          <select name="decisionMakerFit" defaultValue={contact.decision_maker_fit || ""}>
            <option value="">未判断</option>
            {LEAD_DECISION_MAKER_FITS.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadDecisionMakerFitLabels)}</option>)}
          </select>
        </label>
      </div>
      <label>备注（Note）<textarea name="note" rows={2} defaultValue={contact.note || ""} /></label>
      <label className="check-label"><input name="isPrimary" type="checkbox" defaultChecked={Boolean(contact.is_primary)} />主联系人（Primary）</label>
    </>
  );
}

function LeadDetail({
  snapshot,
  creating,
  onSaved,
  onClose,
}: {
  snapshot: LeadSnapshot | null;
  creating: boolean;
  onSaved: (snapshot: LeadSnapshot, created: boolean) => void;
  onClose: () => void;
}) {
  const lead = snapshot?.lead || {
    company_name: "", country: "", source: "Manual", moto_ev_business: "Unknown",
    priority: "Medium", status: "research_pending",
  };
  const [contacts, setContacts] = useState<Row[]>(snapshot?.contacts || []);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState("");
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [contactBusy, setContactBusy] = useState("");
  const editorRoot = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const initialSignatureRef = useRef("");

  useEffect(() => {
    initialSignatureRef.current = leadFormSignature(formRef.current);
    setIsDirty(false);
    setContacts(snapshot?.contacts || []);
  }, [snapshot, creating]);

  const refreshDirty = useCallback(() => {
    setIsDirty(leadFormSignature(formRef.current) !== initialSignatureRef.current);
  }, []);
  const closeGuard = useCustomerCloseGuard({
    isDirty: () => isDirty,
    isSaving: () => isSaving || Boolean(contactBusy),
    onClose,
    onSavingClose: () => setError("正在保存，请稍候。"),
  });

  async function request(action: string, payload: Row) {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, leadId: creating ? undefined : lead.id, ...payload }),
    });
    return readApiJson(response, "线索保存失败，请稍后重试。");
  }

  async function saveLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSaving(true);
    try {
      const result = await request(creating ? "create" : "update", leadFormPayload(event.currentTarget));
      const next = { lead: result.lead, contacts: Array.isArray(result.contacts) ? result.contacts : [] };
      initialSignatureRef.current = leadFormSignature(formRef.current);
      setIsDirty(false);
      onSaved(next, creating);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "线索保存失败，请稍后重试。");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveContact(event: FormEvent<HTMLFormElement>, contactId = "") {
    event.preventDefault();
    if (creating) return;
    const form = event.currentTarget;
    setContactBusy(contactId || "new");
    setError("");
    try {
      const values = new FormData(form);
      const result = await request("save_contact", {
        contactId,
        name: values.get("name"), title: values.get("title"), email: values.get("email"),
        phone: values.get("phone"), whatsapp: values.get("whatsapp"), wechat: values.get("wechat"),
        linkedin: values.get("linkedin"), note: values.get("note"),
        isPrimary: values.get("isPrimary") === "on", decisionMakerFit: values.get("decisionMakerFit"),
      });
      const next = { lead: result.lead, contacts: Array.isArray(result.contacts) ? result.contacts : [] };
      setContacts(next.contacts);
      setNewContactOpen(false);
      onSaved(next, false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "联系人保存失败，请稍后重试。");
    } finally {
      setContactBusy("");
    }
  }

  async function deleteContact(contactId: string) {
    if (creating) return;
    setContactBusy(contactId);
    setError("");
    try {
      const result = await request("delete_contact", { contactId });
      const next = { lead: result.lead, contacts: Array.isArray(result.contacts) ? result.contacts : [] };
      setContacts(next.contacts);
      onSaved(next, false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "联系人删除失败，请稍后重试。");
    } finally {
      setContactBusy("");
    }
  }

  const contactsSection = !creating ? (
    <section className="editor-section">
      <div className="editor-heading"><div><span>CONTACTS</span><h3>联系人（Contacts）</h3></div><small>独立于客户联系人</small></div>
      <div className="contact-editors">
        {contacts.map((contact) => (
          <details className="contact-editor" key={String(contact.id)}>
            <summary><span><strong>{contact.name || "未命名联系人"}</strong><small>{contact.title || "未填写职位"}{contact.decision_maker_fit ? ` · ${leadDisplayLabel(contact.decision_maker_fit, leadDecisionMakerFitLabels)}` : ""}</small></span></summary>
            <form onSubmit={(event) => void saveContact(event, String(contact.id))}><LeadContactFields contact={contact} /><div className="dialog-actions"><button className="danger-button" type="button" disabled={Boolean(contactBusy)} onClick={() => void deleteContact(String(contact.id))}>删除</button><button className="primary-button" type="submit" disabled={Boolean(contactBusy)}>{contactBusy === String(contact.id) ? "保存中…" : "保存联系人"}</button></div></form>
          </details>
        ))}
        <button className="add-contact-button" type="button" disabled={Boolean(contactBusy)} onClick={() => setNewContactOpen(true)}>+ 添加联系人</button>
        {newContactOpen ? <form className="contact-editor new" onSubmit={(event) => void saveContact(event)}><strong>添加联系人</strong><LeadContactFields /><div className="dialog-actions"><button type="button" disabled={Boolean(contactBusy)} onClick={() => setNewContactOpen(false)}>取消</button><button className="primary-button" type="submit" disabled={Boolean(contactBusy)}>{contactBusy === "new" ? "保存中…" : "保存"}</button></div></form> : null}
      </div>
    </section>
  ) : null;

  return (
    <Modal open title={creating ? "新增 Lead" : "Lead 详情"} onClose={closeGuard.requestClose} viewportFixed bodyRef={editorRoot}>
      <div className="lead-editor" ref={editorRoot}>
        <form ref={formRef} className="lead-editor-form" onSubmit={saveLead} onInput={refreshDirty} onChange={refreshDirty}>
          <div className="customer-editor-toolbar">
            <div>
              <strong>{creating ? "新增 Lead" : String(lead.company_name || "线索详情")}</strong>
              <small>{isDirty ? "有未保存的修改" : creating ? "填写基础资料后保存" : [lead.country, leadDisplayLabel(lead.company_type, leadCompanyTypeLabels), lead.website_domain || lead.website].filter((value) => value && value !== "未判断").join(" · ") || "所有修改已保存"}</small>
            </div>
            <div className="customer-editor-toolbar-actions">
              <button type="button" disabled={isSaving || Boolean(contactBusy)} onClick={closeGuard.requestClose}>关闭</button>
              <button className="primary-button" type="submit" disabled={isSaving || Boolean(contactBusy)}>{isSaving ? "保存中…" : "保存"}</button>
            </div>
          </div>
          {error ? <p className="inline-warning" role="alert">{error}</p> : null}
          <div className="lead-editor-columns">
            <div className="lead-editor-main">
              <section className="editor-section">
                <div className="editor-heading"><div><span>COMPANY SNAPSHOT</span><h3>公司概况（Company Snapshot）</h3></div></div>
                <div className="form-grid">
                  <label>公司名称（Company Name）<input name="companyName" required defaultValue={lead.company_name || ""} /></label>
                  <label>国家（Country）<input name="country" required defaultValue={lead.country || ""} /></label>
                  <label>城市（City）<input name="city" defaultValue={lead.city || ""} /></label>
                  <label>官网（Website）<input name="website" type="url" defaultValue={lead.website || ""} /></label>
                  <label>公司 LinkedIn（LinkedIn Company）<input name="linkedinCompany" defaultValue={lead.linkedin_company || ""} /></label>
                  <label>来源（Source）<select name="source" defaultValue={lead.source || "Manual"}>{LEAD_SOURCES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadSourceLabels)}</option>)}</select></label>
                  <label>公司类型（Company Type）<select name="companyType" defaultValue={lead.company_type || ""}><option value="">未判断</option>{LEAD_COMPANY_TYPES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadCompanyTypeLabels)}</option>)}</select></label>
                </div>
                <p className="form-note">来源（Source）不决定客户生命周期；是否发生真实互动才决定 Lead 或 Potential。</p>
              </section>
              <section className="editor-section">
                <div className="editor-heading"><div><span>QUALIFICATION</span><h3>客户匹配判断（Qualification）</h3></div></div>
                <div className="form-grid">
                  <label>摩托车 / EV 业务（Motorcycle / EV Business）<select name="motoEvBusiness" defaultValue={lead.moto_ev_business || "Unknown"}>{LEAD_MOTO_EV_BUSINESSES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadMotoEvBusinessLabels)}</option>)}</select></label>
                  <label>市场匹配度（Market Fit）<select name="marketFit" defaultValue={lead.market_fit || ""}><option value="">未判断</option>{LEAD_MARKET_FITS.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadMarketFitLabels)}</option>)}</select></label>
                  <label>优先级（Priority）<select name="priority" defaultValue={lead.priority || "Medium"}>{LEAD_PRIORITIES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadPriorityLabels)}</option>)}</select></label>
                </div>
                <label>现有品牌（Existing Brands）<textarea name="existingBrands" rows={2} defaultValue={lead.existing_brands || ""} /></label>
                <label>相关产品（Relevant Products）<textarea name="relevantProducts" rows={2} defaultValue={lead.relevant_products || ""} /></label>
                <label>目标车型（Target Models）<textarea name="targetModels" rows={2} defaultValue={lead.target_models || ""} /></label>
                <label>为什么值得开发（Why Worth Developing）<textarea name="whyWorthDeveloping" rows={4} defaultValue={lead.why_worth_developing || ""} /></label>
                <label>风险 / 疑点（Risk / Doubt）<textarea name="riskDoubt" rows={4} defaultValue={lead.risk_doubt || ""} /></label>
              </section>
            </div>
            <aside className="lead-editor-control">
              <section className="editor-section">
                <div className="editor-heading"><div><span>DEVELOPMENT CONTROL</span><h3>开发控制（Development Control）</h3></div></div>
                <label>状态（Status）<select name="status" defaultValue={lead.status || "research_pending"}>{EDITABLE_LEAD_STATUSES.map((value) => <option key={value} value={value}>{leadStatusDetailLabels[value] || leadStatusLabels[value]}</option>)}</select></label>
                <label>下次跟进（Next Follow-up）<DateInput name="nextFollowUpDate" defaultValue={String(lead.next_follow_up_date || "").slice(0, 10)} /></label>
                <label>下一步（Next Step）<textarea name="nextStep" rows={5} defaultValue={lead.next_step || ""} /></label>
              </section>
            </aside>
          </div>
        </form>
        {contactsSection}
      </div>
      <CustomerUnsavedChangesDialog open={closeGuard.closeConfirmOpen} editorRoot={editorRoot} onContinue={closeGuard.continueEditing} onDiscard={closeGuard.discardChanges} />
    </Modal>
  );
}

function BusinessDevelopmentView() {
  const [leads, setLeads] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [quickView, setQuickView] = useState("all");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [country, setCountry] = useState("all");
  const [source, setSource] = useState("all");
  const [motoEvBusiness, setMotoEvBusiness] = useState("all");
  const [targetModel, setTargetModel] = useState("");
  const [selected, setSelected] = useState<LeadSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const today = localDateText(new Date());

  const loadLeads = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await readApiJson(await fetch("/api/leads"), "线索池加载失败。");
      setLeads(Array.isArray(result.leads) ? result.leads : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "线索池加载失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadLeads(); }, [loadLeads]);

  const countries = useMemo(() => [...new Set(leads.map((lead) => String(lead.country || "")).filter(Boolean))].sort(), [leads]);
  const filtered = useMemo(() => sortLeads(leads.filter((lead) => {
    const haystack = [lead.company_name, lead.website, lead.website_domain, lead.primary_contact_name, lead.primary_contact_email].join(" ").toLowerCase();
    if (query && !haystack.includes(query.toLowerCase())) return false;
    if (status !== "all" && lead.status !== status) return false;
    if (priority !== "all" && lead.priority !== priority) return false;
    if (country !== "all" && lead.country !== country) return false;
    if (source !== "all" && lead.source !== source) return false;
    if (motoEvBusiness !== "all" && lead.moto_ev_business !== motoEvBusiness) return false;
    if (targetModel && !String(lead.target_models || "").toLowerCase().includes(targetModel.toLowerCase())) return false;
    const next = String(lead.next_follow_up_date || "").slice(0, 10);
    if (quickView === "due" && !(lead.status === "replied_pending_conversion" || (next && next <= today))) return false;
    if (quickView === "high" && lead.priority !== "High") return false;
    if (quickView === "first" && lead.status !== "first_outreach_due") return false;
    if (quickView === "replied" && lead.status !== "replied_pending_conversion") return false;
    return true;
  }), today), [leads, query, status, priority, country, source, motoEvBusiness, targetModel, quickView, today]);

  async function openLead(leadId: string) {
    try {
      const result = await readApiJson(await fetch(`/api/leads?id=${encodeURIComponent(leadId)}`), "线索打开失败。");
      setSelected({ lead: result.lead, contacts: Array.isArray(result.contacts) ? result.contacts : [] });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "线索打开失败。");
    }
  }

  function applySaved(snapshot: LeadSnapshot, created: boolean) {
    setLeads((current) => sortLeads([
      ...current.filter((lead) => String(lead.id) !== String(snapshot.lead.id)),
      snapshot.lead,
    ], today));
    setSelected(snapshot);
    if (created) setCreating(false);
  }

  return (
    <div className="view-stack">
      <SectionTitle eyebrow="新客开发" title="线索池（Lead Pool）" action={<button className="primary-button" type="button" onClick={() => setCreating(true)}>+ 新增 Lead</button>} />
      <div className="lead-quick-views" role="tablist" aria-label="Lead 快捷视图">
        {leadQuickViews.map(([id, label]) => <button key={id} type="button" className={quickView === id ? "active" : ""} onClick={() => setQuickView(id)}>{label}</button>)}
      </div>
      <section className="plain-panel lead-pool-panel">
        <div className="lead-pool-filters">
          <input aria-label="搜索 Lead" placeholder="搜索公司、网站、联系人或邮箱" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label="状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option>{EDITABLE_LEAD_STATUSES.map((value) => <option key={value} value={value}>{leadStatusLabel(value)}</option>)}</select>
          <select aria-label="优先级" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">全部优先级</option>{LEAD_PRIORITIES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadPriorityLabels)}</option>)}</select>
          <select aria-label="国家" value={country} onChange={(event) => setCountry(event.target.value)}><option value="all">全部国家</option>{countries.map((value) => <option key={value}>{value}</option>)}</select>
          <select aria-label="来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option>{LEAD_SOURCES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadSourceLabels)}</option>)}</select>
          <select aria-label="摩托车或 EV 业务" value={motoEvBusiness} onChange={(event) => setMotoEvBusiness(event.target.value)}><option value="all">全部摩托车 / EV 业务</option>{LEAD_MOTO_EV_BUSINESSES.map((value) => <option key={value} value={value}>{leadDisplayLabel(value, leadMotoEvBusinessLabels)}</option>)}</select>
          <input aria-label="目标车型" placeholder="筛选目标车型" value={targetModel} onChange={(event) => setTargetModel(event.target.value)} />
        </div>
        {error ? <p className="inline-warning" role="alert">{error}</p> : null}
        {loading ? <p className="muted-copy">正在加载线索池…</p> : (
          <div className="lead-pool-table">
            <div className="lead-pool-head"><span>优先级</span><span>公司</span><span>匹配度</span><span>联系人</span><span>状态</span><span>下一步</span><span>来源</span></div>
            {filtered.map((lead) => {
              const next = String(lead.next_follow_up_date || "").slice(0, 10);
              const overdue = Boolean(next && next < today);
              return <button className="lead-pool-row" type="button" key={String(lead.id)} onClick={() => void openLead(String(lead.id))}>
                <span className={`lead-priority ${String(lead.priority || "Medium").toLowerCase()}`}>{leadDisplayLabel(lead.priority, leadPriorityLabels, "中 · Medium")}</span>
                <span><strong>{lead.company_name}</strong><small>{[lead.country, lead.company_type ? leadDisplayLabel(lead.company_type, leadCompanyTypeLabels) : ""].filter(Boolean).join(" · ") || "—"}</small><small>{lead.website_domain || lead.website || "—"}</small></span>
                <span><strong>摩托车 / EV：{leadDisplayLabel(lead.moto_ev_business, leadMotoEvBusinessLabels, "未确认 · Unknown")}</strong><small>目标车型：{lead.target_models || "—"}</small>{lead.existing_brands ? <small>品牌：{lead.existing_brands}</small> : null}</span>
                <span>{lead.primary_contact_name ? <><strong>{lead.primary_contact_name}</strong><small>{lead.primary_contact_title || "—"}</small><small>{lead.primary_contact_email ? "Email ✓" : ""}{lead.primary_contact_email && lead.primary_contact_linkedin ? " · " : ""}{lead.primary_contact_linkedin ? "LinkedIn ✓" : ""}</small></> : <small>暂无联系人</small>}</span>
                <span><strong>{leadStatusLabel(lead.status)}</strong></span>
                <span><strong className={overdue ? "lead-overdue" : ""}>{next ? `${overdue ? "逾期 · " : ""}${formatDate(next)}` : "—"}</strong><small>{lead.next_step || "—"}</small></span>
                <span><small>{leadDisplayLabel(lead.source, leadSourceLabels, "手动录入 · Manual")}</small></span>
              </button>;
            })}
            {!filtered.length ? <p className="muted-copy">暂无匹配线索<br />可先新增一家公司开始开发。</p> : null}
          </div>
        )}
      </section>
      {creating ? <LeadDetail key="new" snapshot={null} creating onSaved={applySaved} onClose={() => setCreating(false)} /> : null}
      {selected ? <LeadDetail key={String(selected.lead.id)} snapshot={selected} creating={false} onSaved={applySaved} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

const paymentStatusOptions = [
  ["unpaid", "未付款"],
  ["deposit_received", "已收预付款"],
  ["balance_pending", "待尾款"],
  ["fully_paid", "已付清"],
] as const;

const productionStatusOptions = [
  ["not_scheduled", "待排产"],
  ["production_started", "生产中"],
  ["inspection", "待验货"],
  ["production_completed", "生产完成"],
] as const;

const shipmentStatusOptions = [
  ["not_arranged", "未安排"],
  ["arranged", "已安排"],
  ["ready_to_ship", "待发货"],
  ["in_transit", "运输中"],
  ["arrived", "已到达"],
  ["delivered", "已签收"],
] as const;

const legacyShipmentStatusLabels: Record<string, string> = {
  not_shipped: "未安排（旧状态）",
  booking_pending: "已安排",
  booked: "已安排",
  shipped: "运输中（旧状态）",
  completed: "已签收（旧状态）",
  abnormal: "异常（旧状态）",
};

const orderIssueLabels: Record<string, string> = {
  missing_customer_code: "缺少客户代码",
  customer_code_not_found: "客户代码未找到",
  duplicate_customer_code: "客户代码重复",
  missing_order_no: "缺少订单号",
  orphan_continuation_row: "订单续行前没有订单号",
  duplicate_existing_order: "系统中已有相同订单",
  duplicate_in_file: "文件内重复",
  invalid_amount: "金额无效",
  missing_exchange_rate: "非人民币订单缺少固定汇率",
  invalid_product_item: "车型、数量或单价无效",
  invalid_payment_record: "付款日期或金额无效",
  invalid_date: "日期格式无效",
  conflicting_order_field: "同一订单的订单级字段冲突",
  invalid_shipment_status: "运输状态无法映射",
  invalid_payment_status: "付款状态无法映射",
};

function orderStatusLabel(
  value: unknown,
  options: readonly (readonly [string, string])[],
) {
  return options.find(([key]) => key === value)?.[1] ||
    legacyShipmentStatusLabels[String(value || "")] || String(value || "未设置");
}

function isCompletedOrder(order: Row) {
  return isOrderCompleted(order);
}

function inCurrentMonth(value: unknown) {
  return isDateInMonth(value, new Date().toISOString().slice(0, 7));
}

function orderPaymentDetail(order: Row) {
  if (order.payment_status === "balance_pending" && Number(order.balance_amount || 0) > 0) {
    return `待收 ${formatCny(Number(order.balance_amount))}`;
  }
  if (order.payment_status === "deposit_received" && Number(order.original_amount || 0) > 0 && Number(order.deposit_amount || 0) > 0) {
    return `已收 ${Math.round(Number(order.deposit_amount) / Number(order.original_amount) * 100)}%`;
  }
  return order.balance_expected_date ? `预计 ${formatDate(order.balance_expected_date)}` : "手动状态";
}

function orderProductionDetail(order: Row) {
  if (order.production_notes) return String(order.production_notes);
  return getShippingDateState(order).label;
}

function orderShipmentDetail(order: Row) {
  if (order.shipping_method === "sea_freight" && order.bl_number) return `BL ${order.bl_number}`;
  if (order.shipping_method === "air_freight" && order.awb_number) return `AWB ${order.awb_number}`;
  if (order.shipping_method === "express" && order.tracking_number) return `${order.carrier_company || "快递"} · ${order.tracking_number}`;
  if (order.shipping_method === "domestic" && order.logistics_number) return `${order.logistics_company || "物流"} · ${order.logistics_number}`;
  return order.estimated_delivery_date ? `预计收货 ${formatDate(order.estimated_delivery_date)}` : "暂无补充";
}

function editableShipmentStatus(value: unknown) {
  return ({
    not_shipped: "not_arranged",
    booking_pending: "arranged",
    booked: "arranged",
    shipped: "in_transit",
    completed: "delivered",
  } as Record<string, string>)[String(value || "")] || String(value || "not_arranged");
}

function shippingMethodLabel(value: unknown) {
  return ({
    sea_freight: "海运",
    air_freight: "空运",
    express: "快递",
    domestic: "国内物流",
    pickup: "自提",
    other: "其他",
  } as Record<string, string>)[String(value || "")] || "未设置";
}

function completedOrderDeliveryLabel(order: Row) {
  const shipmentStatus = editableShipmentStatus(order.shipment_status);
  if (shipmentStatus === "delivered") return "已签收";
  if (shipmentStatus === "arrived") return "已到达";
  const deliveryDate = String(order.estimated_delivery_date || "").slice(0, 10);
  if (deliveryDate) return `预计收货 ${deliveryDate.slice(5)}`;
  if (shipmentStatus === "in_transit") return "运输中";
  return "—";
}

function completedOrderShippingLabel(order: Row) {
  const method = order.shipping_method
    ? shippingMethodLabel(order.shipping_method)
    : "";
  const status = order.shipment_status
    ? orderStatusLabel(
        editableShipmentStatus(order.shipment_status),
        shipmentStatusOptions,
      )
    : "";
  return [method, status].filter(Boolean).join(" · ") || "—";
}

function orderItemQuantityLabel(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity.toLocaleString() : String(value);
}

function OrdersView({
  data,
  onNavigate,
  onOrderSaved,
  onOrderArchived,
  onAccessorySalesSaved,
  onOrdersSnapshot,
  onOrderReorder,
  attentionTarget,
  onAttentionTargetConsumed,
}: {
  data: WorkspaceData;
  onNavigate: (view: View) => void;
  onOrderSaved: (result: Row) => void;
  onOrderArchived: (id: string) => void;
  onAccessorySalesSaved: (entry: Row) => void;
  onOrdersSnapshot: (snapshot: Row) => void;
  onOrderReorder: (ids: string[]) => Promise<boolean>;
  attentionTarget: AttentionTarget | null;
  onAttentionTargetConsumed: (target: AttentionTarget) => void;
}) {
  const [selectedOrder, setSelectedOrder] = useState<Row | null>(null);
  const [orderEditorOpen, setOrderEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"active" | "attention" | "shipping_month">("active");
  const [completedOrdersTab, setCompletedOrdersTab] = useState("delivery_month");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importRows, setImportRows] = useState<Row[]>([]);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importPreview, setImportPreview] = useState<Row | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [editorCustomerCode, setEditorCustomerCode] = useState("");
  const [editorItems, setEditorItems] = useState<Row[]>([]);
  const [editorPayments, setEditorPayments] = useState<Row[]>([]);
  const [addingPaymentType, setAddingPaymentType] = useState<"deposit" | "balance" | null>(null);
  const [paymentDraftDate, setPaymentDraftDate] = useState("");
  const [paymentDraftAmount, setPaymentDraftAmount] = useState("");
  const [editingPaymentId, setEditingPaymentId] = useState("");
  const [paymentEditDraft, setPaymentEditDraft] = useState<Row | null>(null);
  const [shippingMethod, setShippingMethod] = useState("");
  const [editorShipmentStatus, setEditorShipmentStatus] = useState("not_arranged");
  const [editorShippingDate, setEditorShippingDate] = useState("");
  const [requiresSalesImpactConfirmation, setRequiresSalesImpactConfirmation] =
    useState(true);
  const [completedOrderMenuId, setCompletedOrderMenuId] = useState("");
  const [accessoryYear, setAccessoryYear] = useState(String(new Date().getFullYear()));
  const [accessoryAmount, setAccessoryAmount] = useState("");
  const orderModalBodyRef = useRef<HTMLDivElement | null>(null);
  const openOrderManualIdsRef = useRef<string[]>([]);
  const openOrderDraggingIdRef = useRef("");
  const openOrderPointerIdRef = useRef<number | null>(null);
  const openOrderReorderingRef = useRef(false);
  const [openOrderManualIds, setOpenOrderManualIds] = useState<string[]>([]);
  const [openOrderDraggingId, setOpenOrderDraggingId] = useState("");
  const [openOrderReordering, setOpenOrderReordering] = useState(false);

  const orderItemsByOrderId = useMemo(() => {
    const grouped = new Map<string, Row[]>();
    for (const item of data.orderItems) {
      const orderId = String(item.order_id || "");
      if (!orderId) continue;
      const items = grouped.get(orderId);
      if (items) items.push(item);
      else grouped.set(orderId, [item]);
    }
    return grouped;
  }, [data.orderItems]);

  const orderPaymentsByOrderId = useMemo(() => {
    const grouped = new Map<string, Row[]>();
    for (const payment of data.orderPayments) {
      const orderId = String(payment.order_id || "");
      if (!orderId) continue;
      const payments = grouped.get(orderId);
      if (payments) payments.push(payment);
      else grouped.set(orderId, [payment]);
    }
    return grouped;
  }, [data.orderPayments]);

  const searchedOrders = data.orders.filter((order) => {
    const haystack = JSON.stringify(order).toLowerCase();
    return !query || haystack.includes(query.toLowerCase());
  });
  const activeRiskOrderIds = new Set(data.orderRisks.map((risk) => String(risk.order_id)));
  const activeOrders = sortActiveOrders(
    searchedOrders.filter((order) => !isCompletedOrder(order)),
    activeRiskOrderIds,
  ) as Row[];
  const completedOrders = sortCompletedOrders(searchedOrders.filter(isCompletedOrder)) as Row[];
  const attentionOrders = activeOrders.filter((order) => activeRiskOrderIds.has(String(order.id)));
  const shippingThisMonth = activeOrders.filter((order) =>
    isExpectedShippingInMonth(order, new Date().toISOString().slice(0, 7)),
  );
  const deliveryThisMonth = completedOrders
    .filter((order) => inCurrentMonth(order.estimated_delivery_date))
    .sort((a, b) => String(a.estimated_delivery_date).localeCompare(String(b.estimated_delivery_date)));
  const canReorderOpenOrders = activeFilter === "active" && !query.trim() && !busy && !openOrderReordering;
  const showOpenOrderDragHandles = activeFilter === "active" && !query.trim();
  const manuallyOrderedActiveOrders = useMemo(() => {
    if (!openOrderManualIds.length || openOrderManualIds.length !== activeOrders.length) return activeOrders;
    const byId = new Map(activeOrders.map((order) => [String(order.id), order]));
    if (openOrderManualIds.some((id) => !byId.has(id))) return activeOrders;
    return openOrderManualIds.map((id) => byId.get(id) as Row);
  }, [activeOrders, openOrderManualIds]);
  const visibleActiveOrders = activeFilter === "attention"
    ? attentionOrders
    : activeFilter === "shipping_month"
      ? shippingThisMonth
      : manuallyOrderedActiveOrders;
  const completedOrdersByYear = useMemo(() => {
    return groupAttributedOrdersByYear(completedOrders, getSalesBusinessDate());
  }, [completedOrders]);
  const selectedCompletedOrders = completedOrdersTab === "delivery_month"
    ? deliveryThisMonth
    : completedOrdersByYear.find(({ year }) => year === completedOrdersTab)?.orders ?? [];

  function clearOpenOrderDrag() {
    openOrderDraggingIdRef.current = "";
    openOrderPointerIdRef.current = null;
    setOpenOrderDraggingId("");
  }

  function resetOpenOrderManualOrder() {
    openOrderManualIdsRef.current = [];
    setOpenOrderManualIds([]);
  }

  function moveOpenOrder(orderId: string, overId: string, fallbackIds: string[]) {
    if (!canReorderOpenOrders || orderId === overId) return;
    const currentIds = openOrderManualIdsRef.current.length
      ? [...openOrderManualIdsRef.current]
      : [...fallbackIds];
    const from = currentIds.indexOf(orderId);
    const to = currentIds.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    currentIds.splice(from, 1);
    currentIds.splice(to, 0, orderId);
    openOrderManualIdsRef.current = currentIds;
    setOpenOrderManualIds(currentIds);
  }

  function beginOpenOrderDrag(orderId: string, fallbackIds: string[], pointerId: number) {
    if (!canReorderOpenOrders || openOrderReorderingRef.current) return;
    if (!openOrderManualIdsRef.current.length) {
      openOrderManualIdsRef.current = [...fallbackIds];
      setOpenOrderManualIds([...fallbackIds]);
    }
    openOrderPointerIdRef.current = pointerId;
    openOrderDraggingIdRef.current = orderId;
    setOpenOrderDraggingId(orderId);
  }

  async function finishOpenOrderDrag(fallbackIds: string[]) {
    const draggedId = openOrderDraggingIdRef.current;
    clearOpenOrderDrag();
    if (!draggedId) return;
    const ids = openOrderManualIdsRef.current.length
      ? [...openOrderManualIdsRef.current]
      : [...fallbackIds];
    if (ids.every((id, index) => id === fallbackIds[index])) {
      resetOpenOrderManualOrder();
      return;
    }
    openOrderReorderingRef.current = true;
    setOpenOrderReordering(true);
    let saved = false;
    try {
      saved = await onOrderReorder(ids);
    } finally {
      openOrderReorderingRef.current = false;
      setOpenOrderReordering(false);
      resetOpenOrderManualOrder();
    }
    if (!saved) setMessage("排序保存失败，请重试。");
  }

  function moveOpenOrderFromPointer(event: ReactPointerEvent<HTMLButtonElement>, fallbackIds: string[]) {
    if (openOrderPointerIdRef.current !== event.pointerId || !openOrderDraggingIdRef.current) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-open-order-id]");
    const overId = target?.dataset.openOrderId;
    if (overId) moveOpenOrder(openOrderDraggingIdRef.current, overId, fallbackIds);
  }

  function renderCompletedOrders(orders: Row[]) {
    return (
      <div className="customer-table completed-order-table">
        <div className="table-head"><span>订单 / 客户</span><span>整车明细</span><span>金额</span><span>交付</span><span>运输</span><span>操作</span></div>
        {orders.map((item) => {
          const vehicleItems = orderItemsByOrderId.get(String(item.id)) || [];
          return (
            <div
              className="table-row"
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => openOrder(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") openOrder(item);
              }}
            >
              <div className="completed-order-open"><strong className="order-primary-text">{item.order_no || item.pi_no || "订单"}</strong><small className="order-secondary-text">{item.customer_code || "未关联"} · {item.customer_name || "未填客户"}</small></div>
              <div className="completed-order-items" data-label="整车明细">
                {vehicleItems.length ? vehicleItems.map((orderItem) => (
                  <span className="completed-order-item order-primary-text" key={orderItem.id}>
                    {orderItem.description || "未命名车型"} × {orderItemQuantityLabel(orderItem.quantity)}
                  </span>
                )) : <strong className="order-primary-text">—</strong>}
              </div>
              <span className="completed-order-cell" data-label="金额"><strong className="order-primary-text">{item.original_currency || ""} {Number(item.original_amount || 0).toLocaleString()}</strong><small className="order-secondary-text">{item.currency_status === "confirmed" ? formatCny(item.cny_amount) : "金额待确认"}</small></span>
              <span className="completed-order-cell" data-label="交付"><strong className="order-primary-text">{completedOrderDeliveryLabel(item)}</strong></span>
              <span className="completed-order-cell" data-label="运输"><strong className="order-primary-text">{completedOrderShippingLabel(item)}</strong></span>
              <div
                className="project-more-menu completed-order-more"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <button
                  className="order-action"
                  type="button"
                  disabled={busy}
                  aria-expanded={completedOrderMenuId === String(item.id)}
                  onClick={() => setCompletedOrderMenuId((current) => current === String(item.id) ? "" : String(item.id))}
                >
                  更多
                </button>
                {completedOrderMenuId === String(item.id) ? (
                  <div role="menu">
                    <button type="button" role="menuitem" onClick={() => void changeOrderWorkflow(item, "reopen")}>恢复为未完成</button>
                    <button className="danger-button" type="button" role="menuitem" onClick={() => void archiveOrder(item)}>删除订单</button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function openOrder(order: Row | null) {
    setCompletedOrderMenuId("");
    setSelectedOrder(order);
    setMessage("");
    setEditorCustomerCode(String(order?.customer_code || ""));
    const savedItems = order
      ? orderItemsByOrderId.get(String(order.id)) || []
      : [];
    setEditorItems(
      savedItems.length
        ? savedItems.map((item) => ({
            id: item.id,
            model: item.description || "",
            quantity: item.quantity ?? "",
            unitPrice: item.unit_price ?? "",
          }))
        : order?.model
          ? [{
              model: order.model,
              quantity: order.quantity ?? "",
              unitPrice: "",
              legacy: true,
            }]
          : [{ model: "", quantity: "", unitPrice: "" }],
    );
    const savedPayments = order
      ? orderPaymentsByOrderId.get(String(order.id)) || []
      : [];
    setEditorPayments(normalizeOrderPayments(savedPayments) || []);
    setAddingPaymentType(null);
    setPaymentDraftDate("");
    setPaymentDraftAmount("");
    setEditingPaymentId("");
    setPaymentEditDraft(null);
    setShippingMethod(String(order?.shipping_method || ""));
    setEditorShipmentStatus(editableShipmentStatus(order?.shipment_status));
    setEditorShippingDate(String(order?.expected_shipping_date || "").slice(0, 10));
    setRequiresSalesImpactConfirmation(!order);
    setOrderEditorOpen(true);
  }

  useEffect(() => {
    if (!orderEditorOpen) return;
    window.requestAnimationFrame(() => {
      if (orderModalBodyRef.current) orderModalBodyRef.current.scrollTop = 0;
    });
  }, [orderEditorOpen, selectedOrder?.id]);

  async function reloadOrderModule() {
    const response = await fetch("/api/orders", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "订单模块刷新失败。");
    onOrdersSnapshot(result);
    return result;
  }

  useEffect(() => {
    if (attentionTarget?.type !== "order") return;
    const order = data.orders.find((item) => String(item.id) === attentionTarget.id);
    if (order) {
      openOrder(order);
      onAttentionTargetConsumed(attentionTarget);
    }
  }, [attentionTarget, data.orders, onAttentionTargetConsumed]);

  async function saveOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload: Row = {
      action: "save",
      id: selectedOrder?.id,
      confirmFinancialRisk: form.get("confirmFinancialRisk") === "on",
    };
    form.forEach((value, key) => {
      if (key !== "confirmFinancialRisk") payload[key] = value;
    });
    payload.customerCode = editorCustomerCode;
    payload.items = editorItems;
    payload.payments = editorPayments;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error || "订单保存失败。");
    } else {
      setOrderEditorOpen(false);
      onOrderSaved(result);
    }
    setBusy(false);
  }

  async function archiveOrder(order: Row | null = selectedOrder) {
    if (!order || !window.confirm("确认删除该订单吗？")) return;
    setCompletedOrderMenuId("");
    setBusy(true);
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive", id: order.id }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error || "订单删除失败。");
    else {
      setOrderEditorOpen(false);
      onOrderArchived(String(order.id));
    }
    setBusy(false);
  }

  function startPayment(type: "deposit" | "balance") {
    setAddingPaymentType(type);
    setPaymentDraftDate("");
    setPaymentDraftAmount("");
    setEditingPaymentId("");
    setPaymentEditDraft(null);
  }

  function applyPaymentMutation(result: Row) {
    const payments = normalizeOrderPayments(result.orderPayments);
    if (!payments) {
      setMessage("付款记录响应无效，已保留当前付款记录。请关闭订单后再次进入确认。");
      return false;
    }
    setEditorPayments(payments);
    onOrderSaved(result);
    return true;
  }

  async function confirmPayment() {
    const amount = Number(paymentDraftAmount);
    if (!addingPaymentType || !paymentDraftDate || !Number.isFinite(amount) || amount < 0) {
      setMessage("请填写有效的付款日期和金额。");
      return;
    }
    const draft = {
      id: `draft_payment_${crypto.randomUUID()}`,
      paymentType: addingPaymentType,
      paymentDate: paymentDraftDate,
      amount,
      sortOrder: editorPayments.length,
    };
    if (!selectedOrder) {
      setEditorPayments((payments) => [...payments, draft]);
      setAddingPaymentType(null);
      setPaymentDraftDate("");
      setPaymentDraftAmount("");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save_payment", orderId: selectedOrder.id, ...draft }),
      });
      const result = await readApiJson(response, "付款记录保存失败。");
      if (!applyPaymentMutation(result)) return;
      setAddingPaymentType(null);
      setPaymentDraftDate("");
      setPaymentDraftAmount("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "付款记录保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function removePayment(id: string) {
    if (!window.confirm("确认删除这笔付款记录吗？")) return;
    if (selectedOrder) {
      setBusy(true);
      try {
        const response = await fetch("/api/orders", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "delete_payment", orderId: selectedOrder.id, paymentId: id }),
        });
        const result = await readApiJson(response, "付款记录删除失败。");
        if (!applyPaymentMutation(result)) return;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "付款记录删除失败。");
        return;
      } finally {
        setBusy(false);
      }
    } else {
      setEditorPayments((payments) => payments.filter((payment) => payment.id !== id));
    }
    setEditingPaymentId("");
    setPaymentEditDraft(null);
  }

  async function confirmPaymentEdit() {
    if (!paymentEditDraft?.id) return;
    const amount = Number(paymentEditDraft.amount);
    if (!paymentEditDraft.paymentDate || !Number.isFinite(amount) || amount < 0) {
      setMessage("请填写有效的付款日期和金额。");
      return;
    }
    const updatedPayment = { ...paymentEditDraft, amount };
    if (!selectedOrder) {
      setEditorPayments((payments) => payments.map((payment) =>
        payment.id === paymentEditDraft.id ? updatedPayment : payment,
      ));
      setEditingPaymentId("");
      setPaymentEditDraft(null);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/orders", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save_payment", orderId: selectedOrder.id, paymentId: updatedPayment.id, ...updatedPayment }),
      });
      const result = await readApiJson(response, "付款记录保存失败。");
      if (!applyPaymentMutation(result)) return;
      setEditingPaymentId("");
      setPaymentEditDraft(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "付款记录保存失败。");
    } finally {
      setBusy(false);
    }
  }

  function updateSalesImpactConfirmation(event: FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    setRequiresSalesImpactConfirmation(
      requiresOrderSalesImpactConfirmation(selectedOrder, {
        orderDate: form.get("orderDate"),
        originalCurrency: form.get("originalCurrency"),
        originalAmount: form.get("originalAmount"),
        fixedExchangeRateToCny: form.get("fixedExchangeRateToCny"),
      }),
    );
  }

  async function changeOrderWorkflow(order: Row, action: "complete" | "reopen") {
    if (action === "complete" && !window.confirm("确认该订单已完成并进入历史订单？")) return;
    if (
      action === "reopen" &&
      !window.confirm("确认将该订单恢复为未完成状态？恢复后，该订单将重新进入未完成订单列表。")
    ) return;
    setCompletedOrderMenuId("");
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id: order.id }),
      });
      const result = await readApiJson(
        response,
        action === "complete" ? "订单完成失败。" : "订单恢复为未完成失败。",
      );
      onOrderSaved(result);
      setSelectedOrder(result.order);
      setOrderEditorOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单状态更新失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveAccessorySales() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save_accessory_sales",
        salesYear: accessoryYear,
        amountCny: accessoryAmount,
      }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error || "配件销售金额保存失败。");
    else {
      onAccessorySalesSaved(result.accessorySales);
      setMessage("配件销售金额已保存。");
    }
    setBusy(false);
  }

  function mappedRows() {
    return importRows.map((row, index) => {
      const mapped: Row = { rowNumber: row.__rowNumber || index + 2 };
      for (const field of orderImportFields) {
        const header = importMapping[field.key];
        mapped[field.key] = header ? row[header] : "";
      }
      return mapped;
    });
  }

  async function previewImport(
    rowsToPreview = importRows,
    mappingToUse = importMapping,
  ) {
    const normalized = rowsToPreview.map((row, index) => {
      const mapped: Row = { rowNumber: row.__rowNumber || index + 2 };
      for (const field of orderImportFields) {
        const header = mappingToUse[field.key];
        mapped[field.key] = header ? row[header] : "";
      }
      return mapped;
    });
    if (!normalized.length) return;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/orders/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "preview", rows: normalized }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error || "导入预览失败。");
    else setImportPreview(result);
    setBusy(false);
  }

  async function readOrderFile(file: File) {
    setBusy(true);
    setMessage("");
    setImportPreview(null);
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error("文件超过 10 MB，请拆分后再导入。");
      }
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: "array",
        cellDates: true,
      });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("文件中没有工作表。");
      const matrix = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
        raw: false,
        dateNF: "yyyy-mm-dd",
      });
      const { index: headerRowIndex, headers, mapping } = findOrderImportHeaderRow(matrix);
      const parsedRows = matrix
        .slice(headerRowIndex + 1)
        .filter((row) => row.some((value) => String(value).trim()))
        .slice(0, 500)
        .map((row, index) => ({
          __rowNumber: headerRowIndex + index + 2,
          ...Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""])),
        }));
      if (!parsedRows.length) throw new Error("文件中没有订单数据。");
      setImportFileName(file.name);
      setImportHeaders(headers);
      setImportRows(parsedRows);
      setImportMapping(mapping);
      await previewImport(parsedRows, mapping);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "文件读取失败。");
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    const normalized = mappedRows();
    if (!normalized.length) return;
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/orders/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", rows: normalized }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error || "导入失败。");
    else {
      setMessage(`已导入 ${result.imported} 笔；${result.skipped} 笔保留在待确认清单。`);
      await reloadOrderModule();
      await previewImport();
    }
    setBusy(false);
  }

  const order = selectedOrder || {};
  const linkedCustomer = data.customers.find(
    (customer) =>
      String(customer.customer_code || "").trim().toUpperCase() ===
      editorCustomerCode.trim().toUpperCase(),
  );
  const linkedContacts = linkedCustomer
    ? data.contacts.filter((contact) => contact.customer_id === linkedCustomer.id)
    : [];
  const selectedRisks = selectedOrder
    ? data.orderRisks.filter((risk) => risk.order_id === selectedOrder.id)
    : [];
  const selectedHistory = selectedOrder
    ? data.orderStatusHistory.filter((entry) => entry.order_id === selectedOrder.id)
    : [];
  const paymentRecordsByType = (type: "deposit" | "balance") =>
    editorPayments.filter((payment) => payment.paymentType === type);

  useEffect(() => {
    const saved = data.accessorySales.find(
      (entry) => String(entry.sales_year) === accessoryYear,
    );
    setAccessoryAmount(saved ? String(saved.amount_cny ?? "") : "");
  }, [accessoryYear, data.accessorySales]);

  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="ORDER CONTROL CENTER"
        title="订单"
        detail="付款、生产、运输分别管理；所有销售统计只使用已确认的 CNY 金额。"
        action={
          <div className="button-group">
            <button type="button" onClick={() => setImportOpen(true)}>
              导入 Excel / CSV
            </button>
            <button className="primary-button" type="button" onClick={() => openOrder(null)}>
              新增订单
            </button>
          </div>
        }
      />
      <section className="plain-panel accessory-sales-panel">
        <div className="panel-heading">
          <div><span>ACCESSORY SALES</span><h2>配件销售金额</h2></div>
          <small>仅计入销售统计，不创建订单或运输提醒</small>
        </div>
        <div className="accessory-sales-editor">
          <label>年份<input type="number" min="2000" max="2200" value={accessoryYear} onChange={(event) => setAccessoryYear(event.target.value)} /></label>
          <label>配件销售金额（CNY）<input type="number" min="0" step="0.01" value={accessoryAmount} onChange={(event) => setAccessoryAmount(event.target.value)} /></label>
          <button type="button" disabled={busy} onClick={saveAccessorySales}>保存金额</button>
        </div>
        <div className="accessory-sales-summary">
          <span>整车订单 {formatCny(data.metrics.currentYearVehicleSales)}</span>
          <span>配件销售 {formatCny(data.metrics.currentYearAccessorySales)}</span>
          <strong>年度合计 {formatCny(data.metrics.currentYearSales)}</strong>
        </div>
      </section>
      {data.metrics.currencyReviewCount ? (
        <div className="review-banner">
          <strong>{data.metrics.currencyReviewCount} 笔订单需要确认币种或固定汇率</strong>
          <p>在确认前，原始金额保留，但不会进入销售 KPI。</p>
        </div>
      ) : null}
      <div className="list-toolbar order-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索订单号、PI、客户代码、车型或运输单号"
        />
        <small>{searchedOrders.length} 笔订单</small>
      </div>
      <section className="order-workflow-section">
        <div className="panel-heading">
          <div><span>ACTIVE ORDERS</span><h2>未完成订单</h2></div>
        </div>
        <div className="order-filter-bar" aria-label="未完成订单筛选">
          {([
            ["active", "未完成订单", activeOrders.length],
            ["attention", "需关注", attentionOrders.length],
            ["shipping_month", "本月预计发货", shippingThisMonth.length],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" className={activeFilter === value ? "active" : ""} onClick={() => setActiveFilter(value)}>
              <span>{label}</span><strong>{count}</strong>
            </button>
          ))}
        </div>
        <div className="active-order-list">
          {visibleActiveOrders.map((item) => {
            const risks = data.orderRisks.filter((risk) => String(risk.order_id) === String(item.id));
            const shippingDateState = getShippingDateState(item);
            const fallbackIds = activeOrders.map((order) => String(order.id));
            return (
              <article
                className={`active-order-card ${openOrderDraggingId === String(item.id) ? "is-dragging" : ""}`}
                data-open-order-id={item.id}
                key={item.id}
                aria-busy={openOrderReordering || undefined}
              >
                {showOpenOrderDragHandles ? (
                  <button
                    className="open-order-drag-handle"
                    type="button"
                    disabled={!canReorderOpenOrders}
                    aria-label={`拖动调整 ${item.order_no || item.pi_no || "订单"} 的位置`}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => {
                      if (!canReorderOpenOrders) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      beginOpenOrderDrag(String(item.id), fallbackIds, event.pointerId);
                    }}
                    onPointerMove={(event) => moveOpenOrderFromPointer(event, fallbackIds)}
                    onPointerUp={(event) => {
                      if (openOrderPointerIdRef.current !== event.pointerId) return;
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      void finishOpenOrderDrag(fallbackIds);
                    }}
                    onPointerCancel={(event) => {
                      if (openOrderPointerIdRef.current !== event.pointerId) return;
                      clearOpenOrderDrag();
                      resetOpenOrderManualOrder();
                    }}
                  >
                    ⠿
                  </button>
                ) : null}
                <button type="button" className="active-order-main" onClick={() => openOrder(item)}>
                  <div className="active-order-header">
                    <span><strong className="order-primary-text">{item.order_no || "待补订单号"}</strong><small className="order-secondary-text">{item.pi_no ? `PI ${item.pi_no}` : "PI 待补"}</small></span>
                    <span><strong className="order-primary-text">{item.customer_code || "未关联"} · {item.customer_name || "未填客户"}</strong><small className="order-secondary-text">{item.model || "未填车型"}{item.quantity ? ` · ${item.quantity} 台` : ""}</small></span>
                    <span><strong className="order-primary-text">{item.original_currency || "币种待确认"} {Number(item.original_amount || 0).toLocaleString()}</strong><small className="order-secondary-text">{item.currency_status === "confirmed" ? formatCny(item.cny_amount) : "暂不计入统计"}</small></span>
                    <span><strong className="order-primary-text">{shippingDateState.label}</strong><small className="order-secondary-text">发货日期</small></span>
                  </div>
                  <div className="order-status-columns">
                    <span><small className="order-label">付款</small><strong className="order-primary-text">{orderStatusLabel(item.payment_status, paymentStatusOptions)}</strong><em className="order-secondary-text">{orderPaymentDetail(item)}</em></span>
                    <span><small className="order-label">生产</small><strong className="order-primary-text">{orderStatusLabel(item.production_status, productionStatusOptions)}</strong><em className="order-secondary-text">{orderProductionDetail(item)}</em></span>
                    <span><small className="order-label">运输</small><strong className="order-primary-text">{orderStatusLabel(item.shipment_status, shipmentStatusOptions)}</strong><em className="order-secondary-text">{orderShipmentDetail(item)}</em></span>
                  </div>
                  {item.progress_next_step ? <p className="order-next-step"><span>当前进展 / 下一步</span>{item.progress_next_step}</p> : null}
                  {risks.length ? (
                    <div className="order-card-risks">
                      {risks.slice(0, 3).map((risk) => <span key={risk.id} className={String(risk.risk_level).toLowerCase()}>{risk.title}</span>)}
                    </div>
                  ) : null}
                </button>
                <button className="order-action order-complete-button" type="button" disabled={busy} onClick={() => changeOrderWorkflow(item, "complete")}>标记为已完成</button>
              </article>
            );
          })}
          {!visibleActiveOrders.length ? (
            <EmptyState title="当前筛选没有订单" detail="可以切换筛选，或新增整车订单。" />
          ) : null}
        </div>
        {openOrderReordering ? <p className="open-order-sort-status" role="status">正在保存排序…</p> : null}
      </section>

      <section className="order-workflow-section completed-orders-section">
        <div className="panel-heading">
          <div><span>ORDER HISTORY</span><h2>已完成订单</h2></div>
        </div>
        <div className="completed-orders-tabs" role="tablist" aria-label="已完成订单筛选">
          <button
            type="button"
            role="tab"
            aria-selected={completedOrdersTab === "delivery_month"}
            className={completedOrdersTab === "delivery_month" ? "active" : ""}
            onClick={() => setCompletedOrdersTab("delivery_month")}
          >
            <strong>本月预计客户收货</strong><small>{deliveryThisMonth.length} 单</small>
          </button>
          {completedOrdersByYear.map(({ year, orders, totalCnyAmount }) => (
            <button
              type="button"
              role="tab"
              key={year}
              aria-selected={completedOrdersTab === year}
              className={completedOrdersTab === year ? "active" : ""}
              onClick={() => setCompletedOrdersTab(year)}
            >
              <strong>{year}</strong><small>{orders.length} 单 · {formatCny(totalCnyAmount)}</small>
            </button>
          ))}
        </div>
        <section className="completed-orders-tab-panel" role="tabpanel">
          {selectedCompletedOrders.length
            ? renderCompletedOrders(selectedCompletedOrders)
            : <p className="form-note">本月没有预计客户收货的已完成订单。</p>}
        </section>
        {!completedOrders.length ? (
          <EmptyState
            title="还没有已完成订单"
            detail="手动标记完成后，订单会进入这里并保留全部历史数据。"
          />
        ) : null}
      </section>

      <Modal
        open={orderEditorOpen}
        title={selectedOrder ? "编辑订单" : "新增订单"}
        onClose={() => {
          setCompletedOrderMenuId("");
          setOrderEditorOpen(false);
        }}
        viewportFixed
        bodyRef={orderModalBodyRef}
        dismissOnBackdrop={false}
      >
        <form
          className="form-stack order-editor"
          key={selectedOrder?.id || "new-order"}
          onSubmit={saveOrder}
          onChange={updateSalesImpactConfirmation}
        >
          <section className="editor-section">
            <div className="editor-heading"><div><span>BASIC</span><h3>基本信息</h3></div></div>
            <div className="form-grid order-form-grid">
              <label>订单号<input name="orderNo" defaultValue={order.order_no || ""} /></label>
              <label>PI No.<input name="piNo" defaultValue={order.pi_no || ""} /></label>
              <label>订单日期<DateInput name="orderDate" defaultValue={String(order.order_date || "").slice(0, 10)} /></label>
              <label>
                客户代码
                <input
                  list="order-customer-codes"
                  value={editorCustomerCode}
                  onChange={(event) => setEditorCustomerCode(event.target.value)}
                  required
                />
                <datalist id="order-customer-codes">
                  {data.customers.map((customer) => (
                    <option key={customer.id} value={customer.customer_code || ""}>
                      {customer.company}
                    </option>
                  ))}
                </datalist>
              </label>
              <label>客户名称（自动匹配）<input value={linkedCustomer?.company || ""} readOnly /></label>
              <label>国家（自动匹配）<input value={linkedCustomer?.country || order.country || ""} readOnly /></label>
            </div>
            {linkedCustomer ? (
              <div className="order-customer-match">
                <strong>{linkedCustomer.company}</strong>
                <span>{linkedCustomer.customer_code} · {linkedCustomer.country || "国家未填写"}</span>
                <div>
                  {linkedContacts.length
                    ? linkedContacts.map((contact) => (
                        <small key={contact.id}>
                          {contact.name || "未命名联系人"}
                          {contact.position ? ` · ${contact.position}` : ""}
                          {contact.email ? ` · ${contact.email}` : ""}
                          {contact.phone ? ` · ${contact.phone}` : ""}
                        </small>
                      ))
                    : <small>该客户还没有联系人。</small>}
                </div>
              </div>
            ) : editorCustomerCode ? (
              <p className="inline-warning">未找到唯一匹配的客户代码，订单不会保存到错误客户。</p>
            ) : null}
          </section>

          <section className="editor-section">
            <div className="editor-heading">
              <div><span>PRODUCT ITEMS</span><h3>整车明细</h3></div>
              <button
                type="button"
                onClick={() => setEditorItems((items) => [...items, { model: "", quantity: "", unitPrice: "" }])}
              >
                + 增加车型
              </button>
            </div>
            <p className="form-note">仅填写整车车型。配件、充电器、备件和零部件不放在这里；产品明细不会反算或覆盖订单总金额。</p>
            <div className="order-item-list">
              <table className="order-item-table">
                <colgroup>
                  <col className="order-item-model-column" />
                  <col className="order-item-quantity-column" />
                  <col className="order-item-price-column" />
                  <col className="order-item-action-column" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">整车车型</th>
                    <th scope="col">数量</th>
                    <th scope="col">单价</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {editorItems.map((item, index) => (
                    <tr key={item.id || index}>
                      <td><input aria-label={`第 ${index + 1} 行整车车型`} value={item.model || ""} onChange={(event) => setEditorItems((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, model: event.target.value } : entry))} /></td>
                      <td><input aria-label={`第 ${index + 1} 行数量`} type="number" min="0" step="1" value={item.quantity ?? ""} onChange={(event) => setEditorItems((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, quantity: event.target.value } : entry))} /></td>
                      <td><input aria-label={`第 ${index + 1} 行单价`} type="number" min="0" step="0.01" value={item.unitPrice ?? ""} onChange={(event) => setEditorItems((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, unitPrice: event.target.value } : entry))} /></td>
                      <td><button className="danger-button" type="button" aria-label={`删除第 ${index + 1} 行车型`} onClick={() => setEditorItems((items) => items.length === 1 ? [{ model: "", quantity: "", unitPrice: "" }] : items.filter((_, itemIndex) => itemIndex !== index))}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>FINANCIAL</span><h3>金额与付款</h3></div><small>首页销售额仍以确认后的 CNY 为准</small></div>
            <div className="form-grid order-form-grid">
              <label>
                原始币种
                <select name="originalCurrency" defaultValue={order.original_currency || "USD"}>
                  {["USD", "EUR", "CNY", "RMB", "GBP"].map((currency) => <option key={currency}>{currency}</option>)}
                </select>
              </label>
              <label>订单总金额<input name="originalAmount" type="number" step="0.01" min="0" defaultValue={order.original_amount ?? ""} /></label>
              <label>固定汇率 → CNY<input name="fixedExchangeRateToCny" type="number" step="0.0001" min="0" defaultValue={order.fixed_exchange_rate_to_cny ?? ""} /></label>
              <label>CNY 金额<input value={order.currency_status === "confirmed" ? Number(order.cny_amount || 0).toFixed(2) : "保存后自动计算"} readOnly /></label>
              <label>其他费用<input name="otherCosts" type="number" step="0.01" min="0" defaultValue={order.other_costs ?? ""} /></label>
              <label>
                付款状态
                <select name="paymentStatus" defaultValue={order.payment_status || "unpaid"}>
                  {order.payment_status &&
                  !paymentStatusOptions.some(([value]) => value === order.payment_status) ? (
                    <option value={order.payment_status}>原状态：{order.payment_status}</option>
                  ) : null}
                  {paymentStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>
                货款收清日期
                <DateInput name="balanceReceivedDate" defaultValue={String(order.balance_received_date || "").slice(0, 10)} />
                <small>订单全部货款实际收齐的日期</small>
              </label>
            </div>
            {(["deposit", "balance"] as const).map((type) => {
              const isDeposit = type === "deposit";
              const records = paymentRecordsByType(type);
              const title = isDeposit ? "预付款" : "尾款";
              return (
                <div className="order-payment-group" key={type}>
                  <div className="order-payment-group-heading">
                    <strong>{title}</strong>
                    {!addingPaymentType && (
                      <button type="button" onClick={() => startPayment(type)}>+ 新增{title}</button>
                    )}
                  </div>
                  {records.length ? (
                    <div className="order-payment-records">
                      {records.map((payment) => editingPaymentId === payment.id ? (
                        <div className="order-payment-edit" key={payment.id}>
                          <DateInput value={String(paymentEditDraft?.paymentDate || "")} onChange={(event) => setPaymentEditDraft((current) => current ? { ...current, paymentDate: event.target.value } : current)} />
                          <input type="number" min="0" step="0.01" value={paymentEditDraft?.amount ?? ""} onChange={(event) => setPaymentEditDraft((current) => current ? { ...current, amount: event.target.value } : current)} />
                          <button type="button" onClick={confirmPaymentEdit}>确认</button>
                          <button type="button" onClick={() => { setEditingPaymentId(""); setPaymentEditDraft(null); }}>取消</button>
                        </div>
                      ) : (
                        <div className="order-payment-record" key={payment.id}>
                          <span>{formatDate(payment.paymentDate)}</span>
                          <span>{order.original_currency || "USD"} {Number(payment.amount || 0).toLocaleString()}</span>
                          <button type="button" onClick={() => { setEditingPaymentId(String(payment.id)); setPaymentEditDraft({ ...payment }); }}>编辑</button>
                          <button type="button" className="danger-button" onClick={() => removePayment(String(payment.id))}>删除</button>
                        </div>
                      ))}
                    </div>
                  ) : <small className="form-note">暂无记录</small>}
                  {addingPaymentType === type ? (
                    <div className="order-payment-edit order-payment-new">
                      <label>{title}日期<DateInput value={paymentDraftDate} onChange={(event) => setPaymentDraftDate(event.target.value)} /></label>
                      <label>{title}金额<input type="number" min="0" step="0.01" value={paymentDraftAmount} onChange={(event) => setPaymentDraftAmount(event.target.value)} /></label>
                      <button type="button" onClick={confirmPayment}>确认</button>
                      <button type="button" onClick={() => setAddingPaymentType(null)}>取消</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>PRODUCTION</span><h3>生产</h3></div></div>
            <div className="form-grid order-form-grid">
              <label>
                生产状态
                <select name="productionStatus" defaultValue={order.production_status || "not_scheduled"}>
                  {order.production_status &&
                  !productionStatusOptions.some(([value]) => value === order.production_status) ? (
                    <option value={order.production_status}>原状态：{order.production_status}</option>
                  ) : null}
                  {productionStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>生产备注<textarea name="productionNotes" rows={3} defaultValue={order.production_notes || ""} placeholder="排产、验货、异常和下一步…" /></label>
            </div>
            {selectedHistory.filter((entry) => entry.field_name === "production_status").length ? (
              <div className="order-timeline">
                {selectedHistory.filter((entry) => entry.field_name === "production_status").slice(0, 6).map((entry) => (
                  <small key={entry.id}>{formatDate(entry.created_at)} · {orderStatusLabel(entry.from_value, productionStatusOptions)} → {orderStatusLabel(entry.to_value, productionStatusOptions)}</small>
                ))}
              </div>
            ) : null}
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>SHIPMENT</span><h3>运输</h3></div></div>
            <div className="form-grid order-form-grid">
              <label>
                运输方式
                <select name="shippingMethod" value={shippingMethod} onChange={(event) => setShippingMethod(event.target.value)}>
                  <option value="">未设置</option>
                  <option value="sea_freight">Sea Freight 海运</option>
                  <option value="air_freight">Air Freight 空运</option>
                  <option value="express">Express 快递</option>
                  <option value="domestic">Domestic 国内物流</option>
                  <option value="pickup">Pickup 自提</option>
                  <option value="other">Other 其他</option>
                </select>
              </label>
              <label>
                运输状态
                <select name="shipmentStatus" value={editorShipmentStatus} onChange={(event) => setEditorShipmentStatus(event.target.value)}>
                  {editableShipmentStatus(order.shipment_status) &&
                  !shipmentStatusOptions.some(([value]) => value === editableShipmentStatus(order.shipment_status)) ? (
                    <option value={editableShipmentStatus(order.shipment_status)}>原状态：{order.shipment_status}</option>
                  ) : null}
                  {shipmentStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label>
                发货日期
                <DateInput name="expectedShippingDate" value={editorShippingDate} onChange={(event) => setEditorShippingDate(event.target.value)} />
                <small>{getShippingDateState({ expected_shipping_date: editorShippingDate, shipment_status: editorShipmentStatus }).label}</small>
              </label>
              <label>预计客户收货日期<DateInput name="estimatedDeliveryDate" defaultValue={String(order.estimated_delivery_date || "").slice(0, 10)} /></label>
              {shippingMethod === "sea_freight" ? (
                <>
                  <label>船公司<input name="shippingCompany" defaultValue={order.shipping_company || ""} /></label>
                  <label className="shipment-vessel-voyage">
                    船名航次
                    <span>
                      <input name="vessel" aria-label="船名" placeholder="船名" defaultValue={order.vessel || ""} />
                      <input name="voyage" aria-label="航次" placeholder="航次" defaultValue={order.voyage || ""} />
                    </span>
                  </label>
                  <label>BL No.<input name="blNumber" defaultValue={order.bl_number || ""} /></label>
                </>
              ) : null}
              {shippingMethod === "air_freight" ? <label>AWB<input name="awbNumber" defaultValue={order.awb_number || ""} /></label> : null}
              {shippingMethod === "express" ? (
                <>
                  <label>快递公司<input name="carrierCompany" defaultValue={order.carrier_company || ""} /></label>
                  <label>Tracking No.<input name="trackingNumber" defaultValue={order.tracking_number || ""} /></label>
                </>
              ) : null}
              {shippingMethod === "domestic" ? (
                <>
                  <label>物流公司<input name="logisticsCompany" defaultValue={order.logistics_company || ""} /></label>
                  <label>物流单号<input name="logisticsNumber" defaultValue={order.logistics_number || ""} /></label>
                </>
              ) : null}
            </div>
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>AI RISK ALERT</span><h3>证据化风险</h3></div><small>High / Medium / Low</small></div>
            <div className="order-risk-list">
              {selectedRisks.map((risk) => (
                <article key={risk.id} className={`order-risk ${String(risk.risk_level).toLowerCase()}`}>
                  <span>{risk.risk_level}</span>
                  <div><strong>{risk.title}</strong><p>{risk.reason}</p><small>建议：{risk.recommended_action || "核实并记录下一步"}</small><small>证据：{risk.evidence_source}</small></div>
                </article>
              ))}
              {!selectedRisks.length ? <small>当前没有基于已记录证据生成的风险提醒。</small> : null}
            </div>
            <label>人工风险备注<textarea name="risk" rows={3} defaultValue={order.risk || ""} placeholder="只记录已知事实，不写推测。" /></label>
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>NEXT ACTION</span><h3>当前进展 / 下一步</h3></div></div>
            <label><textarea name="progressNextStep" rows={3} defaultValue={order.progress_next_step || ""} placeholder="例如：等客户支付尾款，收到后安排装柜。" /></label>
          </section>

          <section className="editor-section">
            <div className="editor-heading"><div><span>NOTES</span><h3>备注</h3></div></div>
            <label>订单备注<textarea name="notes" rows={5} defaultValue={order.notes || ""} /></label>
          </section>

          {requiresSalesImpactConfirmation ? (
            <label className="risk-confirm">
              <input name="confirmFinancialRisk" type="checkbox" required />
              <span>我确认本次保存可能影响 CNY 销售统计；非人民币订单使用该订单自己的固定汇率。</span>
            </label>
          ) : null}
          {message ? <p className="inline-warning">{message}</p> : null}
          <div className="dialog-actions">
            {selectedOrder && !isCompletedOrder(selectedOrder) ? (
              <button className="danger-button" type="button" disabled={busy} onClick={() => void archiveOrder()}>删除订单</button>
            ) : null}
            {selectedOrder && !isCompletedOrder(selectedOrder) ? (
              <button className="order-action" type="button" disabled={busy} onClick={() => changeOrderWorkflow(selectedOrder, "complete")}>标记为已完成</button>
            ) : null}
            {selectedOrder && isCompletedOrder(selectedOrder) ? (
              <div className="project-more-menu completed-order-more modal-order-more">
                <button
                  className="order-action"
                  type="button"
                  disabled={busy}
                  aria-expanded={completedOrderMenuId === "modal"}
                  onClick={() => setCompletedOrderMenuId((current) => current === "modal" ? "" : "modal")}
                >
                  更多
                </button>
                {completedOrderMenuId === "modal" ? (
                  <div role="menu">
                    <button type="button" role="menuitem" onClick={() => void changeOrderWorkflow(selectedOrder, "reopen")}>恢复为未完成</button>
                    <button className="danger-button" type="button" role="menuitem" onClick={() => void archiveOrder(selectedOrder)}>删除订单</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "保存中…" : "保存订单"}</button>
          </div>
        </form>
      </Modal>

      <Modal open={importOpen} title="导入订单" onClose={() => setImportOpen(false)}>
        <div className="order-import">
          <label className="file-drop">
            <input
              type="file"
              accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) readOrderFile(file);
              }}
            />
            <strong>{busy ? "正在读取…" : "选择 Excel 或 CSV 文件"}</strong>
            <small>{importFileName || "最多预览前 500 行；保存前不会写入数据库"}</small>
          </label>

          {importHeaders.length ? (
            <>
              <section className="editor-section">
                <div className="editor-heading">
                  <div><span>COLUMN MAPPING</span><h3>字段映射</h3></div>
                  <small>系统已自动匹配，可人工调整</small>
                </div>
                <div className="import-mapping-grid">
                  {orderImportFields.filter((field) => primaryOrderImportFieldKeys.has(field.key)).map((field) => (
                    <label key={field.key}>
                      {field.label}
                      <select
                        value={importMapping[field.key] || ""}
                        onChange={(event) =>
                          setImportMapping((current) => ({
                            ...current,
                            [field.key]: event.target.value,
                          }))
                        }
                      >
                        <option value="">未映射</option>
                        {importHeaders.map((header) => <option key={header} value={header}>{header}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <details className="import-optional-mapping">
                  <summary>其他可选字段</summary>
                  <div className="import-mapping-grid">
                    {orderImportFields.filter((field) => !primaryOrderImportFieldKeys.has(field.key)).map((field) => (
                      <label key={field.key}>
                        {field.label}
                        <select
                          value={importMapping[field.key] || ""}
                          onChange={(event) =>
                            setImportMapping((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                        >
                          <option value="">未映射</option>
                          {importHeaders.map((header) => <option key={header} value={header}>{header}</option>)}
                        </select>
                      </label>
                    ))}
                  </div>
                </details>
                <button type="button" disabled={busy} onClick={() => previewImport()}>
                  重新生成预览
                </button>
              </section>

              {importPreview ? (
                <>
                  <div className="import-preview order-import-summary">
                    <div><span>总行数</span><b>{importPreview.summary.total}</b></div>
                    <div><span>可导入</span><b>{importPreview.summary.ready}</b></div>
                    <div><span>需要确认</span><b>{importPreview.summary.needsReview}</b></div>
                    <div><span>客户代码问题</span><b>{Number(importPreview.summary.missingCustomerCodes) + Number(importPreview.summary.unknownCustomerCodes)}</b></div>
                    <div><span>币种问题</span><b>{importPreview.summary.currencyProblems}</b></div>
                  </div>
                  <div className="import-order-preview-table">
                    <div className="import-order-preview-head">
                      <span>行</span><span>订单 / PI</span><span>客户代码</span><span>金额</span><span>结果</span>
                    </div>
                    {importPreview.rows.slice(0, 80).map((row: Row) => (
                      <div key={`${row.rowNumber}-${row.orderNo}-${row.piNo}`}>
                        <span>{Array.isArray(row.rowNumbers) ? row.rowNumbers.join("、") : row.rowNumber}</span>
                        <span>
                          <strong>{row.orderNo || row.piNo || "—"}</strong>
                          <small>{(row.items || []).map((item: Row) => `${item.description} × ${item.quantity}`).join(" · ") || "无整车明细"}</small>
                          {row.payments?.length ? <small>预付款/尾款：{row.payments.map((payment: Row) => `${payment.paymentType === "deposit" ? "预" : "尾"} ${payment.paymentDate} ${payment.amount}`).join("；")}</small> : null}
                        </span>
                        <span>{row.customerCode || "—"}</span>
                        <span>
                          {row.originalCurrency || "—"} {row.originalAmount ?? "—"}
                          <small>发货：{row.expectedShippingDate || "—"}<br />收清：{row.balanceReceivedDate || "—"}</small>
                        </span>
                        <span className={row.ready && !row.issues.length ? "status good" : "status warning"}>
                          {row.ready
                            ? row.issues.length
                              ? `可导入（${row.issues.map((issue: string) => orderIssueLabels[issue] || issue).join("；")}）`
                              : "可导入"
                            : row.issues.map((issue: string) => orderIssueLabels[issue] || issue).join("；")}
                        </span>
                      </div>
                    ))}
                  </div>
                  {importPreview.summary.unknownCustomerCodes ? (
                    <div className="review-banner">
                      <strong>有客户代码尚未建立</strong>
                      <p>这些订单不能导入；请先建立或校正对应客户代码。系统不会静默创建客户。</p>
                      <button type="button" onClick={() => { setImportOpen(false); onNavigate("customers"); }}>前往客户模块</button>
                    </div>
                  ) : null}
                  {importPreview.summary.currencyProblems ? (
                    <div className="review-banner">
                      <strong>有外币金额等待汇率确认</strong>
                      <p>订单会保留原币金额并标记为“待确认”；确认固定汇率前，不计入人民币销售额。</p>
                    </div>
                  ) : null}
                  <div className="dialog-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || !importPreview.summary.ready || importPreview.summary.needsReview > 0}
                      onClick={confirmImport}
                    >
                      {busy ? "处理中…" : `确认导入 ${importPreview.summary.ready} 笔`}
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
          {message ? <p className="inline-warning">{message}</p> : null}
        </div>
      </Modal>
    </div>
  );
}

function AfterSalesView({
  listCache,
  onListCacheChange,
  attentionTarget,
  onAttentionTargetConsumed,
}: {
  listCache: AfterSalesListCache;
  onListCacheChange: (
    updater: (current: AfterSalesListCache) => AfterSalesListCache,
  ) => void;
  attentionTarget: AttentionTarget | null;
  onAttentionTargetConsumed: (target: AttentionTarget) => void;
}) {
  const emptyDraft = {
    caseTitle: "",
    customerCode: "",
    vehicleModel: "",
    orderNo: "",
    vin: "",
    faultDate: "",
    tags: [] as string[],
    faultSymptoms: "",
    troubleshootingProcess: "",
    confirmedCause: "",
    reuseSolution: "",
    fullTechnicalReport: "",
  };
  const [pagination, setPagination] = useState<AfterSalesPagination>(
    listCache.pagination,
  );
  const [query, setQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [searchResult, setSearchResult] = useState<{
    key: string;
    cases: Row[];
    pagination: AfterSalesPagination;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(!listCache.loaded);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [selectedCaseDetail, setSelectedCaseDetail] = useState<Row | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const filterActive = Boolean(query.trim() || modelFilter || tagFilter);
  const requestKey = [
    query.trim(),
    modelFilter,
    tagFilter,
    pagination.page,
    pagination.pageSize,
  ].join("\u0000");
  const activeSearchResult =
    filterActive && searchResult?.key === requestKey ? searchResult : null;
  const cases = filterActive
    ? activeSearchResult?.cases || []
    : listCache.cases;
  const displayedPagination = filterActive
    ? activeSearchResult?.pagination || pagination
    : listCache.pagination;
  const listLoaded = filterActive
    ? Boolean(activeSearchResult)
    : listCache.loaded;
  const showListLoading = !listLoaded && (initialLoading || !loadError);

  const allTags = useMemo(
    () =>
      [...new Set(listCache.cases.flatMap((item) => parseTags(item.tags)))].sort(),
    [listCache.cases],
  );
  const hasCaseDraftContent = Boolean(
    draft.caseTitle ||
      draft.customerCode ||
      draft.vehicleModel ||
      draft.orderNo ||
      draft.vin ||
      draft.faultDate ||
      draft.tags.length ||
      draft.faultSymptoms ||
      draft.troubleshootingProcess ||
      draft.confirmedCause ||
      draft.reuseSolution ||
      draft.fullTechnicalReport,
  );

  useEffect(() => {
    const controller = new AbortController();
    const hasCachedList = !filterActive && listCache.loaded;
    if (hasCachedList) {
      setRefreshing(true);
    } else {
      setInitialLoading(true);
    }
    setLoadError("");
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (modelFilter) params.set("model", modelFilter);
        if (tagFilter) params.set("tag", tagFilter);
        params.set("page", String(pagination.page));
        params.set("pageSize", String(pagination.pageSize));
        const response = await fetch(
          `/api/after-sales-cases?${params.toString()}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const result = await readApiJson(response, "无法搜索技术案例。");
        setMessage((current) =>
          current === "更新失败，当前显示上一次加载的数据。" ? "" : current,
        );
        const nextPagination = {
          ...pagination,
          ...(result.pagination || {}),
        };
        if (filterActive) {
          setSearchResult({
            key: requestKey,
            cases: result.cases || [],
            pagination: nextPagination,
          });
        } else {
          onListCacheChange((current) => ({
            cases: result.cases || [],
            modelSuggestions:
              result.modelSuggestions || current.modelSuggestions,
            pagination: nextPagination,
            loaded: true,
          }));
          setPagination(nextPagination);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          const errorMessage =
            error instanceof Error ? error.message : "案例加载失败，请重试。";
          setLoadError(errorMessage);
          if (hasCachedList) {
            setMessage("更新失败，当前显示上一次加载的数据。");
          }
        }
      } finally {
        if (!controller.signal.aborted) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    }, filterActive ? 220 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    query,
    modelFilter,
    tagFilter,
    pagination.page,
    pagination.pageSize,
    reloadToken,
  ]);

  function draftFromCase(item: Row) {
    return {
      caseTitle: String(item.case_title || item.code || item.issue_description || ""),
      customerCode: String(item.customer_code || ""),
      vehicleModel: String(item.vehicle_model || ""),
      orderNo: String(item.order_no || ""),
      vin: String(item.vin || ""),
      faultDate: String(item.fault_date || "").slice(0, 10),
      tags: parseTags(item.tags),
      faultSymptoms: String(item.issue_description || ""),
      troubleshootingProcess: String(
        item.troubleshooting_process || item.actions_taken || "",
      ),
      confirmedCause: String(item.confirmed_cause || ""),
      reuseSolution: String(item.reuse_solution || item.resolution || ""),
      fullTechnicalReport: String(
        item.full_technical_report || item.original_customer_description || "",
      ),
    };
  }

  function openNew(mode: "manual" | "report") {
    setEditingId("");
    setSelectedCaseDetail(null);
    setDraft(emptyDraft);
    setImportText("");
    setMessage(
      mode === "report"
        ? "粘贴标准整理稿后可直接本地解析；非标准内容可主动使用 AI 识别。"
        : "",
    );
    setEditorOpen(true);
  }

  async function openEdit(item: Row) {
    setBusy(true);
    setMessage("");
    try {
      const result = await readApiJson(
        await fetch(`/api/after-sales-cases?id=${encodeURIComponent(String(item.id))}`),
        "无法读取技术案例详情。",
      );
      setEditingId(String(item.id));
      setSelectedCaseDetail(result.record);
      setDraft(draftFromCase(result.record));
      setImportText("");
      setEditorOpen(true);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取案例详情失败。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (attentionTarget?.type !== "after_sales_case") return;
    const target = attentionTarget;
    void openEdit({ id: target.id }).then((opened) => {
      if (opened) onAttentionTargetConsumed(target);
    });
  }, [attentionTarget, onAttentionTargetConsumed]);

  function caseListSummary(item: Row) {
    return {
      id: item.id,
      case_title: item.case_title,
      customer_code: item.customer_code,
      vehicle_model: item.vehicle_model,
      fault_date: item.fault_date,
      tags: item.tags,
      fault_symptoms_summary: String(item.issue_description || "").slice(0, 220),
      confirmed_cause_summary: String(item.confirmed_cause || "").slice(0, 180),
      match_snippet: String(item.issue_description || item.confirmed_cause || "").slice(0, 180),
      updated_at: item.updated_at,
    };
  }

  function updateDraft(field: string, value: unknown) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function parseReportLocally() {
    const parsed = parseTechnicalCaseArchive(importText);
    if (!parsed) {
      setMessage("未识别到标准字段标题，可检查格式或主动点击“AI识别并填入”。");
      return;
    }
    setDraft(parsed);
    setMessage("已识别标准技术整理稿并填入字段，尚未保存。");
  }

  async function extractReport() {
    if (!importText.trim()) {
      setMessage("请先粘贴技术整理稿。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await readApiJson(
        await fetch("/api/after-sales-cases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "extract",
            fullTechnicalReport: importText,
          }),
        }),
        "AI填入案例失败。",
      );
      setDraft(result.draft);
      setMessage("AI仅完成字段识别，尚未保存。请检查并手动点击保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI填入失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.caseTitle.trim()) {
      setMessage("案例标题不能为空。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await readApiJson(
        await fetch("/api/after-sales-cases", {
          method: editingId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...draft, id: editingId || undefined }),
        }),
        "技术案例保存失败。",
      );
      const record = result.record;
      const summary = caseListSummary(record);
      onListCacheChange((current) => {
        const currentCases = editingId
          ? current.cases.map((item) =>
              String(item.id) === editingId ? summary : item,
            )
          : current.pagination.page === 1
            ? [summary, ...current.cases].slice(0, current.pagination.pageSize)
            : current.cases;
        const total = current.pagination.total + (editingId ? 0 : 1);
        return {
          ...current,
          cases: currentCases,
          loaded: true,
          pagination: {
            ...current.pagination,
            total,
            totalPages: Math.max(1, Math.ceil(total / current.pagination.pageSize)),
            hasNext:
              current.pagination.page * current.pagination.pageSize < total,
          },
        };
      });
      if (editingId) {
        setSearchResult((current) =>
          current
            ? {
                ...current,
                cases: current.cases.map((item) =>
                  String(item.id) === editingId ? summary : item,
                ),
              }
            : current,
        );
      }
      setSelectedCaseDetail(record);
      setEditorOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteCase() {
    if (!editingId) return;
    if (!window.confirm("确定删除该技术案例吗？删除后无法恢复。")) return;
    setBusy(true);
    try {
      await readApiJson(
        await fetch("/api/after-sales-cases", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: editingId }),
        }),
        "技术案例删除失败。",
      );
      onListCacheChange((current) => {
        const total = Math.max(0, current.pagination.total - 1);
        return {
          ...current,
          cases: current.cases.filter((item) => String(item.id) !== editingId),
          pagination: {
            ...current.pagination,
            total,
            totalPages: Math.max(1, Math.ceil(total / current.pagination.pageSize)),
            hasNext:
              current.pagination.page * current.pagination.pageSize < total,
          },
        };
      });
      setSearchResult((current) => {
        if (!current) return current;
        const total = Math.max(0, current.pagination.total - 1);
        return {
          ...current,
          cases: current.cases.filter((item) => String(item.id) !== editingId),
          pagination: {
            ...current.pagination,
            total,
            totalPages: Math.max(1, Math.ceil(total / current.pagination.pageSize)),
            hasNext:
              current.pagination.page * current.pagination.pageSize < total,
          },
        };
      });
      setSelectedCaseDetail(null);
      setEditorOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败。");
    } finally {
      setBusy(false);
    }
  }

  function highlighted(value: unknown) {
    const source = String(value || "");
    const needle = query.trim();
    if (!needle) return source;
    const parts = source.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((part, index) =>
      part.toLowerCase() === needle.toLowerCase() ? (
        <mark key={`${part}-${index}`}>{part}</mark>
      ) : (
        part
      ),
    );
  }

  function matchingSnippet(item: Row) {
    return String(
      item.match_snippet || item.fault_symptoms_summary || item.confirmed_cause_summary || "",
    );
  }

  function copyCaseField(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setMessage("已复制"))
      .catch(() => setMessage("复制失败，请手动选择内容。"));
  }

  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="AFTER-SALES TECHNICAL CASE LIBRARY"
        title="售后技术案例库"
        detail="沉淀已确认根因和解决方案的完结案例，快速检索并复用排查方法。"
        action={
          <div className="case-library-actions">
            <button type="button" onClick={() => openNew("manual")}>
              新建案例
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => openNew("report")}
            >
              粘贴技术报告
            </button>
          </div>
        }
      />

      <section className="case-library-filters">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPagination((current) => ({ ...current, page: 1 }));
          }}
          placeholder="搜索报警代码、故障现象、车型、VIN、订单号或解决方法"
          aria-label="搜索售后技术案例"
        />
        <select
          value={modelFilter}
          onChange={(event) => {
            setModelFilter(event.target.value);
            setPagination((current) => ({ ...current, page: 1 }));
          }}
          aria-label="车型版本筛选"
        >
          <option value="">全部车型/版本</option>
          {listCache.modelSuggestions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <select
          value={tagFilter}
          onChange={(event) => {
            setTagFilter(event.target.value);
            setPagination((current) => ({ ...current, page: 1 }));
          }}
          aria-label="标签筛选"
        >
          <option value="">全部标签</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        {query || modelFilter || tagFilter ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setModelFilter("");
              setTagFilter("");
              setPagination(listCache.pagination);
            }}
          >
            清空
          </button>
        ) : null}
      </section>
      {message && !editorOpen ? <p className="inline-warning">{message}</p> : null}
      {refreshing && listCache.loaded && !filterActive ? (
        <p className="case-library-refreshing" role="status">正在更新…</p>
      ) : null}
      {showListLoading ? (
        <div className="loading-state case-library-load-state" role="status">
          <span aria-hidden="true" />
          <p>正在加载售后技术案例…</p>
        </div>
      ) : null}
      {!listLoaded && !initialLoading && loadError ? (
        <div className="error-state case-library-load-state" role="alert">
          <strong>案例加载失败，请重试</strong>
          <p>{loadError}</p>
          <button type="button" onClick={() => setReloadToken((current) => current + 1)}>
            重新加载
          </button>
        </div>
      ) : null}
      {listLoaded ? <section className="case-list">
        {cases.map((item) => (
          <button
            className="technical-case-card"
            key={item.id}
            type="button"
            onClick={() => openEdit(item)}
          >
            <div className="technical-case-meta">
              <small>{highlighted(item.customer_code || "未关联客户")}</small>
              <time>{formatDate(item.fault_date || item.updated_at)}</time>
            </div>
            <h3>{highlighted(item.case_title || item.code || "未命名技术案例")}</h3>
            <small className="technical-case-model">
              {highlighted(item.vehicle_model || "车型/版本未填")}
            </small>
            <p>{highlighted(matchingSnippet(item))}</p>
            {item.confirmed_cause_summary ? (
              <p className="technical-case-cause">
                <strong>确认原因：</strong>
                {highlighted(String(item.confirmed_cause_summary))}
              </p>
            ) : null}
            <footer className="archive-chip-row">
              {parseTags(item.tags).slice(0, 3).map((tag) => (
                <span className="archive-chip" key={tag}>{highlighted(tag)}</span>
              ))}
              <time>更新 {formatDate(item.updated_at)}</time>
            </footer>
          </button>
        ))}
        {!cases.length ? (
          <EmptyState
            title={filterActive ? "没有匹配案例" : "暂无技术案例"}
            detail={
              filterActive
                ? "请调整关键词或清空筛选。"
                : "可以手动新建，或粘贴ChatGPT整理好的完整技术报告。"
            }
          />
        ) : null}
      </section> : null}
      {listLoaded && displayedPagination.totalPages > 1 ? (
        <nav className="case-pagination" aria-label="售后技术案例分页">
          <button
            type="button"
            disabled={displayedPagination.page <= 1}
            onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}
          >
            上一页
          </button>
          <span>第 {displayedPagination.page} / {displayedPagination.totalPages} 页 · 共 {displayedPagination.total} 条</span>
          <button
            type="button"
            disabled={!displayedPagination.hasNext}
            onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}
          >
            下一页
          </button>
        </nav>
      ) : null}
      <Modal
        open={editorOpen}
        title={editingId ? "编辑技术案例" : "新建技术案例"}
        onClose={() => !busy && setEditorOpen(false)}
        viewportFixed
        dismissOnBackdrop={false}
      >
        <form className="technical-case-form" onSubmit={saveCase}>
          {!editingId ? <details className="technical-report-import" open>
            <summary>粘贴整理稿</summary>
            <label>
              <span>粘贴 ChatGPT 整理好的技术案例内容</span>
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                rows={8}
                placeholder="优先使用【案例标题】【客户代码】【车型/版本】等标准标题。"
              />
            </label>
            <div className="archive-import-actions">
              <button
                type="button"
                onClick={parseReportLocally}
                disabled={busy || !importText.trim() || hasCaseDraftContent}
              >
                解析整理稿
              </button>
              <button
                type="button"
                onClick={extractReport}
                disabled={busy || !importText.trim() || hasCaseDraftContent}
              >
                {busy ? "正在识别…" : "AI识别并填入"}
              </button>
            </div>
            <small>标准格式解析不调用 AI；AI 仅在你主动点击时识别字段，结果不会自动保存。</small>
            {hasCaseDraftContent ? <small>当前表单已有内容，为保护人工修改，AI识别已停用。</small> : null}
          </details> : null}
          <div className="technical-case-grid">
            <label className="full">
              <span>案例标题 *</span>
              <input
                value={draft.caseTitle}
                onChange={(event) => updateDraft("caseTitle", event.target.value)}
                required
              />
            </label>
            <label>
              <span>客户代码</span>
              <input
                value={draft.customerCode}
                onChange={(event) => updateDraft("customerCode", event.target.value)}
              />
            </label>
            <label>
              <span>车型/版本</span>
              <input
                list="technical-case-model-suggestions"
                value={draft.vehicleModel}
                onChange={(event) => updateDraft("vehicleModel", event.target.value)}
                placeholder="例如 ADV ABS"
              />
              <datalist id="technical-case-model-suggestions">
                {listCache.modelSuggestions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
            <label>
              <span>订单号</span>
              <input
                value={draft.orderNo}
                onChange={(event) => updateDraft("orderNo", event.target.value)}
              />
            </label>
            <label>
              <span>VIN</span>
              <input
                value={draft.vin}
                onChange={(event) => updateDraft("vin", event.target.value)}
              />
            </label>
            <label>
              <span>故障日期</span>
              <DateInput
                value={draft.faultDate}
                onChange={(event) => updateDraft("faultDate", event.target.value)}
              />
            </label>
            <div className="full">
              <EditableChips
                label="标签"
                values={draft.tags}
                onChange={(values) => updateDraft("tags", values)}
              />
            </div>
            {[
              ["faultSymptoms", "故障现象"],
              ["troubleshootingProcess", "排查过程"],
              ["confirmedCause", "确认原因"],
              ["reuseSolution", "解决及复用方法"],
            ].map(([field, label]) => (
              <label className="full" key={field}>
                <span className="knowledge-field-heading">
                  <strong>{label}</strong>
                  <CopyButton
                    onClick={() =>
                      copyCaseField(String(draft[field as keyof typeof draft] || ""))
                    }
                  />
                </span>
                <textarea
                  value={String(draft[field as keyof typeof draft] || "")}
                  onChange={(event) => updateDraft(field, event.target.value)}
                  rows={field === "reuseSolution" ? 7 : 5}
                />
              </label>
            ))}
            <label className="full">
              <span className="knowledge-field-heading">
                <strong>完整技术报告</strong>
                <CopyButton
                  onClick={() => copyCaseField(draft.fullTechnicalReport)}
                />
              </span>
              <textarea
                value={draft.fullTechnicalReport}
                onChange={(event) =>
                  updateDraft("fullTechnicalReport", event.target.value)
                }
                rows={9}
              />
            </label>
          </div>
          {editingId ? (
            <p className="technical-case-timestamps">
              创建时间：{String(selectedCaseDetail?.created_at || "—")}
              <br />
              最后更新时间：{String(selectedCaseDetail?.updated_at || "—")}
            </p>
          ) : null}
          {message ? <p className="inline-warning">{message}</p> : null}
          <div className="dialog-actions technical-case-dialog-actions">
            {editingId ? (
              <button className="danger-button" type="button" onClick={deleteCase} disabled={busy}>
                删除案例
              </button>
            ) : null}
            <button type="button" onClick={() => setEditorOpen(false)} disabled={busy}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存案例"}
            </button>
          </div>
        </form>
      </Modal>

    </div>
  );
}

function KnowledgeView({
  data,
  tab,
  onTab,
  onAdd,
  onSelect,
  onPlaybookRemoved,
  onPlaybookUpdated,
}: {
  data: WorkspaceData;
  tab: "library" | "playbook" | "sources";
  onTab: (tab: "library" | "playbook" | "sources") => void;
  onAdd: () => void;
  onSelect: (item: Row) => void;
  onPlaybookRemoved: (id: string) => void;
  onPlaybookUpdated: (item: Row) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Row[]>(data.knowledge);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!query.trim()) {
      setItems(data.knowledge);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/knowledge?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        const result = await readApiJson(response, "知识搜索失败。");
        setItems(result.items || []);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setMessage(error instanceof Error ? error.message : "知识搜索失败。");
        }
      }
    }, 220);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, data.knowledge]);

  async function removePlaybook(id: string) {
    const response = await fetch("/api/knowledge/playbook", {
      method: "DELETE",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ id }),
    });
    await readApiJson(response, "无法从 Sales Playbook 移除。");
    onPlaybookRemoved(id);
  }

  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="SALES BRAIN"
        title="知识库"
        detail="ChatGPT 负责整理，Workspace 负责识别字段、保存、搜索和复用。"
        action={
          <button className="primary-button" type="button" onClick={onAdd}>
            粘贴整理稿
          </button>
        }
      />
      <div className="subnav">
        <button
          className={tab === "library" ? "active" : ""}
          type="button"
          onClick={() => onTab("library")}
        >
          Knowledge Library <span>{data.knowledge.length}</span>
        </button>
        <button
          className={tab === "playbook" ? "active" : ""}
          type="button"
          onClick={() => onTab("playbook")}
        >
          Sales Playbook <span>{data.playbook.length}</span>
        </button>
        <button
          className={tab === "sources" ? "active" : ""}
          type="button"
          onClick={() => onTab("sources")}
        >
          Source Library <span>{data.sourceDocuments.length}</span>
        </button>
      </div>
      {tab === "library" ? (
        <>
          <section className="knowledge-search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、分类标签、精华、原则、技巧、场景、原文或来源"
              aria-label="搜索知识库"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")}>清空</button>
            ) : null}
          </section>
          {message ? <p className="inline-warning">{message}</p> : null}
          <section className="knowledge-grid">
          {items.map((item) => (
            <button
              className="knowledge-card"
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              aria-label={`打开知识详情：${item.title}`}
            >
              <div>
                <span>{item.category || "待分类"}</span>
                <em className={statusClass(knowledgeStatusValue(item))}>
                  {knowledgeStatusLabel(item)}
                </em>
              </div>
              <h3>{item.title}</h3>
              <p>{item.summary || item.original_text}</p>
              <span className="archive-chip-row">
                {[
                  ...parseList(item.categories),
                  ...parseList(item.tags),
                ].slice(0, 6).map((tag) => (
                  <span className="archive-chip" key={tag}>{tag}</span>
                ))}
              </span>
              <small>原文始终保留 · {item.source || "未填写来源"}</small>
            </button>
          ))}
          {!items.length ? (
            <EmptyState
              title={query ? "没有匹配知识" : "还没有知识条目"}
              detail={query ? "请调整关键词或清空搜索。" : "粘贴 ChatGPT 整理稿后，本地解析并手动保存。"}
            />
          ) : null}
          </section>
        </>
      ) : null}
      {tab === "playbook" ? (
        <section className="playbook-list">
          {data.playbook.map((item) => (
            <PlaybookCard
              key={item.id}
              item={item}
              source={data.knowledge.find(
                (knowledge) => knowledge.id === item.knowledge_item_id,
              )}
              onSource={onSelect}
              onSaved={onPlaybookUpdated}
              onDelete={removePlaybook}
            />
          ))}
          {!data.playbook.length ? (
            <EmptyState
              title="还没有经过筛选的 Playbook 条目"
              detail="不会把《老鸟之路》的全文直接变成规则。"
            />
          ) : null}
        </section>
      ) : null}
      {tab === "sources" ? (
        <section className="source-cards">
          {data.sourceDocuments.map((document) => (
            <article key={document.id}>
              <div>
                <span>SOURCE</span>
                <em className={statusClass(document.review_status)}>
                  {document.review_status}
                </em>
              </div>
              <h3>{document.title}</h3>
              <p>{document.file_name}</p>
              <dl>
                <div>
                  <dt>Authority</dt>
                  <dd>{document.authority}</dd>
                </div>
                <div>
                  <dt>Joyce Approved</dt>
                  <dd>{document.joyce_approved ? "Yes" : "No"}</dd>
                </div>
                <div>
                  <dt>Original</dt>
                  <dd>{document.r2_key ? "Cloud stored" : "Phase 0 backup"}</dd>
                </div>
              </dl>
              {document.title === "老鸟之路" ? (
                <div className="source-warning">
                  不照搬过时 Google 技巧；后续由 AI 提炼并逐条审核。
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function EditableChips({
  label,
  addLabel = label,
  values,
  onChange,
  onCopy,
}: {
  label: string;
  addLabel?: string;
  values: string[];
  onChange: (values: string[]) => void;
  onCopy?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (value) onChange([...new Set([...values, value])]);
    setDraft("");
    setAdding(false);
  }

  function chipWidth(value: string) {
    const width = [...value].reduce(
      (total, character) =>
        total + (/[^\u0000-\u00ff]/.test(character) ? 1 : 0.62),
      0,
    );
    return Math.max(3, width + 0.6);
  }

  return (
    <section className="knowledge-chip-editor">
      <div className="knowledge-field-heading">
        <strong>{label}</strong>
        {onCopy ? <CopyButton onClick={onCopy} /> : null}
      </div>
      <div className="knowledge-chip-row">
        {values.map((value, index) => (
          <span className="knowledge-editable-chip" key={`${label}-${index}`}>
            <input
              aria-label={`${label} ${index + 1}`}
              value={value}
              style={{ width: `${chipWidth(value)}em` }}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                onChange(next);
              }}
              onBlur={() => {
                const normalized = values
                  .map((entry) => entry.trim())
                  .filter(Boolean);
                onChange([...new Set(normalized)]);
              }}
            />
            <button
              type="button"
              aria-label={`删除${label}：${value}`}
              onClick={() =>
                onChange(values.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <span className="knowledge-chip-add">
            <input
              autoFocus
              aria-label={`添加${addLabel}`}
              value={draft}
              placeholder={`输入${addLabel}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
                if (event.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
            />
            <button type="button" onClick={add}>添加</button>
            <button
              type="button"
              aria-label={`取消添加${addLabel}`}
              onClick={() => {
                setDraft("");
                setAdding(false);
              }}
            >
              ×
            </button>
          </span>
        ) : (
          <button
            className="knowledge-chip-trigger"
            type="button"
            onClick={() => setAdding(true)}
          >
            + 添加{addLabel}
          </button>
        )}
      </div>
    </section>
  );
}

function PlaybookCard({
  item,
  source,
  onSource,
  onSaved,
  onDelete,
}: {
  item: Row;
  source?: Row;
  onSource: (item: Row) => void;
  onSaved: (item: Row) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const [principle, setPrinciple] = useState(
    String(item.summary || parseList(item.principles)[0] || item.title || ""),
  );
  const [scenarios, setScenarios] = useState<string[]>(
    parseList(item.applicable_scenarios),
  );
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge/playbook", {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ id: item.id, principle, applicableScenarios: scenarios }),
      });
      const result = await readApiJson(response, "Playbook 保存失败。");
      onSaved(result.item);
      setEditing(false);
      setMessage("已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Playbook 保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="playbook-card">
      {editing ? (
        <>
          <label>
            原则
            <textarea rows={3} value={principle} onChange={(event) => setPrinciple(event.target.value)} />
          </label>
          <EditableChips label="适用场景" values={scenarios} onChange={setScenarios} />
        </>
      ) : (
        <>
          <p className="playbook-principle">{principle}</p>
          <div className="knowledge-chip-row" aria-label="适用场景">
            {scenarios.map((scenario) => (
              <span className="knowledge-editable-chip" key={scenario}>{scenario}</span>
            ))}
          </div>
        </>
      )}
      <p className="playbook-source">
        来源：
        {source ? (
          <button type="button" onClick={() => onSource(source)}>{source.title}</button>
        ) : (
          <span>来源知识不可用</span>
        )}
      </p>
      {message ? <small>{message}</small> : null}
      <div className="task-actions">
        {editing ? (
          <>
            <button type="button" disabled={busy || !principle.trim()} onClick={save}>保存</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)}>编辑</button>
        )}
        <button className="danger-button" type="button" disabled={busy} onClick={() => onDelete(String(item.id))}>删除</button>
      </div>
    </article>
  );
}

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="field-copy-button" type="button" onClick={onClick}>
      复制
    </button>
  );
}

function fitKnowledgeTextarea(
  element: HTMLTextAreaElement | null,
  maximumHeight = 240,
) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, maximumHeight)}px`;
}

function EditableList({
  label,
  addLabel,
  values,
  onChange,
  reorder = false,
  placeholder = "新增一项",
  onCopy,
}: {
  label: string;
  addLabel: string;
  values: string[];
  onChange: (values: string[]) => void;
  reorder?: boolean;
  placeholder?: string;
  onCopy?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  function add() {
    const value = draft.trim();
    if (!value) return;
    onChange([...new Set([...values, value])]);
    setDraft("");
    setAdding(false);
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }
  return (
    <section className="knowledge-list-editor">
      <div className="knowledge-field-heading">
        <strong>{label}</strong>
        <span className="knowledge-field-actions">
          {onCopy ? <CopyButton onClick={onCopy} /> : null}
          <button
            className="knowledge-inline-add"
            type="button"
            onClick={() => setAdding(true)}
          >
            + 添加{addLabel}
          </button>
        </span>
      </div>
      <div className="knowledge-list-items">
        {values.map((value, index) => (
          <div key={`${label}-${index}`}>
            <textarea
              aria-label={`${label} ${index + 1}`}
              rows={1}
              ref={(element) => fitKnowledgeTextarea(element)}
              value={value}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                onChange(next);
                fitKnowledgeTextarea(event.currentTarget);
              }}
            />
            <span>
              {reorder ? (
                <>
                  <button type="button" onClick={() => move(index, -1)}>↑</button>
                  <button type="button" onClick={() => move(index, 1)}>↓</button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
              >
                删除
              </button>
            </span>
          </div>
        ))}
      </div>
      {adding ? (
        <div className="knowledge-list-add">
          <input
            autoFocus
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
          />
          <button className="quiet-button" type="button" onClick={add}>添加</button>
          <button
            className="quiet-button"
            type="button"
            onClick={() => {
              setDraft("");
              setAdding(false);
            }}
          >
            取消
          </button>
        </div>
      ) : null}
    </section>
  );
}

function KnowledgeArchiveModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (item: Row) => void;
}) {
  const emptyDraft: KnowledgeArchiveDraft = {
    title: "",
    categories: [],
    tags: [],
    essenceSummary: "",
    corePrinciples: [],
    actionableTactics: [],
    applicableScenarios: [],
    originalText: "",
    sourceName: "",
    sourceUrl: "",
  };
  const [organizedText, setOrganizedText] = useState("");
  const [draft, setDraft] = useState<KnowledgeArchiveDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const hasDraftContent = Boolean(
    draft.title ||
      draft.categories.length ||
      draft.tags.length ||
      draft.essenceSummary ||
      draft.corePrinciples.length ||
      draft.actionableTactics.length ||
      draft.applicableScenarios.length ||
      draft.originalText ||
      draft.sourceName ||
      draft.sourceUrl,
  );

  function updateDraft<K extends keyof KnowledgeArchiveDraft>(
    key: K,
    value: KnowledgeArchiveDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function parseLocally() {
    const parsed = parseKnowledgeArchive(organizedText);
    if (!parsed) {
      setMessage("未识别到标准字段标题，可检查格式或主动点击“AI识别并填入”。");
      return;
    }
    setDraft(parsed);
    setMessage("已识别标准整理稿并填入字段，尚未保存。");
  }

  async function identifyWithAi() {
    if (!organizedText.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await readApiJson(
        await fetch("/api/knowledge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "extract", organizedText }),
        }),
        "AI识别知识字段失败。",
      );
      setDraft(result.draft);
      setMessage("AI仅完成字段识别，尚未保存。请检查并手动保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI识别失败。");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await readApiJson(
        await fetch("/api/knowledge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(draft),
        }),
        "知识保存失败。",
      );
      onSaved(result.item);
      setOrganizedText("");
      setDraft(emptyDraft);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "知识保存失败。");
    } finally {
      setBusy(false);
    }
  }

  function copy(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setMessage("已复制"))
      .catch(() => setMessage("复制失败，请手动选择内容。"));
  }

  return (
    <Modal
      open={open}
      title="粘贴知识整理稿"
      onClose={() => !busy && onClose()}
      viewportFixed
      dismissOnBackdrop={false}
    >
      <form className="knowledge-detail knowledge-archive-form" onSubmit={save}>
        <section className="archive-import-panel">
          <label>
            粘贴 ChatGPT 整理好的知识库内容
            <textarea
              rows={10}
              value={organizedText}
              onChange={(event) => setOrganizedText(event.target.value)}
              placeholder="使用【标题】【分类标签】【精华提炼】【核心原则】【可执行技巧】【适用场景】【完整原文】【来源】可实现 0 次 AI 调用。"
            />
          </label>
          <div className="archive-import-actions">
            <button
              type="button"
              onClick={parseLocally}
              disabled={!organizedText.trim() || hasDraftContent}
            >
              解析整理稿
            </button>
            <button
              type="button"
              onClick={identifyWithAi}
              disabled={busy || !organizedText.trim() || hasDraftContent}
            >
              {busy ? "正在识别…" : "AI识别并填入"}
            </button>
          </div>
          <small>标准格式优先本地解析；只有主动点击 AI 按钮时才调用 Gemini，且不会自动保存。</small>
          {hasDraftContent ? <small>当前表单已有内容，为保护人工修改，识别按钮已停用。</small> : null}
        </section>
        <label>
          标题
          <input
            value={draft.title}
            onChange={(event) => updateDraft("title", event.target.value)}
            required
          />
        </label>
        <EditableChips
          label="分类标签"
          addLabel="分类标签"
          values={draft.categories}
          onChange={(values) => updateDraft("categories", values)}
        />
        {draft.tags.length ? (
          <EditableChips
            label="补充标签"
            values={draft.tags}
            onChange={(values) => updateDraft("tags", values)}
          />
        ) : null}
        <section className="knowledge-essence-editor">
          <div className="knowledge-field-heading">
            <strong>精华提炼</strong>
            <CopyButton onClick={() => copy(draft.essenceSummary)} />
          </div>
          <textarea
            rows={4}
            value={draft.essenceSummary}
            onChange={(event) => updateDraft("essenceSummary", event.target.value)}
          />
        </section>
        <EditableList
          label="核心原则"
          addLabel="原则"
          values={draft.corePrinciples}
          onChange={(values) => updateDraft("corePrinciples", values)}
          onCopy={() => copy(draft.corePrinciples.join("\n"))}
        />
        <EditableList
          label="可执行技巧"
          addLabel="技巧"
          values={draft.actionableTactics}
          onChange={(values) => updateDraft("actionableTactics", values)}
          onCopy={() => copy(draft.actionableTactics.join("\n"))}
          reorder
        />
        <EditableChips
          label="适用场景"
          addLabel="场景"
          values={draft.applicableScenarios}
          onChange={(values) => updateDraft("applicableScenarios", values)}
          onCopy={() => copy(draft.applicableScenarios.join("\n"))}
        />
        <label>
          <span className="knowledge-field-heading">
            <strong>完整原文</strong>
            <CopyButton onClick={() => copy(draft.originalText)} />
          </span>
          <textarea
            rows={10}
            value={draft.originalText}
            onChange={(event) => updateDraft("originalText", event.target.value)}
            required
          />
        </label>
        <section className="knowledge-source-editor">
          <div className="knowledge-field-heading"><strong>来源</strong></div>
          <label>
            来源名称
            <input
              value={draft.sourceName}
              onChange={(event) => updateDraft("sourceName", event.target.value)}
            />
          </label>
          <label>
            来源链接
            <input
              type="url"
              value={draft.sourceUrl}
              onChange={(event) => updateDraft("sourceUrl", event.target.value)}
            />
          </label>
        </section>
        {message ? <p className="inline-warning">{message}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "保存中…" : "手动保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KnowledgeDetailModal({
  item,
  onClose,
  onSaved,
  onDeleted,
  onPlaybookAdded,
}: {
  item: Row | null;
  onClose: () => void;
  onSaved: (item: Row) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
  onPlaybookAdded: (item: Row) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState(String(item?.title || ""));
  const [summary] = useState(String(item?.summary || ""));
  const [categories, setCategories] = useState<string[]>(
    parseList(item?.categories).length
      ? parseList(item?.categories)
      : item?.category ? [String(item.category)] : [],
  );
  const [tags, setTags] = useState<string[]>(parseList(item?.tags));
  const [essenceSummary, setEssenceSummary] = useState(
    String(item?.essence_summary || ""),
  );
  const [corePrinciples, setCorePrinciples] = useState<string[]>(
    parseList(item?.core_principles),
  );
  const [actionableTactics, setActionableTactics] = useState<string[]>(
    parseList(item?.actionable_tactics),
  );
  const [applicableScenarios, setApplicableScenarios] = useState<string[]>(
    parseList(item?.applicable_scenarios || item?.applicable_situations),
  );
  const [originalText, setOriginalText] = useState(String(item?.original_text || ""));
  const [sourceName, setSourceName] = useState(
    String(item?.source_name || item?.source || ""),
  );
  const [sourceUrl, setSourceUrl] = useState(String(item?.source_url || ""));

  function copyField(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setMessage("已复制"))
      .catch(() => setMessage("复制失败，请手动选择内容。"));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!item) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge", {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          id: item.id,
          title,
          summary,
          categories,
          tags,
          essenceSummary: essenceSummary.trim(),
          corePrinciples,
          actionableTactics,
          applicableScenarios,
          originalText,
          sourceName,
          sourceUrl,
        }),
      });
      const result = await readApiJson(response, "知识保存失败。");
      await onSaved(result.item);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "知识保存失败。");
    } finally {
      setBusy(false);
    }
  }

  async function createPlaybook(principle: string) {
    if (!item) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge/playbook", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          knowledgeItemId: item.id,
          principle,
        }),
      });
      const result = await readApiJson(response, "Sales Playbook 保存失败。");
      onPlaybookAdded(result.item);
      setMessage("核心原则原文及适用场景已复制到 Sales Playbook。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Sales Playbook 保存失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/knowledge", {
        method: "DELETE",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      await readApiJson(response, "知识删除失败。");
      await onDeleted(String(item.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "知识删除失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={Boolean(item)}
        title={item?.title || "知识详情"}
        onClose={onClose}
        viewportFixed
      >
        {item ? (
          <form className="knowledge-detail" onSubmit={save}>
            <div className="knowledge-detail-status">
              <span className={statusClass(knowledgeStatusValue(item))}>
                {knowledgeStatusLabel(item)}
              </span>
              <span>AI：{item.ai_processing_status || "未记录"}</span>
              <span>Joyce：{item.human_review_status || "未记录"}</span>
            </div>

            <label>
              标题
              <input value={title} onChange={(event) => setTitle(event.target.value)} required />
            </label>
            <EditableChips label="分类" values={categories} onChange={setCategories} />
            <EditableChips label="标签" values={tags} onChange={setTags} />
            <section className="knowledge-essence-editor">
              <div className="knowledge-field-heading">
                <strong>精华提炼</strong>
                <CopyButton onClick={() => copyField(essenceSummary)} />
              </div>
              <textarea
                aria-label="精华提炼"
                rows={2}
                ref={(element) => fitKnowledgeTextarea(element, 320)}
                value={essenceSummary}
                onChange={(event) => {
                  setEssenceSummary(event.target.value);
                  fitKnowledgeTextarea(event.currentTarget, 320);
                }}
              />
              {!essenceSummary &&
              item.ai_processing_status === "failed" ? (
                <small className="inline-warning">
                  精华提炼生成失败，完整原文已经保留。请先保留或手动填写内容。
                </small>
              ) : null}
            </section>
            <div className="knowledge-principles-section">
              <EditableList
                label="核心原则"
                addLabel="原则"
                placeholder="输入原则……"
                values={corePrinciples}
                onCopy={() => copyField(corePrinciples.join("\n"))}
                onChange={(values) => {
                  setCorePrinciples(values);
                }}
              />
              <div className="playbook-add-actions">
                {corePrinciples.map((principle) => (
                  <button
                    className="quiet-button"
                    type="button"
                    key={principle}
                    disabled={busy}
                    onClick={() => createPlaybook(principle)}
                  >
                    将此原则加入 Sales Playbook
                  </button>
                ))}
              </div>
            </div>
            <EditableList
              label="可执行技巧"
              addLabel="技巧"
              placeholder="输入技巧……"
              values={actionableTactics}
              onChange={setActionableTactics}
              onCopy={() => copyField(actionableTactics.join("\n"))}
              reorder
            />
            <EditableChips
              label="适用场景"
              addLabel="场景"
              values={applicableScenarios}
              onChange={setApplicableScenarios}
              onCopy={() => copyField(applicableScenarios.join("\n"))}
            />
            <label>
              <span className="knowledge-field-heading">
                <strong>完整原文</strong>
                <CopyButton onClick={() => copyField(originalText)} />
              </span>
              <textarea
                className="knowledge-original"
                value={originalText}
                ref={(element) => fitKnowledgeTextarea(element, 480)}
                onChange={(event) => {
                  setOriginalText(event.target.value);
                  fitKnowledgeTextarea(event.currentTarget, 480);
                }}
                rows={8}
                required
              />
            </label>
            <section className="knowledge-source-editor">
              <div className="knowledge-field-heading"><strong>来源</strong></div>
              <label>
                来源名称
                <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} />
              </label>
              <label>
                来源链接
                <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
              </label>
              <small>
                内部追溯：{item.original_source_type || "未记录"} ·{" "}
                {item.original_source_record_id || "无外部记录编号"}
              </small>
            </section>
            {message ? <p className="inline-warning">{message}</p> : null}
            <div className="knowledge-detail-actions">
              <button
                className={confirmDelete ? "danger-button confirmed" : "danger-button"}
                type="button"
                disabled={busy}
                onClick={remove}
              >
                {confirmDelete ? "再次点击确认删除" : "删除"}
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy ? "正在保存…" : "保存修改"}
              </button>
            </div>
          </form>
        ) : null}
      </Modal>

    </>
  );
}

function ContentView({ data }: { data: WorkspaceData }) {
  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="CONTENT"
        title="内容运营"
        detail="想法、草稿和已发布内容保留来源；产品参数必须来自已验证资料。"
      />
      <section className="content-board">
        {["想法", "草稿", "待发布", "已发布"].map((status) => (
          <article key={status}>
            <div className="panel-heading">
              <h2>{status}</h2>
              <span>
                {data.content.filter((item) => item.status === status).length}
              </span>
            </div>
            {data.content
              .filter((item) => item.status === status)
              .map((item) => (
                <div className="content-card" key={item.id}>
                  <strong>{item.topic}</strong>
                  <p>{item.draft || item.source_material || "尚未生成文案"}</p>
                  <small>{item.platform || "平台未定"}</small>
                </div>
              ))}
          </article>
        ))}
      </section>
    </div>
  );
}

function SettingsView({
  data,
  onReload,
}: {
  data: WorkspaceData;
  onReload: () => Promise<void>;
}) {
  const [state, setState] = useState<Row | null>(null);
  const [preview, setPreview] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [aiHealth, setAiHealth] = useState<Row | null>(null);

  useEffect(() => {
    fetch("/api/ai/provider")
      .then((response) => readApiJson(response, "无法读取 AI Provider 状态。"))
      .then(setAiHealth)
      .catch(() => setAiHealth(null));
  }, []);

  async function readBackup(file: File) {
    setMessage("");
    try {
      const parsed = JSON.parse(await file.text());
      setState(parsed);
      setBusy(true);
      const response = await fetch("/api/import-v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", state: parsed }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "备份预览失败。");
      setPreview(result.preview);
    } catch (requestError) {
      setMessage(
        requestError instanceof Error ? requestError.message : "备份预览失败。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!state) return;
    setBusy(true);
    const response = await fetch("/api/import-v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "import", state }),
    });
    const result = await response.json();
    if (!response.ok) setMessage(result.error || "导入失败。");
    else {
      setMessage(
        `迁移完成：${Object.values(result.importedCounts as Record<string, number>).reduce((sum, count) => sum + count, 0)} 条新记录。`,
      );
      await onReload();
    }
    setBusy(false);
  }

  return (
    <div className="view-stack">
      <SectionTitle
        eyebrow="SETTINGS"
        title="设置与数据完整性"
        detail="这里显示迁移事实，不用漂亮数字掩盖待确认数据。"
      />
      <section className="settings-grid">
        <article className="plain-panel">
          <div className="panel-heading">
            <h2>Phase 0 migration</h2>
            <span className="status good">已执行</span>
          </div>
          <dl className="integrity-list">
            {data.integrity.migrationCounts?.map((item: Row) => (
              <div key={item.source_type}>
                <dt>{item.source_type}</dt>
                <dd>{item.count}</dd>
              </div>
            ))}
          </dl>
          <div className="integrity-alerts">
            <span>
              Phase 1/2 客户保留{" "}
              <b>
                {data.integrity.phase12_current_customers ?? 0}/
                {data.integrity.phase12_backup_customers ?? 0}
              </b>
            </span>
            <span>
              Phase 1/2 任务保留{" "}
              <b>
                {data.integrity.phase12_current_tasks ?? 0}/
                {data.integrity.phase12_backup_tasks ?? 0}
              </b>
            </span>
            <span>
              任务清理升级保留{" "}
              <b>
                {data.integrity.task_cleanup_current_tasks ?? 0}/
                {data.integrity.task_cleanup_backup_tasks ?? 0}
              </b>
            </span>
            <span>
              回收站任务 <b>{data.integrity.task_trash_count ?? 0}</b>
            </span>
            <span>
              联系人迁移{" "}
              <b>
                {data.integrity.phase12_current_contacts ?? 0}/
                {data.integrity.phase12_backup_contacts ?? 0}
              </b>
            </span>
            <span>
              Phase 4 订单保留{" "}
              <b>
                {data.integrity.phase4_current_orders ?? 0}/
                {data.integrity.phase4_backup_orders ?? 0}
              </b>
            </span>
            <span>
              老客户缺少代码{" "}
              <b>{data.integrity.missing_customer_codes ?? 0}</b>
            </span>
            <span>
              币种 / 汇率待确认{" "}
              <b>{data.integrity.currency_inconsistencies ?? 0}</b>
            </span>
            <span>
              Source 待审核{" "}
              <b>{data.integrity.documents_needing_review ?? 0}</b>
            </span>
            <span>
              Approved Playbook{" "}
              <b>{data.integrity.approved_playbook_items ?? 0}</b>
            </span>
          </div>
        </article>
        <article className="plain-panel">
          <div className="panel-heading">
            <h2>导入 V1 浏览器备份</h2>
            <span>Preview first</span>
          </div>
          <p className="settings-copy">
            在旧版点击“导出备份”，选择生成的 JSON。系统先统计模块、字段和风险，确认后才迁移。
          </p>
          <label className="file-drop">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) readBackup(file);
              }}
            />
            <strong>{busy ? "正在读取…" : "选择 V1 JSON 备份"}</strong>
            <small>未知字段和自定义模块会进入 legacy_metadata / Review</small>
          </label>
          {preview ? (
            <div className="import-preview">
              <div>
                <span>模块</span>
                <b>{preview.moduleCount}</b>
              </div>
              <div>
                <span>记录</span>
                <b>{preview.totalRecords}</b>
              </div>
              <div>
                <span>自定义模块</span>
                <b>{preview.customModules.length}</b>
              </div>
              <div>
                <span>汇率待确认</span>
                <b>{preview.currencyReviewCount}</b>
              </div>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={importBackup}
              >
                确认迁移
              </button>
            </div>
          ) : null}
          {message ? <p className="inline-warning">{message}</p> : null}
        </article>
      </section>
      <section className="plain-panel architecture-note">
        <h2>AI Provider Layer</h2>
        <p>
          当前 Provider：Gemini；默认模型和深度模型均由服务器端 GEMINI_MODEL / GEMINI_REASONING_MODEL 配置。API Key 仅保存在服务端；DeepSeek 保留为可选备用能力，默认不会自动调用。
        </p>
        <p>
          API Key：{aiHealth ? (aiHealth.configured ? "已配置" : "未配置") : "状态暂不可用"}；DeepSeek：{aiHealth?.deepseek ?? "备用 / 未启用"}
        </p>
      </section>
    </div>
  );
}

function ContactFieldSet({
  contact,
  onDraftChange,
}: {
  contact: Row;
  onDraftChange?: (field: keyof CustomerContactDraft, value: string | boolean) => void;
}) {
  const textValue = (field: Exclude<keyof CustomerContactDraft, "isPrimary">) =>
    String(contact[field] ?? (field === "position" ? contact.role ?? "" : ""));
  const textProps = (field: Exclude<keyof CustomerContactDraft, "isPrimary">) =>
    onDraftChange
      ? {
          value: textValue(field),
          onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onDraftChange(field, event.target.value),
        }
      : { name: field, defaultValue: textValue(field) };
  const primaryProps = onDraftChange
    ? {
        checked: Boolean(contact.isPrimary),
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onDraftChange("isPrimary", event.target.checked),
      }
    : { name: "isPrimary", defaultChecked: Boolean(contact.is_primary) };

  return (
    <>
      <div className="form-grid">
        <label>
          姓名
          <input {...textProps("name")} />
        </label>
        <label>
          职位
          <input {...textProps("position")} />
        </label>
        <label>
          邮箱
          <input type="email" {...textProps("email")} />
        </label>
        <label>
          电话
          <input {...textProps("phone")} />
        </label>
        <label>
          WhatsApp
          <input {...textProps("whatsapp")} />
        </label>
        <label>
          微信
          <input {...textProps("wechat")} />
        </label>
        <label>
          LinkedIn
          <input {...textProps("linkedin")} />
        </label>
      </div>
      <label>
        联系人备注
        <textarea rows={2} {...textProps("notes")} />
      </label>
      <label className="check-label">
        <input type="checkbox" {...primaryProps} />
        设为主要联系人
      </label>
    </>
  );
}

function NewCustomerContacts({
  onDraftStateChange,
}: {
  onDraftStateChange: () => void;
}) {
  const [contacts, setContacts] = useState<CustomerContactDraft[]>([]);
  const [newContactOpen, setNewContactOpen] = useState(false);
  const [draft, setDraft] = useState<CustomerContactDraft>(emptyCustomerContactDraft);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    onDraftStateChange();
  }, [contacts, draft, onDraftStateChange]);

  function resetDraft() {
    setDraft(emptyCustomerContactDraft());
    setEditingIndex(null);
    setNewContactOpen(false);
    setError("");
  }

  function saveContact() {
    if (!draft.name.trim()) {
      setError("请填写联系人姓名。");
      return;
    }
    setContacts((current) => {
      const next = editingIndex === null
        ? [...current, draft]
        : current.map((contact, index) => index === editingIndex ? draft : contact);
      return draft.isPrimary
        ? next.map((contact, index) => ({ ...contact, isPrimary: index === (editingIndex ?? next.length - 1) }))
        : next;
    });
    resetDraft();
  }

  return (
    <section className="new-customer-contacts" aria-label="联系人">
      <input name="contacts" type="hidden" value={JSON.stringify(contacts)} />
      <input name="contactDraft" type="hidden" value={JSON.stringify(draft)} />
      <div className="editor-heading">
        <div>
          <span>CONTACTS</span>
          <h3>联系人</h3>
        </div>
        <small>可在创建后继续维护</small>
      </div>
      <div className="contact-editors">
        {contacts.map((contact, index) => (
          <article className="contact-editor new-customer-contact" key={`${contact.name}-${index}`}>
            <span>
              <strong>{contact.name}</strong>
              <small>
                {contact.position || "未填写职位"}
                {contact.wechat ? ` · 微信：${contact.wechat}` : ""}
                {contact.isPrimary ? " · 主要联系人" : ""}
              </small>
            </span>
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => {
                  setDraft(contact);
                  setEditingIndex(index);
                  setNewContactOpen(true);
                  setError("");
                }}
              >
                编辑
              </button>
              <button type="button" onClick={() => setContacts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                删除
              </button>
            </div>
          </article>
        ))}
        {!newContactOpen ? (
          <button
            className="add-contact-button"
            type="button"
            onClick={() => setNewContactOpen(true)}
          >
            + 新增联系人
          </button>
        ) : (
          <div className="contact-editor new">
            <strong>{editingIndex === null ? "新增联系人" : "编辑联系人"}</strong>
            <ContactFieldSet
              contact={draft}
              onDraftChange={(field, value) =>
                setDraft((current) => ({ ...current, [field]: value }))
              }
            />
            {error ? <p className="inline-warning" role="alert">{error}</p> : null}
            <div className="dialog-actions">
              <button type="button" onClick={resetDraft}>取消</button>
              <button className="primary-button" type="button" onClick={saveContact}>
                保存联系人
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function newCustomerInitialDraftSignature() {
  const emptyContact = JSON.stringify(emptyCustomerContactDraft());
  return customerEditorStateSignature({
    company: "",
    lifecycle: "potential_lead",
    customerCode: "",
    country: "",
    city: "",
    website: "",
    customerType: "",
    source: "",
    address: "",
    companyBackgroundNotes: "",
    contacts: "[]",
    contactDraft: emptyContact,
    nextAction: "",
  });
}

function NewCustomerForm({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const initialDraftRef = useRef(newCustomerInitialDraftSignature());
  const [isDirty, setIsDirty] = useState(false);
  const [lifecycle, setLifecycle] = useState("potential_lead");
  const [contactDraftRevision, setContactDraftRevision] = useState(0);
  const notifyContactDraftChange = useCallback(
    () => setContactDraftRevision((value) => value + 1),
    [],
  );
  const refreshDirty = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    setIsDirty(customerFormSignature(form) !== initialDraftRef.current);
  }, []);
  const closeGuard = useCustomerCloseGuard({
    isDirty: () => isDirty,
    isSaving: () => busy,
    onClose,
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(refreshDirty);
    return () => window.cancelAnimationFrame(frame);
  }, [contactDraftRevision, refreshDirty]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const saved = await onSubmit(event);
    if (saved) setIsDirty(false);
  }

  return (
    <Modal open title="新增客户" onClose={closeGuard.requestClose} viewportFixed>
      <div ref={editorRef}>
        <form
          className="form-stack"
          ref={formRef}
          onSubmit={(event) => void submit(event)}
          onInput={refreshDirty}
          onChange={refreshDirty}
        >
          <section className="new-customer-section">
            <div className="editor-heading">
              <div>
                <span>BASIC INFORMATION</span>
                <h3>基本信息</h3>
              </div>
            </div>
            <div className="form-grid">
              <label>
                公司名称
                <input name="company" required />
              </label>
              <label>
                生命周期
                <select
                  name="lifecycle"
                  value={lifecycle}
                  onChange={(event) => setLifecycle(event.target.value)}
                >
                  <option value="potential_lead">潜在线索</option>
                  <option value="potential_customer">潜在客户</option>
                  <option value="existing">老客户</option>
                </select>
              </label>
              {lifecycle === "existing" ? (
                <label>
                  客户代码
                  <input name="customerCode" required />
                </label>
              ) : null}
              <label>
                国家
                <input name="country" />
              </label>
              <label>
                城市
                <input name="city" />
              </label>
              <label>
                网站
                <input name="website" />
              </label>
              <label>
                客户类型
                <input name="customerType" />
              </label>
              <label>
                来源
                <input name="source" />
              </label>
            </div>
            <label>
              地址
              <textarea name="address" rows={2} />
            </label>
          </section>
          <label>
            公司背景与合作备注
            <textarea
              name="companyBackgroundNotes"
              rows={4}
              placeholder="公司主营、决策流程、采购与合作特点等长期信息"
            />
          </label>
          <NewCustomerContacts
            onDraftStateChange={notifyContactDraftChange}
          />
          <label>
            下一步
            <textarea name="nextAction" rows={3} />
          </label>
          {error ? <p className="inline-warning" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </form>
      </div>
      <CustomerUnsavedChangesDialog
        open={closeGuard.closeConfirmOpen}
        editorRoot={editorRef}
        onContinue={closeGuard.continueEditing}
        onDiscard={closeGuard.discardChanges}
      />
    </Modal>
  );
}

function RecordModal({
  kind,
  defaults,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: "task" | "project" | "customer" | "order" | "knowledge" | null;
  defaults: Row;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const titles = {
    task: "新增任务",
    project: "新增项目",
    customer: "新增客户",
    order: "新增订单",
    knowledge: "保存知识",
  };
  if (kind === "customer") {
    return (
      <NewCustomerForm
        busy={busy}
        error={error}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );
  }
  return (
    <Modal open={Boolean(kind)} title={kind ? titles[kind] : ""} onClose={onClose}>
      {kind ? (
        <form className="form-stack" onSubmit={onSubmit}>
          {kind === "task" ? (
            <>
              <label>
                任务内容
                <input name="title" required />
              </label>
              <label>
                提醒日期
                <DateInput
                  name="reminderDate"
                  defaultValue={defaults.reminderDate ?? ""}
                />
              </label>
              <label>
                重复规则
                <select name="recurrenceRule" defaultValue="none">
                  {repeatRuleOptions.map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                  <option value="custom" disabled>自定义（后续扩展）</option>
                </select>
              </label>
              <label>
                下一步
                <textarea name="nextAction" rows={3} />
              </label>
              <label>
                备注
                <textarea name="notes" rows={3} />
              </label>
            </>
          ) : null}
          {kind === "project" ? (
            <>
              <label>
                项目标题
                <input name="title" required />
              </label>
              <label>
                状态
                <select name="status" defaultValue="进行中">
                  <option>规划中</option>
                  <option>进行中</option>
                  <option>暂停</option>
                  <option>已完成</option>
                </select>
              </label>
              <label>
                下一步
                <textarea name="nextStep" rows={3} />
              </label>
              <label>
                备注
                <textarea name="notes" rows={4} />
              </label>
            </>
          ) : null}
          {kind === "order" ? (
            <>
              <div className="form-grid">
                <label>
                  订单号
                  <input name="orderNo" />
                </label>
                <label>
                  订单日期
                  <DateInput name="orderDate" />
                </label>
                <label>
                  客户代码
                  <input name="customerCode" />
                </label>
                <label>
                  客户名称
                  <input name="customerName" />
                </label>
                <label>
                  币种
                  <select name="originalCurrency" defaultValue="USD">
                    <option>USD</option>
                    <option>EUR</option>
                    <option>CNY</option>
                    <option>RMB</option>
                    <option>GBP</option>
                  </select>
                </label>
                <label>
                  订单总金额
                  <input name="originalAmount" type="number" step="0.01" />
                </label>
                <label>
                  固定汇率 → CNY
                  <input
                    name="fixedExchangeRateToCny"
                    type="number"
                    step="0.0001"
                  />
                </label>
                <label>
                  车型 / 配件
                  <input name="model" />
                </label>
              </div>
              <label className="risk-confirm">
                <input name="confirmFinancialRisk" type="checkbox" required />
                <span>
                  我确认本次保存会影响金额统计。非 CNY 订单必须填写该笔订单的固定汇率。
                </span>
              </label>
            </>
          ) : null}
          {kind === "knowledge" ? (
            <>
              <label>
                标题
                <input name="title" />
              </label>
              <div className="form-grid">
                <label>
                  分类
                  <input name="category" placeholder="例如 销售谈判" />
                </label>
                <label>
                  标签
                  <input name="tags" placeholder="压价，客户心理" />
                </label>
              </div>
              <label>
                来源
                <input name="source" placeholder="文章、课程、客户案例…" />
              </label>
              <label>
                摘要
                <textarea name="summary" rows={4} />
              </label>
              <label>
                原始内容
                <textarea name="originalText" rows={8} required />
              </label>
            </>
          ) : null}
          {error ? <p className="inline-warning" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </form>
      ) : null}
    </Modal>
  );
}
