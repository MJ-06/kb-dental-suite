// HTML to PDF with the machine's own Edge or Chrome in headless mode, so no
// rendering library has to be installed. Set PDF_BROWSER to the executable.
//
// The HTML comes from a screen, so it is treated as untrusted:
//   - it is served to the browser from a one-shot loopback address with a
//     Content-Security-Policy that allows only inline styles and data: images,
//     so no script runs and nothing is fetched;
//   - any other address the page could reach is sent to a dead proxy;
//   - the browser gets a throw-away profile, a time limit, and at most two
//     run at once.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class PdfUnavailable extends Error {}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const TIME_LIMIT_MS = 30_000;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

let running = 0;

async function fileSettled(path: string, deadline: number): Promise<void> {
  let last = -1;
  while (Date.now() < deadline) {
    const size = await stat(path).then((s) => s.size).catch(() => -1);
    if (size > 0 && size === last) return;
    last = size;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out");
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = process.env.PDF_BROWSER;
  if (!browser) throw new PdfUnavailable("PDF export is not set up on this server");
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new PdfUnavailable("That document is too large to turn into a PDF");
  if (/<meta[^>]+http-equiv\s*=\s*["']?\s*refresh/i.test(html)) throw new PdfUnavailable("That document cannot be turned into a PDF");
  if (running >= 2) throw new PdfUnavailable("The PDF maker is busy. Try again in a moment.");

  running++;
  const dir = await mkdtemp(join(tmpdir(), "kb-pdf-"));
  const path = `/${randomUUID()}`;
  let served = false;
  const server = createServer((req, res) => {
    if (req.url !== path || served) { res.writeHead(404).end(); return; }
    served = true;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "x-content-type-options": "nosniff"
    }).end(html);
  });
  try {
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const out = join(dir, "out.pdf");
    // Edge can return before the file is fully written, so the file, not the
    // process, says when it is done: present, non-empty and no longer growing.
    const child = execFile(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--no-pdf-header-footer",
      `--user-data-dir=${join(dir, "profile")}`, "--proxy-server=http://127.0.0.1:9",
      `--print-to-pdf=${out}`, `http://127.0.0.1:${port}${path}`
    ], { timeout: TIME_LIMIT_MS, windowsHide: true }, () => {});
    try { await fileSettled(out, Date.now() + TIME_LIMIT_MS); } finally { child.kill(); }
    return await readFile(out);
  } catch {
    throw new PdfUnavailable("The PDF could not be made. Try again.");
  } finally {
    running--;
    server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
