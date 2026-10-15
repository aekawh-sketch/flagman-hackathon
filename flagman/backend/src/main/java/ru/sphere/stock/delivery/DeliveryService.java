package ru.sphere.stock.delivery;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import ru.sphere.stock.alerts.AlertService;
import ru.sphere.stock.antifraud.AnomalyService;
import ru.sphere.stock.catalog.CatalogService;
import ru.sphere.stock.config.StockProperties;
import ru.sphere.stock.domain.BatchState;
import ru.sphere.stock.domain.ExpiryPolicy;
import ru.sphere.stock.domain.ProductInfo;
import ru.sphere.stock.events.StockChanged;
import ru.sphere.stock.infra.ApiException;
import ru.sphere.stock.infra.AppClock;
import ru.sphere.stock.infra.Hashing;
import ru.sphere.stock.ledger.Actor;
import ru.sphere.stock.ledger.Ledger;
import ru.sphere.stock.ledger.MovementType;
import ru.sphere.stock.stock.StockRepository;
import ru.sphere.stock.tenant.TenantDirectory;

/**
 * Поставки и приёмка (ТЗ 5.1, 16.1). Поставка приходит документом — из формы, файлом XML/JSON или
 * по API; продукты появляются на складе только после приёмки, на которой кладовщик или управляющий
 * сверяет факт с накладной и может принять поставку частично.
 */
@Service
public class DeliveryService {

    /** Строка поставки из API: срок хранения длительностью ИЛИ явная дата годности. */
    @Schema(name = "DeliveryLineIn", description = "Строка поставки")
    public record LineIn(
            @Schema(description = "ID продукта; неизвестный заводится автоматически с пометкой «проверить»", example = "salmon") String productId,
            @Schema(description = "Название в накладной", example = "Лосось") String name,
            @Schema(description = "Единица: G — граммы, ML — миллилитры, PCS — штуки", example = "G") String unit,
            @Schema(description = "Количество по накладной в базовых единицах", example = "2000") long qty,
            @Schema(description = "Срок хранения, часов (или укажите expiresAt)", example = "72") Integer shelfLifeHours,
            @Schema(description = "Явная дата годности (вместо shelfLifeHours)") Instant expiresAt,
            @Schema(description = "Сумма строки, копеек", example = "360000") Long costKop) {
    }

    @Schema(description = "Поставка")
    public record DeliveryIn(
            @Schema(description = "Уникальный идентификатор поставки — повтор с тем же id не задваивает склад", example = "SUP-2026-0042") String id,
            @Schema(description = "Номер поставки для людей", example = "П-42") String number,
            @Schema(description = "Дата создания поставки — от неё считается срок годности; может быть в прошлом (поставка задним числом)") Instant createdAt,
            @Schema(description = "Поставщик", example = "ООО «Рыбный двор»") String supplier,
            @Schema(description = "Продукты поставки") List<LineIn> lines,
            @Schema(description = "Тестовая поставка: разрешает принять уже просроченное, чтобы проверить списание просрочки. Только в демо-режиме") Boolean mock) {

        public DeliveryIn(String id, String number, Instant createdAt, String supplier, List<LineIn> lines) {
            this(id, number, createdAt, supplier, lines, null);
        }
    }

    /** Причины недоприёма строки (ТЗ 16.1, шаг 3); NOT_APPROVED ставит система — строку не одобрил управляющий. */
    public static final List<String> REJECT_REASONS = List.of("SHORTAGE", "DEFECT", "EXPIRED", "NOT_ORDERED", "OTHER");

    /** Решение управляющего по строке: сколько из накладной берём; 0 — строку не берём. */
    @Schema(description = "Одобрение строки")
    public record ApproveLine(
            @Schema(description = "Номер строки поставки", example = "1") int lineNo,
            @Schema(description = "Сколько разрешено принять; не указано — как в накладной; 0 — строку не берём", example = "8000") Long qty,
            @Schema(description = "Почему меньше", example = "Столько не заказывали") String note) {
    }

