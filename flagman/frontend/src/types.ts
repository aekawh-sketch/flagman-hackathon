// Типы ответов API (зеркало DTO бэкенда).

export type Role = "COOK" | "CASHIER" | "STOREKEEPER" | "MANAGER" | "ADMIN";
export type BatchStatus = "FRESH" | "SOON" | "CRITICAL" | "EXPIRED";

/** Членство: в каком предприятии и с какой ролью работает человек (ТЗ 16.4). */
export interface Membership {
  tenantId: number;
  tenantName: string;
  role: Role;
  locationId: string | null;
}

export interface Me {
  kind: "USER" | "API";
  id: number;
  login: string;
  name: string;
  /** NONE — человек ещё ни в одном предприятии */
  role: Role | "NONE";
  locationId: string | null;
  tenantId: number;
  tenantName: string | null;
  tenants: Membership[];
  /** Администратор платформы — над всеми предприятиями, отдельно от ролей внутри них */
  platformAdmin: boolean;
}

export interface LocationDto {
  id: string;
  name: string;
  publicKey: string;
}

export interface AppConfig {
  restaurantName: string;
  demoMode: boolean;
  seedStatus: string;
  locations: LocationDto[];
  clock: { now: string; mode: "REAL" | "SIM"; speed: number; paused: boolean };
  tenantId: number;
  /** Открытая регистрация без приглашения */
  registrationOpen: boolean;
  /** Всегда APPROVAL: предприятия создаёт только администратор платформы — сам или одобрив заявку (ТЗ 16.14) */
  tenantCreation: "APPROVAL";
  /** Адрес кассы — панели ресторана, куда входит кассир (своим логином и паролем) */
  posUrl: string;
}

export interface Kpis {
  stockValueKop: number;
  soonBatches: number;
  criticalBatches: number;
  inStop: number;
  low: number;
  lossesTodayKop: number;
  refusalsToday: number;
  ordersToday: number;
  revenueTodayKop: number;
  openAlerts: number;
  pendingWriteoffs: number;
  /** Ждут одобрения управляющего */
  pendingDeliveries: number;
  /** Одобрены — ждут приёмки кладовщиком */
  approvedDeliveries: number;
  /** Партии под списанием: срок истёк, остаток ещё числится */
  expiredBatches: number;
  expiredKop: number;
}

export interface Verification {
  locationId: string;
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  headHash: string;
}

export interface Dashboard {
  kpis: Kpis;
  integrity: Verification;
}

export interface ProductStock {
  productId: string;
  name: string;
  unit: string;
  kind: "RAW" | "SEMI";
  category: string | null;
  available: number;
  availableText: string;
  soon: number;
  critical: number;
  expired: number;
  blocked: number;
  held: number;
  valueKop: number;
  daysOfCover: number | null;
  nearestExpiry: string | null;
  worstStatus: BatchStatus | null;
  batches: number;
  needsReview: boolean;
}

export interface BatchDto {
  id: number;
  label: string;
  productId: string;
  productName: string;
  unit: string;
  source: "DELIVERY" | "PRODUCTION" | "OPENING" | "SURPLUS";
  deliveryNumber: string | null;
  qtyLeft: number;
  qtyInitial: number;
  qtyText: string;
  /** сколько было при приёмке — тем же форматом, что остаток */
  qtyInitialText: string;
  held: number;
  receivedAt: string;
  expiresAt: string;
  baseDate: string;
  status: BatchStatus;
  hoursLeft: number;
  lifeLeftShare: number;
  opened: boolean;
  blocked: boolean;
  blockReason: string | null;
  unitCostKop: number;
  parentBatchId: number | null;
}

export interface MovementDto {
  id: number;
  seq: number;
  type: string;
  typeTitle: string;
  qty: number;
  qtyText: string;
  costKop: number;
  at: string;
  actor: string;
  reason: string | null;
  docType: string | null;
  docId: string | null;
}

export interface TraceOrder {
  orderId: number;
  number: number;
  status: string;
  at: string;
  qty: number;
  qtyText: string;
}

