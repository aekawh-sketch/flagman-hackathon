// Все запросы к серверу — в одном модуле (ТЗ п. 46): переход на другой бэкенд — правка одного файла.
import type {
  Alert, AppConfig, AuditEntry, BatchDto, Catalog, Dashboard, DeficitRow, DeliveryDto, DeliveryIn, DeliveryResult, DemoState, ExpiredBatch, HotOffersResult, InventoryCount, Invite, InviteInfo, LedgerRow, LossDay, Me, OrderDto, ProductStock, PurchasesResult, RejectReason, StopEta, SupplyRow, TenantLocation, Trace, UserDto, VariantStatus, Verification, WriteoffAnalytics, WriteoffRequest, Anomaly, OrderTraceRow, OrderComposition, PrepTrace, DishUse, ProductTrace, OperationsResult, ActorOperations, CatalogImportResult, ReturnableLine, CreateTenantResult, TenantRequest, PlatformTenant, PlatformSettings, TenantDeletion, ReturnReason, SupplierReturn, WriteoffSource, AnomalyDetail, RecipeVersion, KitchenTicket, KitchenPrinter, PrintResult, ProfitAnalytics,
} from "./types";

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Ошибка ${res.status}`, data?.details);
  }
  return data as T;
}

const get = <T,>(url: string) => request<T>("GET", url);
const post = <T,>(url: string, body?: unknown) => request<T>("POST", url, body ?? {});
const put = <T,>(url: string, body?: unknown) => request<T>("PUT", url, body);
const patch = <T,>(url: string, body?: unknown) => request<T>("PATCH", url, body);
const del = <T,>(url: string) => request<T>("DELETE", url);
const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== undefined && v !== null && v !== "" && s.set(k, String(v)));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const api = {
  // Вход
  config: (loc?: string) => get<AppConfig>(`/api/auth/config${q({ loc })}`),
  me: () => get<Me>("/api/auth/me"),
  login: (login: string, password: string) => post<Me>("/api/auth/login", { login, password }),
  demoLogin: (role: string) => post<Me>("/api/auth/demo", { role }),
  logout: () => post("/api/auth/logout"),

  // Предприятия и приглашения (ТЗ 16.4)
  switchTenant: (tenantId: number) => post<Me>("/api/auth/tenant", { tenantId }),
  /** Своё предприятие: сразу (CREATED) или заявкой администратору платформы (PENDING). */
  createTenant: (name: string, locationName: string, comment?: string) =>
    post<CreateTenantResult>("/api/auth/tenants", { name, locationName, comment }),
  /** Открытая регистрация: учётка без предприятия. */
  signUp: (login: string, name: string, password: string) => post<Me>("/api/auth/register", { login, name, password }),
  myTenantRequests: () => get<TenantRequest[]>("/api/auth/tenant-requests"),
  cancelTenantRequest: (id: number) => post<TenantRequest>(`/api/auth/tenant-requests/${id}/cancel`),
  // Админка платформы — над всеми предприятиями
  platformRequests: (status?: string) => get<TenantRequest[]>(`/api/platform/tenant-requests${q({ status })}`),
  platformApprove: (id: number, comment: string) => post<TenantRequest>(`/api/platform/tenant-requests/${id}/approve`, { comment }),
  platformReject: (id: number, comment: string) => post<TenantRequest>(`/api/platform/tenant-requests/${id}/reject`, { comment }),
  platformTenants: () => get<PlatformTenant[]>("/api/platform/tenants"),
  /**
   * Предприятие от платформы сразу с точками (первая — основная; пусто — одна с названием предприятия).
   * joinAsAdmin — вы и сами его админ, иначе владельца приглашают ссылкой.
   */
  platformCreateTenant: (name: string, locations: string[], joinAsAdmin: boolean) =>
    post<{ tenantId: number; name: string; locationId: string }>("/api/platform/tenants", { name, locations, joinAsAdmin }),
  platformLocations: (tenantId: number) => get<TenantLocation[]>(`/api/platform/tenants/${tenantId}/locations`),
  platformInvites: (tenantId: number) => get<Invite[]>(`/api/platform/tenants/${tenantId}/invites`),
  platformInvite: (tenantId: number, role: string, locationId: string | null, note: string) =>
    post<{ id: number; token: string; expiresAt: string }>(`/api/platform/tenants/${tenantId}/invites`, { role, locationId, note }),
  platformRevokeInvite: (tenantId: number, id: number) => del(`/api/platform/tenants/${tenantId}/invites/${id}`),
  /** Безвозвратно; confirm — точное название предприятия. */
  platformDeleteTenant: (id: number, confirm: string, reason: string) =>
    post<TenantDeletion>(`/api/platform/tenants/${id}/delete`, { confirm, reason }),
  platformDeletions: () => get<TenantDeletion[]>("/api/platform/tenants/deleted"),
  platformSettings: () => get<PlatformSettings>("/api/platform/settings"),
  platformUpdateSettings: (s: PlatformSettings) => put<PlatformSettings>("/api/platform/settings", s),
  inviteInfo: (token: string) => get<InviteInfo>(`/api/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) => post<Me>(`/api/auth/invites/${encodeURIComponent(token)}/accept`),
  registerByInvite: (token: string, body: { login: string; name: string; password: string; pin?: string }) =>
    post<Me>(`/api/auth/invites/${encodeURIComponent(token)}/register`, body),

  // Склад
  /** Потери, заказы, выручка и отказы — за период (по умолчанию сегодня); состояние склада — на сейчас. */
  dashboard: (loc: string, from?: string, to?: string) => get<Dashboard>(`/api/${loc}/dashboard${q({ from, to })}`),
  stock: (loc: string) => get<ProductStock[]>(`/api/${loc}/stock`),
  batches: (loc: string, product?: string, includeEmpty = false) =>
    get<BatchDto[]>(`/api/${loc}/batches${q({ product, includeEmpty: includeEmpty || undefined })}`),
  trace: (loc: string, id: number) => get<Trace>(`/api/${loc}/batches/${id}`),
  openBatch: (loc: string, id: number, packs: number) => post(`/api/${loc}/batches/${id}/open`, { packs }),
  blockBatch: (loc: string, id: number, reason: string, cascade: boolean) =>
    post<{ blocked: number[] }>(`/api/${loc}/batches/${id}/block`, { reason, cascade }),
  unblockBatch: (loc: string, id: number, reason: string) => post(`/api/${loc}/batches/${id}/unblock`, { reason }),
  disposeBatch: (loc: string, id: number, toSupplier: boolean) =>
    post(`/api/${loc}/batches/${id}/dispose`, { toSupplier }),
  produce: (loc: string, productId: string, qty: number) =>
    post<{ batchId: number; label: string; qtyText: string; expiresAt: string }>(`/api/${loc}/production`,
      { productId, qty }),

  // Меню
  menu: (loc: string) => get<VariantStatus[]>(`/api/${loc}/menu`),
  hot: (loc: string) => get<HotOffersResult>(`/api/${loc}/hot-offers`),
  stopForecast: (loc: string, hours = 48) => get<StopEta[]>(`/api/${loc}/stoplist/forecast${q({ hours })}`),
  purchases: (loc: string) => get<PurchasesResult>(`/api/${loc}/purchase-suggestions`),

  // Поставки
  deliveries: (loc: string, status?: string) => get<DeliveryDto[]>(`/api/${loc}/deliveries${q({ status })}`),
  /** Форма в интерфейсе ходит в тот же API, что и внешние системы (ТЗ 16.1). */
  createDelivery: (loc: string, body: DeliveryIn) => post<DeliveryResult>(`/api/${loc}/deliveries?channel=FORM`, body),
  /** Пример поставки в Excel из продуктов каталога — скачать ссылкой. */
  deliverySampleXlsxUrl: (loc: string) => `/api/${loc}/deliveries/sample.xlsx`,
  /** Меню предприятия: импорт из Excel или JSON и примеры. */
  importCatalogFile: (file: File) => {
    if (/\.json$/i.test(file.name)) {
      return file.text().then((t) => post<CatalogImportResult>("/api/catalog/import", JSON.parse(t)));
    }
    const fd = new FormData();
    fd.append("file", file);
    return post<CatalogImportResult>("/api/catalog/import/xlsx", fd);
  },
  catalogSampleXlsxUrl: "/api/catalog/sample.xlsx",
  catalogSampleJsonUrl: "/api/catalog/sample.json",
  uploadDelivery: (loc: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return post<DeliveryResult>(`/api/${loc}/deliveries/upload`, fd);
  },
  acceptDelivery: (loc: string, id: string,
                   lines: { lineNo: number; qtyActual: number | null; rejectReason?: RejectReason | null; comment?: string }[],
                   confirmShortLife: boolean) =>
    post<DeliveryResult>(`/api/${loc}/deliveries/${encodeURIComponent(id)}/accept`, { lines, confirmShortLife }),
  invoicePhoto: (loc: string, id: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f));
    return post(`/api/${loc}/deliveries/${encodeURIComponent(id)}/photo`, fd);
  },
  /** Управляющий: что из накладной берём — целиком или частично (qty 0 — строку не берём). */
  approveDelivery: (loc: string, id: string, lines: { lineNo: number; qty: number | null; note?: string }[], comment: string) =>
    post(`/api/${loc}/deliveries/${encodeURIComponent(id)}/approve`, { lines, comment }),
  invoicePhotoUrl: (loc: string, id: string, i = 0) => `/api/${loc}/deliveries/${encodeURIComponent(id)}/photo?i=${i}`,
  rejectDelivery: (loc: string, id: string, comment?: string) =>
    post(`/api/${loc}/deliveries/${encodeURIComponent(id)}/reject`, { comment }),

  // Просрочка: под списание → списывает человек
  expired: (loc: string) => get<ExpiredBatch[]>(`/api/${loc}/expired`),
  writeOffExpired: (loc: string, batchId: number) =>
    post<{ ok: boolean; costKop: number }>(`/api/${loc}/batches/${batchId}/writeoff-expired`),
  writeOffAllExpired: (loc: string) => post<{ ok: boolean; batches: number }>(`/api/${loc}/expired/writeoff`),

  // Заказы
  orders: (loc: string, status?: string, limit = 50) => get<OrderDto[]>(`/api/${loc}/orders${q({ status, limit })}`),
  orderStatus: (loc: string, id: number, status: string) => post(`/api/${loc}/orders/${id}/status`, { status }),
  // Чек на кухню (ТЗ 16.15)
  /** Чеки на кухню; from и to — отрезок времени (ISO), без них — последние */
  kitchenTickets: (loc: string, limit = 20, from?: string, to?: string) =>
    get<KitchenTicket[]>(`/api/${loc}/kitchen/tickets${q({ limit, from, to })}`),
  reprintTicket: (loc: string, id: number) => post<PrintResult>(`/api/${loc}/kitchen/tickets/${id}/print`),
  kitchenPrinter: (loc: string) => get<KitchenPrinter>(`/api/${loc}/kitchen/printer`),
  saveKitchenPrinter: (loc: string, p: Omit<KitchenPrinter, "locationId">) => put<KitchenPrinter>(`/api/${loc}/kitchen/printer`, p),
  testKitchenPrinter: (loc: string) => post<PrintResult>(`/api/${loc}/kitchen/printer/test`),

  // Возврат поставщику
  returnable: (loc: string, deliveryId: string) =>
    get<ReturnableLine[]>(`/api/${loc}/deliveries/${encodeURIComponent(deliveryId)}/returnable`),
  returns: (loc: string, params: { status?: string; deliveryId?: string } = {}) =>
    get<SupplierReturn[]>(`/api/${loc}/returns${q(params)}`),
  createReturn: (loc: string, deliveryId: string, lines: { batchId: number; qty: number }[], reason: ReturnReason,
                 comment: string, photos: File[]) => {
    const fd = new FormData();
    fd.append("deliveryId", deliveryId);
    lines.forEach((l) => { fd.append("batchId", String(l.batchId)); fd.append("qty", String(l.qty)); });
    fd.append("reason", reason);
    if (comment) fd.append("comment", comment);
    photos.forEach((p) => fd.append("photo", p));
    return post<{ id: number; status: string; costKop: number }>(`/api/${loc}/returns`, fd);
  },
  approveReturn: (loc: string, id: number, comment: string) => post(`/api/${loc}/returns/${id}/approve`, { comment }),
  rejectReturn: (loc: string, id: number, comment: string) => post(`/api/${loc}/returns/${id}/reject`, { comment }),
  returnPhotoUrl: (loc: string, id: number, i = 0) => `/api/${loc}/returns/${id}/photo?i=${i}`,

  // Антифрод
  writeoffs: (loc: string, status?: string) => get<WriteoffRequest[]>(`/api/${loc}/writeoff-requests${q({ status })}`),
  createWriteoff: (loc: string, batchId: number, qty: number, reason: string, comment: string, photos: File[]) => {
    const fd = new FormData();
    fd.append("batchId", String(batchId));
    fd.append("qty", String(qty));
    fd.append("reason", reason);
    if (comment) fd.append("comment", comment);
    photos.forEach((p) => fd.append("photo", p));
    return post<{ id: number; status: string; needsApproval: boolean }>(`/api/${loc}/writeoff-requests`, fd);
  },
  /** Откуда списывать: поставки (и заготовки кухни) с партиями, которые можно списать вручную. */
  writeoffSources: (loc: string) => get<WriteoffSource[]>(`/api/${loc}/writeoff-sources`),
  /** Заявка по выбранным партиям поставки: несколько продуктов — одна заявка, одно решение. */
  createWriteoffBatches: (loc: string, lines: { batchId: number; qty: number }[], reason: string, comment: string,
                          photos: File[]) => {
    const fd = new FormData();
    lines.forEach((l) => { fd.append("batchId", String(l.batchId)); fd.append("qty", String(l.qty)); });
    fd.append("reason", reason);
    if (comment) fd.append("comment", comment);
    photos.forEach((p) => fd.append("photo", p));
    return post<{ groupId: string; ids: number[]; status: string; needsApproval: boolean; costKop: number; lines: string[] }>(
      `/api/${loc}/writeoff-requests/batches`, fd);
  },
  /** Списание продукта (партии по FEFO) или блюда/напитка по техкарте — одной заявкой. */
  createWriteoffFefo: (loc: string, what: { productId: string; qty: number } | { variantId: string; portions: number },
                       reason: string, comment: string, photos: File[]) => {
    const fd = new FormData();
    Object.entries(what).forEach(([k, v]) => fd.append(k, String(v)));
    fd.append("reason", reason);
    if (comment) fd.append("comment", comment);
    photos.forEach((p) => fd.append("photo", p));
    return post<{ groupId: string; ids: number[]; status: string; needsApproval: boolean; costKop: number; lines: string[] }>(
      `/api/${loc}/writeoff-requests/fefo`, fd);
  },
  approveWriteoff: (loc: string, id: number, comment: string) =>
    post(`/api/${loc}/writeoff-requests/${id}/approve`, { comment }),
  rejectWriteoff: (loc: string, id: number, comment: string) =>
    post(`/api/${loc}/writeoff-requests/${id}/reject`, { comment }),
  writeoffPhotoUrl: (loc: string, id: number, i = 0) => `/api/${loc}/writeoff-requests/${id}/photo?i=${i}`,
  inventory: (loc: string, from?: string, to?: string) => get<InventoryCount[]>(`/api/${loc}/inventory${q({ from, to })}`),
  startInventory: (loc: string) => post<InventoryCount>(`/api/${loc}/inventory`),
  inventoryLines: (loc: string, id: number, lines: { productId: string; actual: number }[]) =>
    put<InventoryCount>(`/api/${loc}/inventory/${id}/lines`, lines),
  submitInventory: (loc: string, id: number) => post<InventoryCount>(`/api/${loc}/inventory/${id}/submit`),
  confirmInventory: (loc: string, id: number) => post<InventoryCount>(`/api/${loc}/inventory/${id}/confirm`),
  anomalies: (loc: string, status?: string, from?: string, to?: string) =>
    get<Anomaly[]>(`/api/${loc}/anomalies${q({ status, from, to })}`),
  anomaly: (loc: string, id: number) => get<AnomalyDetail>(`/api/${loc}/anomalies/${id}`),
  reviewAnomaly: (loc: string, id: number, status: string, comment: string) =>
    patch(`/api/${loc}/anomalies/${id}`, { status, comment }),
  ledger: (loc: string, params: { type?: string; product?: string; beforeSeq?: number; limit?: number }) =>
    get<LedgerRow[]>(`/api/${loc}/ledger${q(params)}`),
  verify: (loc: string) => get<Verification>(`/api/${loc}/ledger/verify`),

  // Аналитика
  /** Аналитика за период: from и to — дни «ГГГГ-ММ-ДД» включительно; без них — последние days дней. */
  writeoffAnalytics: (loc: string, days: number, from?: string, to?: string) =>
    get<WriteoffAnalytics>(`/api/${loc}/analytics/writeoffs${q({ days, from, to })}`),
  /** Прибыль за период: выручка, себестоимость, прибыль, потери, «в плюсе» — по дням и по блюдам */
  profit: (loc: string, days: number, from?: string, to?: string) =>
    get<ProfitAnalytics>(`/api/${loc}/analytics/profit${q({ days, from, to })}`),
  lossDay: (loc: string, date: string) => get<LossDay>(`/api/${loc}/analytics/writeoffs/day${q({ date })}`),
  deficit: (loc: string, days: number, from?: string, to?: string) =>
    get<DeficitRow[]>(`/api/${loc}/analytics/deficit${q({ days, from, to })}`),
  supply: (loc: string, days: number, from?: string, to?: string) =>
    get<SupplyRow[]>(`/api/${loc}/analytics/supply${q({ days, from, to })}`),

  // Прослеживаемость
  traceOrders: (loc: string, days: number, search?: string, from?: string, to?: string) =>
    get<OrderTraceRow[]>(`/api/${loc}/trace/orders${q({ days, q: search, from, to })}`),
  traceOrder: (loc: string, id: number) => get<OrderComposition>(`/api/${loc}/trace/orders/${id}`),
  tracePreps: (loc: string, days: number, from?: string, to?: string) =>
    get<PrepTrace[]>(`/api/${loc}/trace/preps${q({ days, from, to })}`),
  traceBatchDishes: (loc: string, batchId: number) => get<DishUse[]>(`/api/${loc}/trace/batches/${batchId}/dishes`),
  traceProduct: (loc: string, productId: string, days: number, from?: string, to?: string) =>
    get<ProductTrace>(`/api/${loc}/trace/products/${encodeURIComponent(productId)}${q({ days, from, to })}`),
  /** Кто что делал за период: операции по сотрудникам. */
  operationsByActor: (loc: string, p: { days?: number; from?: string; to?: string }) =>
    get<ActorOperations[]>(`/api/${loc}/trace/operations/actors${q(p)}`),
  /** Операции за период — что, откуда и куда: фильтр по сотруднику (actor), типу (type, LOSS) и продукту. */
  operations: (loc: string, p: { days?: number; from?: string; to?: string; actor?: string; type?: string; product?: string }) =>
    get<OperationsResult>(`/api/${loc}/trace/operations${q(p)}`),

  // Сигналы
  alerts: (loc: string, open = false) => get<Alert[]>(`/api/${loc}/alerts${q({ open })}`),
  ack: (loc: string, id: number) => post(`/api/${loc}/alerts/${id}/ack`),
  ackAll: (loc: string) => post(`/api/${loc}/alerts/ack-all`),

  // Каталог и админка
  catalog: () => get<Catalog>("/api/catalog"),
  saveRecipe: (variantId: string, lines: { productId: string; net: number; lossBp?: number | null }[], comment: string) =>
    put<{ newVersion: boolean }>(`/api/catalog/variants/${variantId}/recipe`, { lines, comment }),
  recipeVersions: (variantId: string) => get<RecipeVersion[]>(`/api/catalog/variants/${variantId}/versions`),
  /** Откат: новая версия с составом выбранной старой — история не переписывается. */
  restoreRecipe: (variantId: string, versionId: number, comment: string) =>
    post<{ ok: boolean; restoredFrom: number }>(`/api/catalog/variants/${variantId}/versions/${versionId}/restore`, { comment }),
  users: () => get<UserDto[]>("/api/admin/users"),
  createUser: (body: unknown) => post<{ id: number }>("/api/admin/users", body),
  /** Роль и точка сотрудника — только из админки; locationId "" — все точки. */
  updateUser: (id: number, body: { role?: string; locationId?: string; active?: boolean }) =>
    patch(`/api/admin/users/${id}`, body),
  apiKeys: () => get<{ id: number; name: string; prefix: string; scopes: string[]; revoked: boolean }[]>("/api/admin/api-keys"),
  createApiKey: (name: string, scopes: string[]) =>
    post<{ id: number; key: string }>("/api/admin/api-keys", { name, scopes }),
  revokeApiKey: (id: number) => del(`/api/admin/api-keys/${id}`),
  settings: () => get<Record<string, string>>("/api/admin/settings"),
  setSetting: (key: string, value: string) => put(`/api/admin/settings/${key}`, { value }),
  audit: () => get<AuditEntry[]>("/api/admin/audit"),
  /** Точки текущего предприятия или другого, где вы тоже админ. */
  locations: (tenantId?: number) => get<TenantLocation[]>(`/api/admin/locations${q({ tenantId })}`),
  createLocation: (name: string, openTime?: string, closeTime?: string) =>
    post<{ id: string }>("/api/admin/locations", { name, openTime, closeTime }),
  /** Несколько точек разом — все или ни одной */
  createLocations: (locations: { name: string; openTime?: string; closeTime?: string }[]) =>
    post<{ ids: string[] }>("/api/admin/locations/batch", { locations }),
  invites: (tenantId?: number) => get<Invite[]>(`/api/admin/invites${q({ tenantId })}`),
  createInvite: (role: string, locationId: string | null, note: string, tenantId?: number) =>
    post<{ id: number; token: string; expiresAt: string }>("/api/admin/invites", { role, locationId, note, tenantId }),
  revokeInvite: (id: number, tenantId?: number) => del(`/api/admin/invites/${id}${q({ tenantId })}`),

  // Демо
  demoState: () => get<DemoState>("/api/demo/state"),
  demoClock: (body: { speed?: number; paused?: boolean; advanceHours?: number; real?: boolean }) =>
    post<DemoState>("/api/demo/clock", body),
  demoGenerator: (enabled: boolean) => post<DemoState>("/api/demo/generator", { enabled }),
  demoScenario: (location: string, type: string) =>
    post<{ ok: boolean; message: string }>("/api/demo/scenario", { location, type }),
  demoReset: () => post<{ message: string }>("/api/demo/reset"),
  /** Удалить все логи (только демо-режим): confirm — слово «УДАЛИТЬ» */
  demoClean: (confirm: string, startStock: boolean) =>
    post<{ ok: boolean; message: string }>("/api/demo/clean", { confirm, startStock }),
};
