// Fail-closed loader (Codex P5-R2 [high]): catalog parse-được nhưng rỗng/malformed PHẢI trả null để
// loadMediaLibrary fallback sang agents/sales-closer/media-library.json — KHÔNG cache MediaLibrary
// 0-item (sẽ câm media 60s dù fallback còn dùng được).
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve, dirname } from "node:path";

import { loadSalesCloserMediaFromCatalog, catalogPath } from "../channels/catalog-media-source.js";

function makeRootWithCatalog(content: string): string {
  const root = mkdtempSync(pathResolve(tmpdir(), "cat-root-"));
  const catFile = catalogPath(root);
  mkdirSync(dirname(catFile), { recursive: true });
  writeFileSync(catFile, content, "utf-8");
  return root;
}

describe("loadSalesCloserMediaFromCatalog — fail-closed (trả null → fallback)", () => {
  it("catalog thiếu file → null", () => {
    const root = mkdtempSync(pathResolve(tmpdir(), "cat-empty-"));
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("catalog {} (không có items) → null", () => {
    const root = makeRootWithCatalog("{}");
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('catalog {"items": null} → null', () => {
    const root = makeRootWithCatalog('{"items": null}');
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('catalog {"items": []} (rỗng) → null', () => {
    const root = makeRootWithCatalog('{"items": []}');
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("catalog JSON hỏng (parse lỗi) → null", () => {
    const root = makeRootWithCatalog("{ this is not json");
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("catalog items toàn entry thiếu id → null (0 item hợp lệ sau lọc)", () => {
    const root = makeRootWithCatalog('{"items": [{"name": "no id"}, {"name": "cũng không"}]}');
    expect(loadSalesCloserMediaFromCatalog(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("catalog HỢP LỆ (≥1 item có id) → MediaLibrary không null, đúng số item", () => {
    const root = makeRootWithCatalog(
      '{"version":"t","items":[' +
        '{"id":"a","name":"A","type":"course","description":"desc A","covers":["Alpha Product"],"all_images":["D:/a.png"]},' +
        '{"id":"b","name":"B","type":"image","description":"desc B","covers":["Beta Thing"],"all_images":["https://x/b.png"]}' +
        "]}",
    );
    const lib = loadSalesCloserMediaFromCatalog(root);
    expect(lib).not.toBeNull();
    expect(lib!.items.length).toBe(2);
    expect(lib!.items[0].description).toBe("desc A"); // description ĐẦY ĐỦ (D-1)
    rmSync(root, { recursive: true, force: true });
  });

  it("catalog id TRÙNG → dedupe keep-first (không câm, giữ bản đầu)", () => {
    const root = makeRootWithCatalog(
      '{"items":[' +
        '{"id":"dup","name":"First","type":"image","description":"first","covers":["Xyz Product"],"all_images":["D:/1.png"]},' +
        '{"id":"dup","name":"Second","type":"image","description":"second","covers":["Xyz Product"],"all_images":["D:/2.png"]}' +
        "]}",
    );
    const lib = loadSalesCloserMediaFromCatalog(root);
    expect(lib).not.toBeNull();
    expect(lib!.items.length).toBe(1);
    expect(lib!.items[0].name).toBe("First"); // giữ bản ĐẦU
    rmSync(root, { recursive: true, force: true });
  });
});

// 14/10 (plan CSKH-SPLIT): yinyang-support chỉ gửi ảnh crystal — lọc theo type, gắn đúng agent_slug.
describe("loadSalesCloserMediaFromCatalog — lọc type theo agent", () => {
  it("allowTypes crystal → bỏ entry edge, agent_slug = yinyang-support", () => {
    const root = makeRootWithCatalog(
      '{"items":[' +
        '{"id":"c1","name":"Rose","type":"crystal","description":"d","covers":["Rose"],"all_images":["D:/1.png"]},' +
        '{"id":"e1","name":"Edge Pro","type":"edge","description":"d","covers":["Edge"],"all_images":["D:/2.png"]}' +
        "]}",
    );
    const lib = loadSalesCloserMediaFromCatalog(root, "yinyang-support", new Set(["crystal"]));
    expect(lib).not.toBeNull();
    expect(lib!.items.map((i) => i.id)).toEqual(["c1"]);
    expect(lib!.agent_slug).toBe("yinyang-support");
    rmSync(root, { recursive: true, force: true });
  });
});