export interface Trace {
  batchId: number;
  label: string;
  productId: string;
  productName: string;
  source: string;
  deliveryId: string | null;
  deliveryNumber: string | null;
  supplier: string | null;
  parentBatchId: number | null;
  movements: MovementDto[];
  orders: TraceOrder[];
  derived: { batchId: number; label: string; productName: string; source: string; qty: number; qtyText: string }[];
  ordersViaDerived: TraceOrder[];
}

// ── Прослеживаемость ──

export interface IngredientTake {
  batchId: number;
  label: string;
  source: "DELIVERY" | "PRODUCTION" | "OPENING" | "SURPLUS" | null;
  deliveryNumber: string | null;
  supplier: string | null;
  producedAt: string | null;
  parentLabel: string | null;
  qty: number;
  qtyText: string;
  costKop: number;
  madeFrom: IngredientPart[];
}

export interface IngredientPart {
  productId: string;
  productName: string;
  semi: boolean;
  qty: number;
  qtyText: string;
  costKop: number;
  batches: IngredientTake[];
}

export interface DishComposition {
  lineNo: number;
  variantId: string;
  name: string;
  qty: number;
  priceKop: number;
  costKop: number;
  recipeVersion: number | null;
  parts: IngredientPart[];
}

export interface OrderComposition {
  id: number;
  number: number;
  status: string;
  source: string;
  at: string;
  createdBy: string | null;
  totalKop: number;
  costKop: number;
  dishes: DishComposition[];
  unassigned: IngredientPart[];
}

export interface OrderTraceRow {
  id: number;
  number: number;
  status: string;
  source: string;
  at: string;
  totalKop: number;
  costKop: number;
  dishes: string[];
}

export interface DishUse {
  variantId: string;
  name: string;
  portions: number;
  orders: number;
  qty: number;
  qtyText: string;
  costKop: number;
  via: string | null;
}

export interface PrepTrace {
  batchId: number;
  label: string;
  productId: string;
  productName: string;
  at: string;
  cook: string;
  qty: number;
  qtyText: string;
  costKop: number;
  expiresAt: string;
  left: number;
  leftText: string;
  toOrders: number;
  toOrdersText: string;
  orders: number;
  lost: number;
  lostText: string;
  parts: IngredientPart[];
}

export interface ProductTrace {
  productId: string;
  productName: string;
  semi: boolean;
  days: number;
  toDishes: number;
  toDishesText: string;
  toPreps: number;
  toPrepsText: string;
  lost: number;
  lostText: string;
  dishes: DishUse[];
  preps: { batchId: number; label: string; productName: string; at: string; qty: number; qtyText: string; costKop: number }[];
  orders: { orderId: number; number: number; at: string; dish: string; qty: number; qtyText: string; via: string | null }[];
}

export interface VariantStatus {
  variantId: string;
  dishId: string;
  name: string;
  label: string | null;
  category: string | null;
  priceKop: number;
  isSet: boolean;
  tracked: boolean;
  portions: number;
  inStop: boolean;
  low: boolean;
  limitingProductId: string | null;
  limitingProductName: string | null;
  hint: string | null;
}

export interface HotOffer {
  rank: number;
  variantId: string;
  name: string;
  priceKop: number;
  portions: number;
  score: number;
  productId: string;
  productName: string;
  atRiskText: string;
  hoursLeft: number;
  lossKop: number;
  explanation: string;
}

export interface HotOffersResult {
  computedAt: string;
  offers: HotOffer[];
  error: string | null;
}

export interface StopEta {
  variantId: string;
  variantName: string;
  at: string;
  productId: string;
  productName: string;
  cause: "CONSUMED" | "EXPIRED";
  text: string;
}

export interface PurchaseDto {
  productId: string;
  productName: string;
  unit: string;
  orderQty: number;
  orderText: string;
  availableQty: number;
  availableText: string;
  survives: number;
  expiresBefore: number;
  dailyRate: number;
  dailyText: string;
  leadDays: number;
  cappedByLife: boolean;
  noData: boolean;
  estCostKop: number;
  explanation: string;
}

export interface SurplusDto {
  productId: string;
  productName: string;
  atRisk: number;
  atRiskText: string;
  lossKop: number;
  hoursLeft: number;
}

export interface PurchasesResult {
  computedAt: string;
  toOrder: PurchaseDto[];
  doNotOrder: SurplusDto[];
}

