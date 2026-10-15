package ru.sphere.stock.infra;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Excel (.xlsx) без сторонних библиотек: файл — zip-архив с XML. Чтение — листы в таблицы строк (как видит
 * человек: числа без «.0», даты — как число Excel), запись — простые листы с жирной шапкой и шириной колонок.
 * XML разбирается с выключенными DOCTYPE и внешними сущностями (защита от XXE), архив — с лимитом размера.
 */
public final class Xlsx {

    private static final int MAX_UNZIPPED = 20 * 1024 * 1024;

    private Xlsx() {
    }

    /** Похоже ли на .xlsx: zip-архив начинается с «PK». */
    public static boolean looksLike(byte[] bytes) {
        return bytes.length > 4 && bytes[0] == 'P' && bytes[1] == 'K' && bytes[2] == 3 && bytes[3] == 4;
    }

    /** Все листы книги по порядку: имя листа → строки → ячейки (пустые — ""). */
    public static Map<String, List<List<String>>> read(byte[] bytes) {
        Map<String, byte[]> files = unzip(bytes);
        List<String> shared = new ArrayList<>();
        if (files.containsKey("xl/sharedStrings.xml")) {
            NodeList si = parse(files.get("xl/sharedStrings.xml")).getElementsByTagName("si");
            for (int i = 0; i < si.getLength(); i++) {
                shared.add(text((Element) si.item(i)));
            }
        }
        Map<String, String> targets = new HashMap<>();
        if (files.containsKey("xl/_rels/workbook.xml.rels")) {
            NodeList rels = parse(files.get("xl/_rels/workbook.xml.rels")).getElementsByTagName("Relationship");
            for (int i = 0; i < rels.getLength(); i++) {
                Element r = (Element) rels.item(i);
                String t = r.getAttribute("Target");
                targets.put(r.getAttribute("Id"), t.startsWith("/") ? t.substring(1) : "xl/" + t);
            }
        }
        Document wb = parse(require(files, "xl/workbook.xml"));
        NodeList sheets = wb.getElementsByTagName("sheet");
        Map<String, List<List<String>>> out = new LinkedHashMap<>();
        for (int i = 0; i < sheets.getLength(); i++) {
            Element s = (Element) sheets.item(i);
            String rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
            if (rid.isEmpty()) {
                rid = s.getAttribute("r:id");
            }
            String path = targets.getOrDefault(rid, "xl/worksheets/sheet" + (i + 1) + ".xml");
            byte[] xml = files.get(path);
            if (xml != null) {
                out.put(s.getAttribute("name"), sheet(parse(xml), shared));
            }
        }
        return out;
    }

    private static List<List<String>> sheet(Document doc, List<String> shared) {
        List<List<String>> rows = new ArrayList<>();
        NodeList rowNodes = doc.getElementsByTagName("row");
        for (int i = 0; i < rowNodes.getLength(); i++) {
            Element row = (Element) rowNodes.item(i);
            int index = row.hasAttribute("r") ? Integer.parseInt(row.getAttribute("r")) - 1 : rows.size();
            while (rows.size() < index) {
                rows.add(new ArrayList<>());
            }
            List<String> cells = new ArrayList<>();
            NodeList cs = row.getElementsByTagName("c");
            for (int j = 0; j < cs.getLength(); j++) {
                Element c = (Element) cs.item(j);
                int col = c.hasAttribute("r") ? column(c.getAttribute("r")) : cells.size();
                while (cells.size() < col) {
                    cells.add("");
                }
                cells.add(value(c, shared));
            }
            rows.add(cells);
        }
        return rows;
    }

    private static String value(Element c, List<String> shared) {
        String type = c.getAttribute("t");
        if ("inlineStr".equals(type)) {
            NodeList is = c.getElementsByTagName("is");
            return is.getLength() == 0 ? "" : text((Element) is.item(0)).strip();
        }
        NodeList v = c.getElementsByTagName("v");
        String raw = v.getLength() == 0 ? "" : v.item(0).getTextContent();
        if ("s".equals(type)) {
            int k = Integer.parseInt(raw.strip());
            return k < shared.size() ? shared.get(k).strip() : "";
        }
        if (type.isEmpty() || "n".equals(type)) {
            return number(raw);
        }
        return raw.strip();
    }

    /** «150.0» → «150», «0.30000000000000004» → «0.3»: число так, как его видит человек в ячейке. */
    private static String number(String raw) {
        if (raw.isBlank()) {
            return "";
        }
        try {
            java.math.BigDecimal d = new java.math.BigDecimal(raw.strip()).round(new java.math.MathContext(12));
            String s = d.stripTrailingZeros().toPlainString();
            return s.equals("-0") ? "0" : s;
        } catch (NumberFormatException e) {
            return raw.strip();
        }
    }

    /** «C12» → 2 (номер колонки с нуля). */
    static int column(String ref) {
        int col = 0;
        for (char ch : ref.toCharArray()) {
            if (ch < 'A' || ch > 'Z') {
                break;
            }
            col = col * 26 + (ch - 'A' + 1);
        }
        return col - 1;
    }

