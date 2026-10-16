import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectNovncHtml,
  injectNovncStorageShim,
  isProxiedHtmlDocument,
  MAX_NOVNC_HTML_BYTES,
} from "./novnc-html.js";

describe("noVNC HTML rewrite", () => {
  it("returns a document that ends", async () => {
    const html = await collectNovncHtml(Readable.from([Buffer.from("<html></html>")]), 1024);
    expect(html).toBe("<html></html>");
  });

  it("rejects a document over the size cap", async () => {
    const stream = Readable.from([Buffer.alloc(MAX_NOVNC_HTML_BYTES + 1)]);
    await expect(collectNovncHtml(stream, MAX_NOVNC_HTML_BYTES)).rejects.toThrow(/exceeds/);
  });

  it("rejects an upstream abort that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("aborted");
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("rejects an upstream close that never ends", async () => {
    const stream = new Readable({ read() {} });
    const pending = collectNovncHtml(stream, 1024);
    stream.emit("close");
    await expect(pending).rejects.toThrow(/closed/);
  });

  it.each(["text/html", "text/html; charset=utf-8", "application/xhtml+xml"])(
    "recognizes %s as the listener document",
    (contentType) => {
      expect(isProxiedHtmlDocument({ "content-type": contentType })).toBe(true);
    },
  );

  it.each(["text/javascript", "application/json", "image/png", undefined])(
    "leaves %s to stream through untouched",
    (contentType) => {
      expect(isProxiedHtmlDocument({ "content-type": contentType })).toBe(false);
    },
  );

  it("leaves a compressed document alone rather than rewriting bytes it cannot read", () => {
    expect(isProxiedHtmlDocument({ "content-type": "text/html", "content-encoding": "gzip" })).toBe(
      false,
    );
  });

  it("gives the sandboxed document an ephemeral store before any page script", () => {
    const html = injectNovncStorageShim(
      "<!doctype html><head><title>x</title></head><body></body>",
    );
    expect(html).toContain('<head><script>\nObject.defineProperty(window, "localStorage"');
    expect(html.indexOf("localStorage")).toBeLessThan(html.indexOf("<title>"));
  });

  it("falls back to the first script when the listener omits a head element", () => {
    const html = injectNovncStorageShim('<title>x</title><script src="app/ui.js"></script>');
    expect(html).toContain('Object.defineProperty(window, "localStorage"');
    expect(html.indexOf("Object.defineProperty")).toBeLessThan(html.indexOf("app/ui.js"));
  });
});