export interface Alert {
  id: number;
  type: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  objectType: string;
  objectId: string;
  title: string;
  body: string | null;
  createdAt: string;
  ackBy: number | null;
  ackAt: string | null;
}

export interface OrderLineDto {
  variantId: string;
  name: string;
  qty: number;
  priceKop: number;
}

export interface OrderDto {
  id: number;
  number: number;
  externalId: string;
  source: string;
  status: string;
  createdAt: string;
  createdBy: string | null;
  totalKop: number;
  costKop: number;
  cancelReason: string | null;
  canceledBy: string | null;
  lines: OrderLineDto[];
}

export interface Alternative {
  variantId: string;
  name: string;
  portions: number;
  priceKop: number;
  hot: boolean;
}

export interface Refusal {
  message: string;
  shortages: {
    productId: string;
    productName: string;
    needText: string;
    availableText: string;
    byLines: string[];
  }[];
  maxima: { variantId: string; variantName: string; requested: number; max: number }[];
  alternatives: Alternative[];
}

export type RejectReason = "SHORTAGE" | "DEFECT" | "EXPIRED" | "NOT_ORDERED" | "NOT_APPROVED" | "OTHER";

export interface DeliveryLineDto {
  lineNo: number;
  productId: string;
  name: string;
  unit: string;
  qtyInvoice: number;
  qtyActual: number | null;
  qtyText: string;
  qtyActualText: string | null;
  shelfLifeHours: number | null;
  expiresAt: string;
  costKop: number | null;
  /** Статус срока на сейчас — система сроков работает уже при приёмке */
  expiryStatus: BatchStatus;
  hoursLeft: number;
  rejectReason: RejectReason | null;
  rejectComment: string | null;
  /** Сколько одобрил управляющий; null — ещё не одобряли; 0 — строку не берём */
  approvedQty: number | null;
  approvedQtyText: string | null;
  approveNote: string | null;
  /** Партия, которая появилась на складе из этой строки при приёмке */
  batchId: number | null;
  batchLabel: string | null;
  batchLeftText: string | null;
}

export interface DeliveryDto {
  id: string;
  number: string;
  createdAt: string;
  supplier: string | null;
  status: string;
  receivedAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  mock: boolean;
  channel: "API" | "FORM" | "FILE";
  rejectComment: string | null;
  approvedById: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalComment: string | null;
  hasInvoicePhoto: boolean;
  invoicePhotoCount: number;
  lines: DeliveryLineDto[];
}

/** Строка новой поставки (форма → тот же API, что у внешних систем). */
export interface DeliveryLineIn {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  shelfLifeHours?: number | null;
  expiresAt?: string | null;
  costKop?: number | null;
}

export interface DeliveryIn {
  id: string;
  number: string;
  createdAt: string;
  supplier?: string | null;
  lines: DeliveryLineIn[];
  mock?: boolean;
}

export interface DeliveryResult {
  id: string;
  status: string;
  duplicate: boolean;
  batchIds: number[];
}

/** Партия под списанием: срок истёк, списать должен человек (ТЗ 16.1). */
export interface ExpiredBatch {
  batchId: number;
  label: string;
  productId: string;
  productName: string;
  qty: number;
  qtyText: string;
  costKop: number;
  expiredAt: string;
  hoursAgo: number;
}

/** «Поставлено — съедено — просрочено» по продукту. */
export interface SupplyRow {
  productId: string;
  productName: string;
  unit: string;
  received: number;
  receivedText: string;
  consumed: number;
  consumedText: string;
  expired: number;
  expiredText: string;
  expiredKop: number;
  otherLoss: number;
  otherLossText: string;
  left: number;
  leftText: string;
  deliveries: number;
  expiredShare: number;
  advice: string;
  adviceLevel: "ok" | "info" | "warn" | "bad";
}

export interface TenantLocation {
  id: string;
  name: string;
  openTime: string;
  closeTime: string;
  publicKey: string;
}

export interface Invite {
  id: number;
  role: Role;
  locationId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: "ACTIVE" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  acceptedBy: string | null;
}

export interface InviteInfo {
  tenantName: string;
  role: Role;
  locationName: string | null;
  invitedBy: string;
  expiresAt: string;
  status: Invite["status"];
}

