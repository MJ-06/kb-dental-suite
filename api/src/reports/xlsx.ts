// A small .xlsx writer, so Excel export needs no new dependency.
//
// An .xlsx is a zip of XML files. This writes the handful Excel needs for
// plain tables: one header row, then rows of text, numbers and dates, with a
// bold header, a frozen top row, an autofilter and sensible column widths.
//
// Text is always stored as an inline string, never as a formula, so a patient
// called "=HYPERLINK(...)" opens as plain text rather than running.
import { crc32, deflateRawSync } from "node:zlib";

export type CellType = "text" | "int" | "money" | "date";
export interface Column { key: string; label: string; type: CellType }
export interface Sheet { name: string; columns: Column[]; rows: Record<string, unknown>[]; note?: string }

const esc = (s: string) =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "") // not allowed in XML 1.0
   .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A1-style column letters: 0 -> A, 26 -> AA. */
const colName = (i: number) => {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

/** Excel sheet names: at most 31 characters, none of []:*?/\ , unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (raw.replace(/[\[\]:*?/\\]/g, " ").trim() || "Sheet").slice(0, 31);
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) { const tag = ` (${n++})`; name = base.slice(0, 31 - tag.length) + tag; }
    used.add(name.toLowerCase());
    return name;
  });
}

// Styles: 0 plain, 1 bold header, 2 money (2 decimals, Indian grouping is the
// viewer's own locale), 3 whole number, 4 date, 5 italic note.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F1F8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF0078B4"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const STYLE_OF: Record<CellType, number> = { text: 0, int: 3, money: 2, date: 4 };

/** Days since 1899-12-30 for an ISO day, which is how Excel stores a date. */
function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.round((Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function cell(ref: string, type: CellType, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (type === "date") {
    const d = excelDate(String(v));
    if (d !== null) return `<c r="${ref}" s="4"><v>${d}</v></c>`;
  }
  if (type === "int" || type === "money") {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return `<c r="${ref}" s="${STYLE_OF[type]}"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const { columns, rows } = sheet;
  const headerRow = sheet.note ? 3 : 1; // a note sits above the table with a blank row after it
  const out: string[] = [];
  if (sheet.note) {
    out.push(`<row r="1"><c r="A1" s="5" t="inlineStr"><is><t xml:space="preserve">${esc(sheet.note)}</t></is></c></row>`);
  }
  out.push(`<row r="${headerRow}">${columns.map((c, i) => `<c r="${colName(i)}${headerRow}" s="1" t="inlineStr"><is><t>${esc(c.label)}</t></is></c>`).join("")}</row>`);
  rows.forEach((row, r) => {
    const n = headerRow + 1 + r;
    out.push(`<row r="${n}">${columns.map((c, i) => cell(`${colName(i)}${n}`, c.type, row[c.key])).join("")}</row>`);
  });

  // Width follows the longest of the first 200 values, within sensible bounds.
  const widths = columns.map((c) => {
    let w = c.label.length + 2;
    for (const row of rows.slice(0, 200)) {
      const v = row[c.key];
      const len = c.type === "money" ? 14 : c.type === "date" ? 12 : String(v ?? "").length + 1;
      if (len > w) w = len;
    }
    return Math.min(Math.max(w, 8), 50);
  });
  const last = `${colName(Math.max(columns.length - 1, 0))}${headerRow + Math.max(rows.length, 1)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${out.join("")}</sheetData>
<autoFilter ref="A${headerRow}:${last}"/>
</worksheet>`;
}

// ── zip (stored/deflated entries, no zip64: workbooks here are far below 4 GB) ──

interface Entry { name: string; data: Buffer }

function zip(entries: Entry[]): Buffer {
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  // 1 Jan 2026 in DOS format; a fixed stamp keeps identical workbooks byte-identical.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // 0x0800 = UTF-8 names
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, packed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** The finished .xlsx file as bytes. */
export function buildWorkbook(sheets: Sheet[]): Buffer {
  if (!sheets.length) throw new Error("A workbook needs at least one sheet");
  const names = sheetNames(sheets.map((s) => s.name));
  const n = sheets.length;
  const ns = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const files: Entry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook ${ns}><sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: "xl/styles.xml", data: Buffer.from(STYLES) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s)) }))
  ];
  return zip(files);
}
