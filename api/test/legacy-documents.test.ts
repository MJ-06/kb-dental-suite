// Patient documents and generated PDFs through /exec.
import { existsSync } from "node:fs";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withoutMeta } from "../src/pdf.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const store = mkdtempSync(join(tmpdir(), "kb-docs-"));

let w: World;
let admin: string;
let desk: string;
let betaAdmin: string;
let uhid: string;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  process.env.DOCUMENT_DIR = store;
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  ({ uhid } = await exec(w, desk, "getNextUHID"));
  await exec(w, desk, "saveRegistration", { uhid, name: "Doc Patient", mobile: "9855500000" });
});
afterAll(async () => {
  await w.close();
  delete process.env.DOCUMENT_DIR;
  delete process.env.PDF_BROWSER;
  rmSync(store, { recursive: true, force: true });
});

const upload = (extra: Record<string, unknown> = {}) =>
  exec(w, admin, "uploadPatientDocument", { uhid, patientName: "Doc Patient", fileName: "opg.png", mimeType: "image/png", category: "OPG", base64Data: PNG.toString("base64"), ...extra });

describe("uploading and viewing", () => {
  let id: string;

  it("files a scan, lists it, and serves the same bytes back", async () => {
    const up = await upload();
    expect(up).toMatchObject({ success: true, fileName: expect.stringMatching(/^opg_\d{4}-\d{2}-\d{2}\.png$/) });
    id = up.id;
    const list = (await exec(w, admin, "getPatientDocuments", { uhid: uhid.toLowerCase() })).documents;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, uhid, mimeType: "image/png", category: "OPG" });
    expect(list[0]).not.toHaveProperty("storage_key");
    const got = await exec(w, admin, "getPatientDocumentContent", { id, uhid });
    expect(got).toMatchObject({ success: true, mimeType: "image/png", uhid });
    expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
  });

  it("keeps the file out of reach of a crafted name, and under a per-clinic folder", async () => {
    const up = await upload({ fileName: "..\\..\\..\\evil.png" });
    expect(up.fileName).not.toMatch(/[\\/]/);
    const clinics = readdirSync(store);
    expect(clinics).toHaveLength(1);
    expect(readdirSync(join(store, clinics[0]!)).every((f) => /^[0-9a-f-]{36}$/.test(f))).toBe(true);
  });

  it("stores a page that could run script as an opaque download, not as html", async () => {
    const up = await upload({ fileName: "x.html", mimeType: "text/html", base64Data: Buffer.from("<script>alert(1)</script>").toString("base64") });
    const got = await exec(w, admin, "getPatientDocumentContent", { id: up.id });
    expect(got.mimeType).toBe("application/octet-stream");
  });

  it("will not serve one patient's document under another's UHID, nor a made-up id", async () => {
    expect((await exec(w, admin, "getPatientDocumentContent", { id, uhid: "ZZ9999" })).error).toBe("Document does not belong to this patient");
    expect((await exec(w, admin, "getPatientDocumentContent", { id: "../../etc/passwd" })).error).toBe("Document not found");
    expect((await exec(w, admin, "getPatientDocumentContent", {})).error).toBe("Document id required");
  });

  it("refuses an empty, damaged or missing upload", async () => {
    expect((await upload({ uhid: "" })).error).toBe("UHID required");
    expect((await upload({ base64Data: "" })).error).toBe("No file data received");
    expect((await upload({ base64Data: "not base64 !!" })).error).toBe("The file arrived damaged and was not saved");
  });

  it("keeps documents from reception and from another clinic", async () => {
    expect(await exec(w, desk, "getPatientDocuments", { uhid })).toMatchObject({ success: false, forbidden: true });
    expect(await exec(w, desk, "uploadPatientDocument", { uhid, base64Data: "AAAA" })).toMatchObject({ forbidden: true });
    expect((await exec(w, betaAdmin, "getPatientDocumentContent", { id })).error).toBe("Document not found");
    expect((await exec(w, betaAdmin, "getPatientDocuments", { uhid })).documents).toEqual([]);
  });

  it("removes a document from the folder but keeps the file", async () => {
    const before = readdirSync(join(store, readdirSync(store)[0]!)).length;
    expect((await exec(w, admin, "deletePatientDocument", { id })).success).toBe(true);
    expect((await exec(w, admin, "getPatientDocumentContent", { id })).error).toBe("Document not found");
    expect((await exec(w, admin, "getPatientDocuments", { uhid })).documents.some((d: { id: string }) => d.id === id)).toBe(false);
    expect(readdirSync(join(store, readdirSync(store)[0]!))).toHaveLength(before);
    expect((await exec(w, admin, "deletePatientDocument", { id })).error).toBe("Document not found");
  });
});