export interface WriteoffRequest {
  id: number;
  batchId: number;
  batchLabel: string;
  productId: string;
  productName: string;
  qty: number;
  qtyText: string;
  reason: "SPOILED" | "DAMAGED" | "OTHER";
  comment: string | null;
  hasPhoto: boolean;
  /** Сколько фото у заявки: их может быть несколько */
  photoCount: number;
  costKop: number;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  status: "PENDING" | "EXECUTED" | "REJECTED";
  decidedByName: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  leftPercent: number;
  /** Групповая заявка: напиток по техкарте или продукт из нескольких партий — одна подпись на всю группу */
  groupId: string | null;
  dishVariantId: string | null;
  dishName: string | null;
  dishQty: number | null;
  /** Из какой поставки партия (для вскрытой — поставка исходной упаковки); null — заготовка или излишек */
  deliveryNumber: string | null;
}

/** Откуда списывать: поставка (или заготовки кухни, излишки пересчёта) и её партии, которые можно списать вручную */
export interface WriteoffSource {
  kind: "DELIVERY" | "PRODUCTION" | "SURPLUS";
  deliveryId: string | null;
  number: string;
  supplier: string | null;
  at: string | null;
  lines: { batchId: number; label: string; productId: string; productName: string; unit: "G" | "ML" | "PCS";
    opened: boolean; available: number; availableText: string; expiresAt: string }[];
}

export interface InventoryLine {
  productId: string;
  productName: string;
  unit: string;
  expected: number;
  actual: number;
  diff: number;
  expectedText: string;
  actualText: string;
  diffText: string;
  diffKop: number;
}

export interface InventoryCount {
  id: number;
  startedAt: string;
  startedBy: string;
  status: "OPEN" | "AWAITING_APPROVAL" | "CONFIRMED" | "CANCELED";
  confirmedBy: string | null;
  confirmedAt: string | null;
  diffKop: number | null;
  lines: InventoryLine[];
}

export interface Anomaly {
  id: number;
  rule: string;
  ruleTitle: string;
  actorId: number | null;
  actorName: string | null;
  detectedAt: string;
  title: string;
  evidence: string;
  status: "NEW" | "REVIEWED" | "CONFIRMED" | "FALSE";
  comment: string | null;
  reviewedBy: string | null;
}

/** Подробности подозрительной операции: как сработало правило, цифры, заявки, отмены, куда перейти */
export interface AnomalyDetail {
  anomaly: Anomaly;
  ruleHow: string;
  facts: { label: string; value: string }[];
  writeoffs: { id: number; batchId: number; batchLabel: string; productName: string; qtyText: string; costKop: number;
    reason: string; comment: string | null; status: "PENDING" | "EXECUTED" | "REJECTED"; createdAt: string;
    hasPhoto: boolean; photoCount: number; leftPercent: number; deliveryId: string | null; deliveryNumber: string | null }[];
  orders: { id: number; number: number; canceledAt: string; reason: string | null; costKop: number }[];
  /** to — путь внутри точки: batches/12, acceptance?delivery=ID, writeoffs?status=ALL, recipes, inventory */
  links: { label: string; to: string }[];
}

export interface LedgerRow {
  id: number;
  seq: number;
  at: string;
  type: string;
  typeTitle: string;
  batchId: number;
  batchLabel: string;
  productName: string;
  qty: number;
  qtyText: string;
  costKop: number;
  actor: string;
  reason: string | null;
  docType: string | null;
  docId: string | null;
  hash: string;
}

export interface NamedValue {
  key: string;
  name: string;
  valueKop: number;
  qty: number;
  qtyText: string | null;
  count: number;
}

export interface WriteoffAnalytics {
  days: number;
  totalKop: number;
  purchasesKop: number;
  lossShare: number;
  byReason: NamedValue[];
  byProduct: NamedValue[];
  byEmployee: NamedValue[];
  byDay: { day: string; valueKop: number }[];
  /** Период ответа: дни «ГГГГ-ММ-ДД» включительно */
  from: string;
  to: string;
}

/** Один день потерь (клик по столбцу графика): каждое списание с автором и подписью. */
export interface LossEntry {
  at: string;
  type: string;
  reason: string;
  batchId: number;
  batchLabel: string;
  productName: string;
  qty: number;
  qtyText: string;
  costKop: number;
  author: string | null;
  signedBy: string | null;
  comment: string | null;
  requestId: number | null;
}

