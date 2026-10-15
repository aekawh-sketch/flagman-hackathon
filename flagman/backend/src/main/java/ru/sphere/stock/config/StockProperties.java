package ru.sphere.stock.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @param demoMode    демо-часы и генератор доступны только в демо-режиме (ТЗ 6.2)
 * @param seed        залить демо-данные, если база пустая
 * @param uploadsDir  куда класть фото заявок и накладных — вне публичной папки (ТЗ 6.13)
 * @param corsOrigins домены, которым разрешены запросы из браузера (не «*», ТЗ 6.13)
 * @param siteApiKey  ключ сайта ресторана для демо: сервер сайта знает его заранее, ключ переживает сброс демо-данных
 * @param supplierApiKey ключ демо-портала поставщика (только {@code deliveries:create}) — так же переживает сброс
 * @param platformApiKey ключ платформы для внешней админки или CRM: заявки на предприятия, настройки
 *                       (заголовок {@code X-Platform-Key}); пусто — только администратор платформы со своим входом
 * @param platformWebhookUrl куда сообщать о новой заявке на предприятие (POST JSON) — например, в CRM; пусто — никуда
 * @param platformAdmins логины администраторов платформы — роль выдаётся при старте (на рабочем сервере)
 */
@ConfigurationProperties("stock")
public record StockProperties(boolean demoMode, boolean seed, String uploadsDir, List<String> corsOrigins,
                              String siteApiKey, String supplierApiKey, String platformApiKey,
                              String platformWebhookUrl, List<String> platformAdmins) {
}