describe("generated PDFs", () => {
  it("says plainly when the server has no PDF maker", async () => {
    delete process.env.PDF_BROWSER;
    const res = await exec(w, desk, "createDocumentPDF", { uhid, html: "<p>hi</p>", docName: "Notes" });
    expect(res).toMatchObject({ success: false, error: "PDF export is not set up on this server" });
  });

  it("refuses a document with no patient or no content", async () => {
    expect((await exec(w, desk, "createDocumentPDF", { html: "<p>x</p>" })).error).toBe("UHID required");
    expect((await exec(w, desk, "createDocumentPDF", { uhid })).error).toBe("No document content received");
  });

  it.runIf(existsSync(EDGE))("makes a real PDF, files it once per fingerprint, and does not let the page reach out", async () => {
    process.env.PDF_BROWSER = EDGE;
    const html = "<html><body><h1>Progress Notes</h1><script>document.title='ran'</script><img src='http://127.0.0.1:1/x.png'></body></html>";
    const first = await exec(w, desk, "createDocumentPDF", { uhid, html, docName: "Progress Notes", dedupeKey: "k1" });
    expect(first).toMatchObject({ success: true, fileName: expect.stringMatching(/^Progress Notes_.*\.pdf$/) });
    expect(Buffer.from(first.base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    const again = await exec(w, desk, "createDocumentPDF", { uhid, html, docName: "Progress Notes", dedupeKey: "k1" });
    expect(again).toMatchObject({ success: true, duplicate: true, fileName: first.fileName });
    expect(again.id).toBeUndefined(); // a duplicate reveals no document id to someone who cannot open it
    expect(again.base64).toBeUndefined();
    const listed = (await exec(w, admin, "getPatientDocuments", { uhid })).documents.filter((d: { mimeType: string }) => d.mimeType === "application/pdf");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ category: "Progress Notes" });
  }, 60_000);

  it.runIf(existsSync(EDGE))("strips a redirect instead of following it", async () => {
    process.env.PDF_BROWSER = EDGE;
    let hits = 0;
    const target = createServer((_req, res) => { hits++; res.end("secret"); });
    await new Promise<void>((ok) => target.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    try {
      const res = await exec(w, desk, "createDocumentPDF", { uhid, html: `<meta http-equiv="refresh" content="0;url=${url}"><p>Visit</p>` });
      expect(res.success).toBe(true);
      await new Promise((r) => setTimeout(r, 500));
      expect(hits).toBe(0);
    } finally { target.close(); }
  }, 60_000);

  it("files a printed document only for a patient on the register, always as Progress Notes", async () => {
    process.env.PDF_BROWSER = EDGE;
    expect((await exec(w, desk, "createDocumentPDF", { uhid: "ZZ9999", html: "<p>x</p>" })).error).toBe("Patient not found");
    if (!existsSync(EDGE)) return;
    await exec(w, desk, "createDocumentPDF", { uhid, html: "<p>y</p>", category: "Consent Form (Scanned PDF)", dedupeKey: "k2" });
    const docs = (await exec(w, admin, "getPatientDocuments", { uhid })).documents;
    expect(docs.filter((d: { category: string }) => d.category === "Consent Form (Scanned PDF)")).toHaveLength(0);
  }, 60_000);
});

describe("removing meta elements", () => {
  it("removes every form a meta tag can take", () => {
    for (const bad of [
      "<meta http-equiv=refresh content='0;url=http://x/'>", "<META HTTP-EQUIV=\"Refresh\" content=1>", "< meta http-equiv=refresh>",
      "<meta\nhttp-equiv=refresh\ncontent=0>", "<svg><meta http-equiv=refresh content=0></svg>", "<meta http-equiv=refresh"
    ]) {
      expect(withoutMeta(`<p>a</p>${bad}<p>b</p>`), bad).not.toMatch(/<\s*meta/i);
    }
    expect(withoutMeta("<me<meta>ta http-equiv=refresh content=0>")).not.toMatch(/<\s*meta/i);
    expect(() => withoutMeta("<meta".repeat(40))).not.toThrow();
    expect(withoutMeta("<p>kept</p>")).toBe("<p>kept</p>");
  });
});