export interface LateCancel {
  orderId: number;
  number: number;
  at: string;
  costKop: number;
  canceledBy: string | null;
  reason: string | null;
}

export interface LossDay {
  date: string;
  totalKop: number;
  byReason: NamedValue[];
  entries: LossEntry[];
  lateCancels: LateCancel[];
}

export interface DeficitRow {
  productId: string;
  productName: string;
  refusals: number;
  stopEvents: number;
  stopHours: number;
  lostRevenueKop: number;
}

export interface ClockState {
  mode: "REAL" | "SIM";
  speed: number;
  paused: boolean;
}

export interface DemoState {
  clock: ClockState;
  now: string;
  generator: boolean;
  seed: string;
  scenarios: string[];
}

export interface CatalogLine {
  productId: string;
  productName: string;
  unit: string;
  net: number;
  gross: number;
  lossBp: number | null;
}

export interface CatalogProduct {
  id: string;
  name: string;
  unit: string;
  kind: "RAW" | "SEMI";
  category: string | null;
  packSize: number | null;
  afterOpenHours: number | null;
  lossBp: number;
  alertBeforeHours: number | null;
  shelfLifeHours: number | null;
  leadTimeHours: number | null;
  unitCostKop: number | null;
  needsReview: boolean;
  semiYield: number | null;
  semiLines: CatalogLine[] | null;
}

export interface CatalogVariant {
  id: string;
  name: string;
  label: string | null;
  priceKop: number;
  isSet: boolean;
  recipeVersionId: number;
  lines: CatalogLine[];
  setItems: { variantId: string; name: string; qty: number }[];
}

export interface CatalogDish {
  id: string;
  name: string;
  category: string;
  description: string | null;
  variants: CatalogVariant[];
}

/** Версия техкарты с составом: действующая (ACTIVE) или в архиве (ARCHIVED) */
export interface RecipeVersion {
  id: number;
  version: number;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  createdAt: string;
  author: string | null;
  comment: string | null;
  lines: CatalogLine[];
}

export interface Catalog {
  products: CatalogProduct[];
  dishes: CatalogDish[];
}

export interface UserDto {
  id: number;
  login: string | null;
  name: string;
  role: Role;
  locationId: string | null;
  active: boolean;
  hasPin: boolean;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actorId: number | null;
  actorName: string | null;
  action: string;
  details: string;
}

// ── Возврат поставщику ──

export type ReturnReason = "DEFECT" | "WRONG_ITEM" | "SHORT_LIFE" | "DAMAGED_PACK" | "QUALITY" | "OTHER";

/** Что из принятой поставки ещё можно вернуть: остаток партии минус удержанное заявками */
export interface ReturnableLine {
  lineNo: number;
  productId: string;
  productName: string;
  unit: "G" | "ML" | "PCS";
  batchId: number;
  batchLabel: string;
  opened: boolean;
  available: number;
  availableText: string;
  availableCostKop: number;
  expiresAt: string;
}

export interface SupplierReturn {
  id: number;
  deliveryId: string;
  deliveryNumber: string;
  supplier: string | null;
  reason: ReturnReason;
  reasonText: string;
  comment: string | null;
  photoCount: number;
  costKop: number;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  status: "PENDING" | "EXECUTED" | "REJECTED";
  decidedByName: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  lines: { batchId: number; batchLabel: string; productId: string; productName: string; qty: number; qtyText: string; costKop: number }[];
}

// ── Операции за период (аналитика → подробности) ──

/** Движение журнала с документом-источником: поставка, заказ, заготовка, заявка на списание, возврат */
export interface Operation {
  id: number;
  at: string;
  type: string;
  typeTitle: string;
  productId: string;
  productName: string;
  qty: number;
  qtyText: string;
  costKop: number;
  actor: string;
  /** Автор заявки на списание, если списал (подписал) другой */
  author: string | null;
  batchId: number;
  batchLabel: string;
  docType: string | null;
  docId: string | null;
  docLabel: string | null;
  reason: string | null;
}

export interface OperationsResult {
  from: string;
  to: string;
  count: number;
  summary: { type: string; title: string; count: number; costKop: number }[];
  items: Operation[];
}

