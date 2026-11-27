import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

const origNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const origDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, "document");

function restoreGlobals() {
  if (origNavigatorDesc) Object.defineProperty(globalThis, "navigator", origNavigatorDesc);
  else delete (globalThis as Record<string, unknown>).navigator;

  if (origDocumentDesc) Object.defineProperty(globalThis, "document", origDocumentDesc);
  else delete (globalThis as Record<string, unknown>).document;
}

function makeMockDocument(execResult: boolean | Error) {
  const appended: unknown[] = [];
  const fakeTextarea = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
  };
  const body = {
    appendChild: vi.fn((el: unknown) => {
      appended.push(el);
    }),
    removeChild: vi.fn((el: unknown) => {
      const idx = appended.indexOf(el);
      if (idx >= 0) appended.splice(idx, 1);
    }),
  };
  const doc = {
    body,
    createElement: vi.fn(() => fakeTextarea),
    execCommand: vi.fn(() => {
      if (execResult instanceof Error) throw execResult;
      return execResult;
    }),
  };
  return { doc, body, fakeTextarea, appended };
}

afterEach(() => {
  restoreGlobals();
  vi.restoreAllMocks();
});

describe("copyToClipboard", () => {
  it("trả về true khi navigator.clipboard.writeText thành công", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    const ok = await copyToClipboard("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("fallback sang execCommand và trả về true khi writeText bị reject", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const { doc, body, appended } = makeMockDocument(true);
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });

    const ok = await copyToClipboard("fallback-text");
    expect(ok).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(body.removeChild).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(0);
  });

  it("fallback sang execCommand khi thiếu navigator.clipboard", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    const { doc, fakeTextarea } = makeMockDocument(true);
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });

    const ok = await copyToClipboard("no-clipboard-api");
    expect(ok).toBe(true);
    expect(fakeTextarea.value).toBe("no-clipboard-api");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  });

  it("trả về false và không throw khi cả Clipboard API lẫn execCommand đều lỗi", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Denied"));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText } },
    });
    const { doc, body } = makeMockDocument(new Error("execCommand failed"));
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });

    await expect(copyToClipboard("fail-both")).resolves.toBe(false);
    expect(body.removeChild).toHaveBeenCalledTimes(1);
  });
});
