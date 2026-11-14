// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAgentMentionHref, buildProjectMentionHref } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

describe("MarkdownBody", () => {
  it("renders markdown images without a resolver", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{"![](/api/attachments/test/content)"}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('<img src="/api/attachments/test/content" alt=""/>');
  });

  it("resolves relative image paths when a resolver is provided", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody resolveImageSrc={(src) => `/resolved/${src}`}>
          {"![Org chart](images/org-chart.png)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('src="/resolved/images/org-chart.png"');
    expect(html).toContain('alt="Org chart"');
  });

  it("renders agent and project mentions as chips", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [@Paperclip App](${buildProjectMentionHref("project-456", "#336699")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--paperclip-mention-icon-mask");
    expect(html).toContain('href="/projects/project-456"');
    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain("--paperclip-mention-project-color:#336699");
  });

  it("opens markdown links in a new tab except in-page hash links", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"See [Docs](https://example.com), GEM-2184, and [Section](#document-plan)."}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Docs</a>');
    expect(html).toContain('href="/issues/GEM-2184"');
    expect(html).toMatch(/<a href="\/issues\/GEM-2184"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toContain('<a href="#document-plan">Section</a>');
    expect(html).not.toContain('<a href="#document-plan" target="_blank"');
  });
});