/** Сколько и каких операций у сотрудника за период; actor — ID или system */
export interface ActorOperations {
  actor: string;
  name: string;
  count: number;
  costKop: number;
  types: { type: string; title: string; count: number; costKop: number }[];
}

/** Итог импорта меню: сколько продуктов, блюд, вариантов и новых версий техкарт */
export interface CatalogImportResult {
  products: number;
  dishes: number;
  variants: number;
  newRecipeVersions: number;
}

// ── Платформа: регистрация, предприятия, заявки ──

export interface TenantRequest {
  id: number;
  userId: number;
  userName: string;
  userLogin: string;
  name: string;
  locationName: string | null;
  comment: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
  createdAt: string;
  decidedBy: string | null;
  /** CONSOLE — в админке платформы, API — из внешней системы (CRM) */
  decidedVia: "CONSOLE" | "API" | null;
  decidedAt: string | null;
  decisionComment: string | null;
  tenantId: number | null;
}

/** Заявка на предприятие: PENDING — ждёт администратора платформы; CREATED — создал сам администратор платформы */
export interface CreateTenantResult {
  status: "CREATED" | "PENDING";
  me: Me;
  request: TenantRequest | null;
}

export interface PlatformTenant {
  id: number;
  name: string;
  createdAt: string | null;
  /** Владелец — админ предприятия: создал сам или пришёл по ссылке владельца (не платформа-создатель) */
  owner: string | null;
  /** Владельца ещё нет, но ссылка с ролью «Админ» выпущена и ждёт */
  ownerInvited: boolean;
  members: number;
  locations: number;
  /** Демо-предприятие — пилот ИСТОК: удалить нельзя */
  demo: boolean;
}

/** Удалённое предприятие — след на уровне платформы (аудит самого предприятия удаляется вместе с ним). */
export interface TenantDeletion {
  id: number;
  tenantId: number;
  name: string;
  owner: string | null;
  reason: string | null;
  stats: Record<string, number>;
  deletedBy: string | null;
  deletedVia: "CONSOLE" | "API";
  deletedAt: string;
}

export interface PlatformSettings {
  tenantCreation: "APPROVAL";
  registrationOpen: boolean;
}

/** Строка чека на кухню: блюдо, количество и (у сета) входящие блюда */
export interface KitchenTicketLine {
  name: string;
  qty: number;
  items: KitchenTicketLine[];
}

/** Чек на кухню (ТЗ 16.15): что пробили и куда ушла печать */
export interface KitchenTicket {
  id: number;
  orderId: number;
  orderNumber: number;
  source: string | null;
  createdAt: string;
  lines: KitchenTicketLine[];
  /** QUEUED — ждёт печати, PRINTED — напечатан, SHOWN — на экране кухни, FAILED — принтер не ответил */
  status: "QUEUED" | "PRINTED" | "SHOWN" | "FAILED";
  printer: string | null;
  attempts: number;
  printedAt: string | null;
  error: string | null;
}

/** Принтер кухни точки */
export interface KitchenPrinter {
  locationId: string;
  /** OFF — не печатать; SCREEN — экран кухни; NETWORK — сетевой термопринтер ESC/POS */
  mode: "OFF" | "SCREEN" | "NETWORK";
  host: string | null;
  port: number;
  paperMm: 58 | 80;
  copies: number;
}

export interface PrintResult {
  status: KitchenTicket["status"];
  printer: string;
  error: string | null;
}

/** Прибыль за день */
export interface ProfitDay {
  date: string;
  revenueKop: number;
  grossKop: number;
  lossesKop: number;
  netKop: number;
}

/** Прибыль по блюду: себестоимость — из партий, ушедших в его порции; variantId null — неразложимый остаток */
export interface DishProfit {
  variantId: string | null;
  name: string;
  qty: number;
  revenueKop: number;
  costKop: number;
  profitKop: number;
  margin: number;
}

/** Прибыль точки за период: прибыль = выручка − себестоимость; «в плюсе» = прибыль − потери */
export interface ProfitAnalytics {
  days: number;
  orders: number;
  revenueKop: number;
  costKop: number;
  grossKop: number;
  lossesKop: number;
  netKop: number;
  grossShare: number;
  netShare: number;
  byDay: ProfitDay[];
  byDish: DishProfit[];
}