    /** Факт приёмки по строке. */
    @Schema(description = "Факт приёмки по строке")
    public record AcceptLine(
            @Schema(description = "Номер строки поставки", example = "1") int lineNo,
            @Schema(description = "Фактическое количество; не указано — как в накладной; 0 — строку не принимаем", example = "1950") Long qtyActual,
            @Schema(description = "Почему принято меньше: SHORTAGE — недовоз, DEFECT — брак, EXPIRED — просрочено, NOT_ORDERED — не заказывали, OTHER — прочее") String rejectReason,
            @Schema(description = "Комментарий к недоприёму") String comment) {

        public AcceptLine(int lineNo, Long qtyActual) {
            this(lineNo, qtyActual, null, null);
        }
    }

    @Schema(name = "DeliveryResult")
    public record Result(String id, String status, boolean duplicate, List<Long> batchIds) {
    }

    private final JdbcClient jdbc;
    private final AppClock clock;
    private final Ledger ledger;
    private final StockRepository batches;
    private final CatalogService catalog;
    private final ApplicationEventPublisher events;
    private final AlertService alerts;
    private final AnomalyService anomalies;
    private final TenantDirectory tenants;
    private final StockProperties props;

    public DeliveryService(JdbcClient jdbc, AppClock clock, Ledger ledger, StockRepository batches,
                           CatalogService catalog, ApplicationEventPublisher events, AlertService alerts,
                           AnomalyService anomalies, TenantDirectory tenants, StockProperties props) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.ledger = ledger;
        this.batches = batches;
        this.catalog = catalog;
        this.events = events;
        this.alerts = alerts;
        this.anomalies = anomalies;
        this.tenants = tenants;
        this.props = props;
    }

    @Transactional
    public Result receive(String locationId, DeliveryIn in, Actor actor, boolean autoAccept) {
        return receive(locationId, in, actor, autoAccept, "API");
    }

    /** @param channel откуда пришла: API, FORM (форма в интерфейсе), FILE (загрузка XML/JSON) */
    @Transactional
    public Result receive(String locationId, DeliveryIn in, Actor actor, boolean autoAccept, String channel) {
        validate(in);
        long tenant = tenants.tenantOf(locationId);
        boolean mock = Boolean.TRUE.equals(in.mock());
        if (mock && !props.demoMode()) {
            throw ApiException.forbidden("Тестовые поставки — только в демо-режиме");
        }
        Instant now = clock.now();
        if (in.createdAt().isAfter(now.plus(Duration.ofDays(1)))) {
            throw ApiException.badRequest("Дата создания поставки в будущем");
        }
        String payloadHash = Hashing.sha256(canonical(in));
        var existing = jdbc.sql("SELECT status, payload_hash, location_id FROM deliveries WHERE tenant_id = ? AND id = ?")
                .params(tenant, in.id())
                .query((rs, n) -> new String[]{rs.getString(1), rs.getString(2), rs.getString(3)})
                .optional();
        if (existing.isPresent()) {
            String[] e = existing.get();
            if (!e[1].equals(payloadHash) || !e[2].equals(locationId)) {
                throw ApiException.conflict("Поставка " + in.id() + " уже есть с другим содержимым");
            }
            return new Result(in.id(), e[0], true, batchIdsOf(tenant, in.id()));
        }
        jdbc.sql("""
                        INSERT INTO deliveries (tenant_id, id, location_id, number, created_at, supplier, status, payload_hash,
                                                received_at, mock, channel, api_key_id)
                        VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)""")
                .params(tenant, in.id(), locationId, in.number(), Timestamp.from(in.createdAt()), in.supplier(),
                        payloadHash, Timestamp.from(now), mock, channel == null ? "API" : channel, actor.apiKeyId())
                .update();
        boolean catalogChanged = false;
        for (int i = 0; i < in.lines().size(); i++) {
            LineIn l = in.lines().get(i);
            catalogChanged |= ensureProduct(tenant, l);
            jdbc.sql("""
                            INSERT INTO delivery_lines (tenant_id, delivery_id, line_no, product_id, name, unit, qty_invoice,
                                                        shelf_life_minutes, expires_at, cost_total_kop)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""")
                    .params(tenant, in.id(), i + 1, l.productId(), l.name(), l.unit(), l.qty(),
                            l.shelfLifeHours() == null ? null : l.shelfLifeHours() * 60,
                            l.expiresAt() == null ? null : Timestamp.from(l.expiresAt()), l.costKop())
                    .update();
        }
        if (catalogChanged) {
            catalog.invalidate(tenant);
        }
        if (autoAccept) {
            // Доверенная система с правом auto-accept (демо-генератор): одобрение и приёмка одним шагом.
            approveLines(tenant, in.id(), List.of());
            jdbc.sql("UPDATE deliveries SET status = 'APPROVED', approved_at = ? WHERE tenant_id = ? AND id = ?")
                    .params(Timestamp.from(now), tenant, in.id()).update();
            return receiveGoods(locationId, in.id(), List.of(), null, actor, true);
        }
        alerts.raise(locationId, "DELIVERY_APPROVAL", "INFO", "delivery", in.id(),
                "Поставка " + in.number() + " ждёт одобрения", (in.supplier() == null ? "" : in.supplier() + " · ")
                        + in.lines().size() + " поз.", now);
        events.publishEvent(new StockChanged(locationId, "delivery.pending"));
        return new Result(in.id(), "PENDING", false, List.of());
    }

    /**
     * Одобрение управляющим (ТЗ 16.6): что из накладной берём — целиком или частично. Строки с 0 кладовщик
     * не принимает. Больше накладной одобрить нельзя: лишнее — повод для новой поставки, а не для приёмки.
     */
    @Transactional
    public Result approve(String locationId, String deliveryId, List<ApproveLine> lines, String comment, Actor actor) {
        long tenant = tenants.tenantOf(locationId);
        var head = jdbc.sql("SELECT location_id, status FROM deliveries WHERE tenant_id = ? AND id = ? FOR UPDATE")
                .params(tenant, deliveryId)
                .query((rs, n) -> new String[]{rs.getString(1), rs.getString(2)})
                .optional().orElseThrow(() -> ApiException.notFound("Поставка"));
        if (!head[0].equals(locationId)) {
            throw ApiException.notFound("Поставка");
        }
        if (!"PENDING".equals(head[1])) {
            throw ApiException.conflict("Поставка уже не ждёт одобрения: " + head[1]);
        }
        long approved = approveLines(tenant, deliveryId, lines);
        if (approved == 0) {
            throw ApiException.badRequest("Не одобрено ни одной строки — отклоните поставку целиком");
        }
        Instant now = clock.now();
        jdbc.sql("""
                        UPDATE deliveries SET status = 'APPROVED', approved_by = ?, approved_at = ?, approval_comment = ?
                        WHERE tenant_id = ? AND id = ?""")
                .params(actor.userId(), Timestamp.from(now), comment == null || comment.isBlank() ? null : comment.trim(),
                        tenant, deliveryId)
                .update();
        jdbc.sql("""
                        UPDATE alerts SET ack_by = ?, ack_at = ? WHERE location_id = ? AND type = 'DELIVERY_APPROVAL'
                          AND object_id = ? AND ack_at IS NULL""")
                .params(actor.userId(), Timestamp.from(now), locationId, deliveryId).update();
        events.publishEvent(new StockChanged(locationId, "delivery.approved"));
        return new Result(deliveryId, "APPROVED", false, List.of());
    }

    /** @return сколько строк одобрено хотя бы частично */
    private long approveLines(long tenant, String deliveryId, List<ApproveLine> lines) {
        Map<Integer, ApproveLine> byLine = new HashMap<>();
        for (ApproveLine l : lines == null ? List.<ApproveLine>of() : lines) {
            if (l.qty() != null && l.qty() < 0) {
                throw ApiException.badRequest("Одобренное количество не может быть отрицательным");
            }
            byLine.put(l.lineNo(), l);
        }
        long count = 0;
        for (Object[] r : jdbc.sql("SELECT id, line_no, qty_invoice, name FROM delivery_lines WHERE tenant_id = ? AND delivery_id = ?")
                .params(tenant, deliveryId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getInt(2), rs.getLong(3), rs.getString(4)}).list()) {
            ApproveLine a = byLine.get((Integer) r[1]);
            long invoice = (Long) r[2];
            long qty = a != null && a.qty() != null ? a.qty() : invoice;
            if (qty > invoice) {
                throw ApiException.badRequest(r[3] + ": одобрить больше, чем в накладной, нельзя");
            }
            jdbc.sql("UPDATE delivery_lines SET approved_qty = ?, approve_note = ? WHERE id = ?")
                    .params(qty, a == null || a.note() == null || a.note().isBlank() ? null : a.note().trim(), r[0])
                    .update();
            count += qty > 0 ? 1 : 0;
        }
        return count;
    }

    /**
     * Приёмка: факт по строкам (по умолчанию = накладной), партии и движения «приход». Строку можно принять
     * частично или не принять вовсе — с причиной. Просроченное принять нельзя (кроме тестовой поставки).
     * Срок партии фиксируется здесь навсегда (ТЗ 6.6).
     */
    /**
     * Приёмка кладовщиком (ТЗ 16.6): только одобренной поставки и не тем, кто её одобрил — «четыре глаза»,
     * как у подписи списаний.
     */
    @Transactional
    public Result accept(String locationId, String deliveryId, List<AcceptLine> facts, List<String> invoicePhotos,
                         Actor actor, boolean allowShortLife) {
        long tenant = tenants.tenantOf(locationId);
        var head = jdbc.sql("SELECT status, approved_by FROM deliveries WHERE tenant_id = ? AND id = ? AND location_id = ?")
                .params(tenant, deliveryId, locationId)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getObject(2)})
                .optional().orElseThrow(() -> ApiException.notFound("Поставка"));
        if ("PENDING".equals(head[0])) {
            throw ApiException.conflict("Поставку сначала одобряет управляющий");
        }
        if (head[1] != null && actor.userId() != null && ((Number) head[1]).longValue() == actor.userId()) {
            throw ApiException.forbidden("Вы одобрили эту поставку — принимает другой сотрудник (кладовщик)");
        }
        return receiveGoods(locationId, deliveryId, facts, invoicePhotos, actor, allowShortLife);
    }

    /** Во сколько раз цена в накладной должна отличаться от обычной, чтобы её не запоминать без проверки. */
    static final double PRICE_JUMP = 10;

    /**
     * Память цены продукта (ТЗ 5.1): по ней считаются строки без суммы, закупки и демо-поставки. Цена в 10 раз
     * выше или ниже обычной — почти всегда опечатка в накладной (граммы вместо килограммов, рубли вместо копеек):
     * такую не запоминаем, иначе она расползётся по всем следующим поставкам и себестоимости блюд. Вместо этого —
     * сигнал «проверьте накладную» и отметка «цену проверить» у продукта. Партия получает сумму из накладной.
     */
    private void rememberPrice(String locationId, long tenant, ProductInfo p, double unitKop, String number, Instant now) {
        Double usual = jdbc.sql("SELECT last_unit_cost_kop FROM products WHERE tenant_id = ? AND id = ?")
                .params(tenant, p.id()).query((rs, n) -> rs.getObject(1) == null ? null : rs.getDouble(1))
                .optional().orElse(null);
        if (usual != null && usual > 0 && (unitKop > usual * PRICE_JUMP || unitKop < usual / PRICE_JUMP)) {
            jdbc.sql("UPDATE products SET needs_review = TRUE WHERE tenant_id = ? AND id = ?").params(tenant, p.id()).update();
            double times = unitKop > usual ? unitKop / usual : usual / unitKop;
            alerts.raise(locationId, "PRICE_OUTLIER", "WARN", "product", p.id(),
                    "Цена «" + p.name() + "» в поставке " + number + " в " + Math.round(times) + " раз "
                            + (unitKop > usual ? "выше" : "ниже") + " обычной",
                    "В накладной " + perUnit(p, unitKop) + ", обычно " + perUnit(p, usual)
                            + ". Похоже на опечатку в количестве или сумме — проверьте накладную. "
                            + "В справочник эта цена не записана.", now);
            return;
        }
        jdbc.sql("UPDATE products SET last_unit_cost_kop = ? WHERE tenant_id = ? AND id = ?")
                .params(unitKop, tenant, p.id()).update();
    }

    /** «1 200 ₽ за кг» — цена за понятную единицу: за кг, за л или за штуку. */
    private static String perUnit(ProductInfo p, double kopPerBase) {
        return switch (p.unit()) {
            case G -> ru.sphere.stock.domain.Money.format(Math.round(kopPerBase * 1000)) + " за кг";
            case ML -> ru.sphere.stock.domain.Money.format(Math.round(kopPerBase * 1000)) + " за л";
            case PCS -> ru.sphere.stock.domain.Money.format(Math.round(kopPerBase)) + " за шт";
        };
    }

    private Result receiveGoods(String locationId, String deliveryId, List<AcceptLine> facts, List<String> invoicePhotos,
                                Actor actor, boolean allowShortLife) {
        long tenant = tenants.tenantOf(locationId);
        var head = jdbc.sql("""
                        SELECT location_id, status, created_at, number, mock, supplier FROM deliveries
                        WHERE tenant_id = ? AND id = ? FOR UPDATE""")
                .params(tenant, deliveryId)
                .query((rs, n) -> new Object[]{rs.getString(1), rs.getString(2), rs.getTimestamp(3).toInstant(),
                        rs.getString(4), rs.getBoolean(5), rs.getString(6)})
                .optional()
                .orElseThrow(() -> ApiException.notFound("Поставка"));
        if (!head[0].equals(locationId)) {
            throw ApiException.notFound("Поставка");
        }
        if (!"APPROVED".equals(head[1])) {
            throw ApiException.conflict("Поставка не ждёт приёмки: " + head[1]);
        }
        Instant createdAt = (Instant) head[2];
        boolean mock = (Boolean) head[4];
        Map<Integer, AcceptLine> factByLine = new HashMap<>();
        for (AcceptLine f : facts) {
            if (f.qtyActual() != null && f.qtyActual() < 0) {
                throw ApiException.badRequest("Факт не может быть отрицательным");
            }
            if (f.rejectReason() != null && !REJECT_REASONS.contains(f.rejectReason())) {
                throw ApiException.badRequest("Причина недоприёма — одна из " + REJECT_REASONS);
            }
            factByLine.put(f.lineNo(), f);
        }
        Ledger.Tx tx = ledger.lock(locationId, clock.now());
        Instant now = tx.at();
        CatalogService.Snapshot cat = catalog.forLocation(locationId);
        UUID op = UUID.randomUUID();
        List<Long> created = new ArrayList<>();
        // less/more — итог по накладной (статус); doorDiff — расхождение у двери: факт не равен одобренному.
        boolean less = false, more = false, any = false, doorDiff = false;
        List<Object[]> lines = jdbc.sql("""
                        SELECT id, line_no, product_id, qty_invoice, shelf_life_minutes, expires_at, cost_total_kop,
                               approved_qty, name
                        FROM delivery_lines WHERE tenant_id = ? AND delivery_id = ? ORDER BY line_no""")
                .params(tenant, deliveryId)
                .query((rs, n) -> new Object[]{rs.getLong(1), rs.getInt(2), rs.getString(3), rs.getLong(4),
                        rs.getObject(5), rs.getTimestamp(6), rs.getObject(7), rs.getObject(8), rs.getString(9)})
                .list();
        for (Object[] l : lines) {
            long lineId = (Long) l[0];
            int lineNo = (Integer) l[1];
            String pid = (String) l[2];
            long invoice = (Long) l[3];
            long allowed = l[7] == null ? invoice : ((Number) l[7]).longValue();
            AcceptLine f = factByLine.get(lineNo);
            long actual = allowed == 0 ? 0 : f != null && f.qtyActual() != null ? f.qtyActual() : allowed;
            if (actual > allowed && allowed < invoice) {
                throw ApiException.badRequest(l[8] + ": управляющий одобрил не больше " + allowed + " — больше принять нельзя");
            }
            String reason = null;
            doorDiff |= allowed > 0 && actual != allowed;
            if (allowed == 0) {
                less = true;
                reason = "NOT_APPROVED";
            } else if (actual < invoice) {
                less = true;
                // Старые клиенты API присылают только факт — меньше накладной без причины значит недовоз.
                reason = f != null && f.rejectReason() != null ? f.rejectReason()
                        : actual == allowed ? "NOT_APPROVED" : "SHORTAGE";
            } else if (actual > invoice) {
                more = true;
            }
            jdbc.sql("UPDATE delivery_lines SET qty_actual = ?, reject_reason = ?, reject_comment = ? WHERE id = ?")
                    .params(actual, reason, f == null || f.comment() == null || f.comment().isBlank() ? null
                            : f.comment().trim(), lineId)
                    .update();
            if (actual == 0) {
                continue;
            }
            any = true;
            ProductInfo p = cat.product(pid);
            Instant expiresAt = l[5] != null ? ((Timestamp) l[5]).toInstant()
                    : createdAt.plus(Duration.ofMinutes(((Number) l[4]).longValue()));
            boolean expired = !expiresAt.isAfter(now);
            if (expired && !mock) {
                throw new ApiException(HttpStatus.valueOf(422), "Нельзя принять просроченное: " + p.name()
                        + " (строка " + lineNo + "). Не принимайте строку — причина «просрочено»",
                        Map.of("lineNo", lineNo));
            }
            if (p.packSize() != null && actual % p.packSize() != 0) {
                throw ApiException.badRequest(p.name() + ": факт должен быть кратен упаковке " + p.format(p.packSize()));
            }
            long cost = costOf(l[6], invoice, actual, cat, pid);
            BatchState probe = new BatchState(0, pid, actual, 0, createdAt, expiresAt, now, false, false, cost, actual);
            if (!expired && !allowShortLife && probe.timeLeft(now).compareTo(ExpiryPolicy.soonWindow(probe, p)) <= 0) {
                throw new ApiException(HttpStatus.PRECONDITION_REQUIRED,
                        p.name() + " скоро истекает — подтвердите приёмку", Map.of("lineNo", lineNo));
            }
            long batchId = batches.insert(new StockRepository.NewBatch(locationId, pid, "DELIVERY", lineId, null, op,
                    actual, cost, createdAt, expiresAt, now, false, "П"));
            tx.append(MovementType.RECEIPT, batchId, actual, cost, actor, mock ? "Тестовая поставка" : null,
                    "delivery", deliveryId, op, null);
            created.add(batchId);
            if (cost > 0) {
                rememberPrice(locationId, tenant, p, (double) cost / actual, (String) head[3], now);
            }
        }
        String status = !any ? "REJECTED" : less ? "PARTIAL" : more ? "ACCEPTED_DIFF" : "ACCEPTED";
        jdbc.sql("""
                        UPDATE deliveries SET status = ?, accepted_by = ?, accepted_at = ?, invoice_photo = ?,
                                              invoice_photos = ?
                        WHERE tenant_id = ? AND id = ?""")
                .params(status, actor.userId(), Timestamp.from(now),
                        invoicePhotos == null || invoicePhotos.isEmpty() ? null : invoicePhotos.getFirst(),
                        invoicePhotos == null ? new String[0] : invoicePhotos.toArray(String[]::new), tenant, deliveryId)
                .update();
        // Урезал управляющий — это решение, а не расхождение: сигнал и правило A8 — только за разницу у двери.
        if (doorDiff) {
            alerts.raise(locationId, "DELIVERY_DIFF", "WARN", "delivery", deliveryId,
                    (more ? "Излишек при приёмке: " : "Недовоз при приёмке: ") + head[3],
                    more ? "Факт больше накладной" : "Факт меньше одобренного — см. причины в поставке", now);
            anomalies.onDeliveryDiff(locationId, deliveryId, actor.userId(), (String) head[5]);
        }
        events.publishEvent(new StockChanged(locationId, "delivery.accepted"));
        return new Result(deliveryId, status, false, created);
    }

    /** Отказ целиком: управляющий — вместо одобрения, кладовщик — у двери (машина без холодильника и т. п.). */
    @Transactional
    public void reject(String locationId, String deliveryId, String comment, Actor actor) {
        reject(locationId, deliveryId, comment, actor, false);
    }

    /**
     * @param onlyPending отклонить можно только поставку на одобрении — так решает админ: одобрить или отклонить
     *                    накладную он вправе, а у двери принимает и отклоняет кладовщик или управляющий (ТЗ 6.2)
     */
    public void reject(String locationId, String deliveryId, String comment, Actor actor, boolean onlyPending) {
        int n = jdbc.sql("""
                        UPDATE deliveries SET status = 'REJECTED', accepted_by = ?, accepted_at = ?, reject_comment = ?
                        WHERE tenant_id = ? AND id = ? AND location_id = ?
                          AND (status = 'PENDING' OR (status = 'APPROVED' AND NOT ?))""")
                .params(actor.userId(), Timestamp.from(clock.now()), comment == null || comment.isBlank() ? null
                        : comment.trim(), tenants.tenantOf(locationId), deliveryId, locationId, onlyPending)
                .update();
        if (n == 0) {
            throw onlyPending
                    ? ApiException.forbidden("Админ отклоняет только поставку на одобрении — у двери решает кладовщик или управляющий")
                    : ApiException.conflict("Поставка не ожидает приёмки");
        }
        events.publishEvent(new StockChanged(locationId, "delivery.rejected"));
    }

    /** Сумма строки: из накладной пропорционально факту, иначе последняя известная цена (ТЗ 5.1). */
    private static long costOf(Object lineCost, long invoice, long actual, CatalogService.Snapshot cat, String pid) {
        if (lineCost != null) {
            return Math.round(((Number) lineCost).doubleValue() * actual / invoice);
        }
        CatalogService.ProductExtra ex = cat.extra(pid);
        return ex != null && ex.lastUnitCostKop() != null ? Math.round(ex.lastUnitCostKop() * actual) : 0;
    }

    /**
     * Неизвестный продукт заводится автоматически с пометкой «проверить» (ТЗ 5.1). Известный должен прийти
     * в той же единице, что в карточке: 5000 «штук» молока вместо 5000 мл испортили бы склад.
     */
    private boolean ensureProduct(long tenant, LineIn l) {
        String unit = jdbc.sql("SELECT unit FROM products WHERE tenant_id = ? AND id = ?").params(tenant, l.productId())
                .query(String.class).optional().orElse(null);
        if (unit != null) {
            if (!unit.equals(l.unit())) {
                throw ApiException.badRequest(l.name() + ": единица " + l.unit() + ", а в карточке продукта — " + unit);
            }
            return false;
        }
        jdbc.sql("INSERT INTO products (tenant_id, id, name, unit, needs_review) VALUES (?, ?, ?, ?, TRUE)")
                .params(tenant, l.productId(), l.name(), l.unit())
                .update();
        return true;
    }

    private List<Long> batchIdsOf(long tenant, String deliveryId) {
        return jdbc.sql("SELECT b.id FROM batches b JOIN delivery_lines l ON l.id = b.delivery_line_id "
                        + "WHERE l.tenant_id = ? AND l.delivery_id = ? ORDER BY b.id")
                .params(tenant, deliveryId).query(Long.class).list();
    }

    private static void validate(DeliveryIn in) {
        if (in.id() == null || in.id().isBlank() || in.number() == null || in.number().isBlank() || in.createdAt() == null) {
            throw ApiException.badRequest("Нужны id, number и createdAt поставки");
        }
        if (in.lines() == null || in.lines().isEmpty()) {
            throw ApiException.badRequest("В поставке нет продуктов");
        }
        for (LineIn l : in.lines()) {
            if (l.productId() == null || l.productId().isBlank() || l.name() == null || l.name().isBlank() || l.qty() <= 0) {
                throw ApiException.badRequest("В строке нужны productId, name и qty > 0");
            }
            if (l.unit() == null || !List.of("G", "ML", "PCS").contains(l.unit())) {
                throw ApiException.badRequest("unit — G, ML или PCS");
            }
            if (l.shelfLifeHours() == null && l.expiresAt() == null) {
                throw ApiException.badRequest(l.name() + ": нужен срок хранения (shelfLifeHours) или дата годности (expiresAt)");
            }
            if (l.shelfLifeHours() != null && l.shelfLifeHours() <= 0) {
                throw ApiException.badRequest(l.name() + ": срок хранения должен быть больше нуля");
            }
            if (l.expiresAt() != null && !l.expiresAt().isAfter(in.createdAt())) {
                throw ApiException.badRequest(l.name() + ": дата годности раньше даты поставки");
            }
        }
    }

    private static String canonical(DeliveryIn in) {
        StringBuilder sb = new StringBuilder();
        sb.append(in.id()).append('|').append(in.number()).append('|').append(in.createdAt()).append('|')
                .append(in.supplier());
        for (LineIn l : in.lines()) {
            sb.append('|').append(l.productId()).append(',').append(l.qty()).append(',').append(l.unit()).append(',')
                    .append(l.shelfLifeHours()).append(',').append(l.expiresAt()).append(',').append(l.costKop());
        }
        if (Boolean.TRUE.equals(in.mock())) {
            sb.append("|mock");
        }
        return sb.toString();
    }
}
