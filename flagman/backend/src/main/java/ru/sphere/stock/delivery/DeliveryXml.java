package ru.sphere.stock.delivery;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import ru.sphere.stock.infra.ApiException;

/**
 * Поставка в XML (ТЗ 16.3). Формат повторяет JSON: поля — атрибутами или вложенными элементами,
 * строки — элементы {@code <line>}:
 *
 * <pre>{@code
 * <delivery id="SUP-42" number="П-42" createdAt="2026-10-11T08:00:00Z" supplier="ООО Ромашка">
 *   <line productId="milk" name="Молоко 3,2%" unit="ML" qty="10000" shelfLifeHours="72" costKop="90000"/>
 * </delivery>
 * }</pre>
 *
 * <p>Разбор — встроенным парсером JDK с запретом DOCTYPE и внешних сущностей: файл от поставщика —
 * чужие данные, а XXE через загрузку файла — классическая атака на XML.
 */
public final class DeliveryXml {

    private DeliveryXml() {
    }

    public static DeliveryService.DeliveryIn parse(String xml) {
        Document doc;
        try {
            DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
            f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            f.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            f.setXIncludeAware(false);
            f.setExpandEntityReferences(false);
            DocumentBuilder b = f.newDocumentBuilder();
            b.setErrorHandler(null);
            doc = b.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw ApiException.badRequest("Не удалось прочитать XML: " + firstLine(e.getMessage()));
        }
        Element root = doc.getDocumentElement();
        if (!"delivery".equals(root.getTagName())) {
            throw ApiException.badRequest("Корневой элемент XML — <delivery>");
        }
        List<DeliveryService.LineIn> lines = new ArrayList<>();
        NodeList nodes = root.getElementsByTagName("line");
        for (int i = 0; i < nodes.getLength(); i++) {
            Element l = (Element) nodes.item(i);
            lines.add(new DeliveryService.LineIn(value(l, "productId"), value(l, "name"), value(l, "unit"),
                    longOf(l, "qty", 0L), intOf(l, "shelfLifeHours"), instant(l, "expiresAt"), longOf(l, "costKop", null)));
        }
        String mock = value(root, "mock");
        return new DeliveryService.DeliveryIn(value(root, "id"), value(root, "number"), instant(root, "createdAt"),
                value(root, "supplier"), lines, mock == null ? null : Boolean.parseBoolean(mock));
    }

    /** Атрибут или текст вложенного элемента с тем же именем. */
    private static String value(Element el, String name) {
        if (el.hasAttribute(name)) {
            return el.getAttribute(name).trim();
        }
        for (Node n = el.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element c && name.equals(c.getTagName())) {
                return c.getTextContent().trim();
            }
        }
        return null;
    }

    private static Long longOf(Element el, String name, Long dflt) {
        String v = value(el, name);
        if (v == null || v.isEmpty()) {
            return dflt;
        }
        try {
            return Long.parseLong(v.replace(" ", ""));
        } catch (NumberFormatException e) {
            throw ApiException.badRequest("Поле " + name + " — целое число: «" + v + "»");
        }
    }

    private static Integer intOf(Element el, String name) {
        Long v = longOf(el, name, null);
        return v == null ? null : Math.toIntExact(v);
    }

    private static Instant instant(Element el, String name) {
        String v = value(el, name);
        if (v == null || v.isEmpty()) {
            return null;
        }
        try {
            return Instant.parse(v);
        } catch (DateTimeParseException e) {
            throw ApiException.badRequest("Поле " + name + " — дата ISO 8601, например 2026-10-11T08:00:00Z");
        }
    }

    private static String firstLine(String s) {
        return s == null ? "" : s.lines().findFirst().orElse("");
    }
}