    private static String text(Element e) {
        StringBuilder sb = new StringBuilder();
        NodeList ts = e.getElementsByTagName("t");
        for (int i = 0; i < ts.getLength(); i++) {
            Node parent = ts.item(i).getParentNode();
            // Фонетические подсказки (rPh) — не текст ячейки.
            if (parent != null && "rPh".equals(parent.getNodeName())) {
                continue;
            }
            sb.append(ts.item(i).getTextContent());
        }
        return sb.toString();
    }

    private static Map<String, byte[]> unzip(byte[] bytes) {
        Map<String, byte[]> out = new HashMap<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            for (ZipEntry e; (e = zip.getNextEntry()) != null; ) {
                if (e.isDirectory() || !e.getName().endsWith(".xml") && !e.getName().endsWith(".rels")) {
                    continue;
                }
                byte[] data = zip.readNBytes(MAX_UNZIPPED + 1);
                total += data.length;
                if (total > MAX_UNZIPPED) {
                    throw ApiException.badRequest("Файл Excel слишком большой");
                }
                out.put(e.getName(), data);
            }
        } catch (IOException e) {
            throw ApiException.badRequest("Не удалось прочитать файл Excel (.xlsx)");
        }
        return out;
    }

    private static byte[] require(Map<String, byte[]> files, String name) {
        byte[] b = files.get(name);
        if (b == null) {
            throw ApiException.badRequest("Это не файл Excel (.xlsx): нет " + name);
        }
        return b;
    }

    private static Document parse(byte[] xml) {
        try {
            DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
            f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setXIncludeAware(false);
            f.setExpandEntityReferences(false);
            f.setNamespaceAware(true);
            return f.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
        } catch (Exception e) {
            throw ApiException.badRequest("Файл Excel повреждён или в неизвестном формате");
        }
    }

    // ── Запись ─────────────────────────────────────────────────────────────

    /** Лист для записи: первая строка — шапка (жирная), ширина колонок в символах. */
    public record Sheet(String name, List<List<Object>> rows, List<Integer> widths) {
    }

    public static byte[] write(List<Sheet> sheets) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            StringBuilder types = new StringBuilder("""
                    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                    <Default Extension="xml" ContentType="application/xml"/>
                    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
                    <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
                    """);
            StringBuilder book = new StringBuilder("""
                    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>""");
            StringBuilder rels = new StringBuilder("""
                    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""");
            for (int i = 0; i < sheets.size(); i++) {
                int n = i + 1;
                types.append("<Override PartName=\"/xl/worksheets/sheet").append(n)
                        .append(".xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
                book.append("<sheet name=\"").append(esc(sheets.get(i).name())).append("\" sheetId=\"").append(n)
                        .append("\" r:id=\"rId").append(n).append("\"/>");
                rels.append("<Relationship Id=\"rId").append(n)
                        .append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet")
                        .append(n).append(".xml\"/>");
                put(zip, "xl/worksheets/sheet" + n + ".xml", sheetXml(sheets.get(i)));
            }
            rels.append("<Relationship Id=\"rId").append(sheets.size() + 1)
                    .append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>");
            put(zip, "[Content_Types].xml", types.append("</Types>").toString());
            put(zip, "_rels/.rels", """
                    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>""");
            put(zip, "xl/workbook.xml", book.append("</sheets></workbook>").toString());
            put(zip, "xl/_rels/workbook.xml.rels", rels.append("</Relationships>").toString());
            put(zip, "xl/styles.xml", """
                    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
                    <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
                    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8F3EF"/></patternFill></fill></fills>
                    <borders count="1"><border/></borders>
                    <cellStyleXfs count="1"><xf/></cellStyleXfs>
                    <cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs>
                    </styleSheet>""");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        return out.toByteArray();
    }

    private static String sheetXml(Sheet s) {
        StringBuilder x = new StringBuilder("""
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">""");
        if (s.widths() != null && !s.widths().isEmpty()) {
            x.append("<cols>");
            for (int i = 0; i < s.widths().size(); i++) {
                x.append("<col min=\"").append(i + 1).append("\" max=\"").append(i + 1).append("\" width=\"")
                        .append(s.widths().get(i)).append("\" customWidth=\"1\"/>");
            }
            x.append("</cols>");
        }
        x.append("<sheetData>");
        for (int r = 0; r < s.rows().size(); r++) {
            x.append("<row r=\"").append(r + 1).append("\">");
            List<Object> row = s.rows().get(r);
            for (int c = 0; c < row.size(); c++) {
                Object v = row.get(c);
                if (v == null || v instanceof String str && str.isEmpty()) {
                    continue;
                }
                String ref = ref(c) + (r + 1);
                String style = r == 0 ? " s=\"1\"" : "";
                if (v instanceof Number num) {
                    x.append("<c r=\"").append(ref).append("\"").append(style).append("><v>").append(num).append("</v></c>");
                } else {
                    x.append("<c r=\"").append(ref).append("\" t=\"inlineStr\"").append(style).append("><is><t xml:space=\"preserve\">")
                            .append(esc(v.toString())).append("</t></is></c>");
                }
            }
            x.append("</row>");
        }
        return x.append("</sheetData></worksheet>").toString();
    }

    private static String ref(int col) {
        StringBuilder sb = new StringBuilder();
        for (int c = col + 1; c > 0; c = (c - 1) / 26) {
            sb.insert(0, (char) ('A' + (c - 1) % 26));
        }
        return sb.toString();
    }

    private static void put(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
