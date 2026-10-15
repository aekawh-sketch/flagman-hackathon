/** Сигналы, на которые управляющий или админ отвечает «одобрить или нет». */
export const APPROVAL_ALERTS = ["WRITEOFF_PENDING", "RETURN_PENDING", "DELIVERY_APPROVAL", "INVENTORY_APPROVAL"];

/**
 * Куда ведёт сигнал — путь внутри точки: партия, поставка, заявка, заказ, подозрительная операция.
 * null — у сигнала нет своего места (тогда его просто отмечают «увидел»).
 */
export function alertPath(a: { type?: string; objectType?: string; objectId?: string }): string | null {
  const id = a.objectId ? encodeURIComponent(a.objectId) : "";
  switch (a.type) {
    case "WRITEOFF_PENDING": return "writeoffs";
    case "RETURN_PENDING": return "writeoffs?tab=returns";
    case "DELIVERY_APPROVAL":
    case "DELIVERY_DIFF": return id ? `acceptance?delivery=${id}` : "acceptance";
    case "INVENTORY_APPROVAL": return "inventory";
    case "LATE_CANCEL": return id ? `trace?order=${id}` : "trace";
    case "STOP_IN":
    case "ORDER_REFUSED": return "menu";
    case "PRINTER_FAILED": return "kitchen";
    case "PRICE_OUTLIER": return "acceptance";
    case "ANOMALY": return /^\d+$/.test(a.objectId ?? "") ? `anomalies?id=${id}` : "anomalies";
  }
  if (a.objectType === "batch" && id) return `batches/${id}`;
  return null;
}
