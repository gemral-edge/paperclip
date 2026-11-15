import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { redactEventPayload, sanitizeRecord, stripLoneSurrogates } from "../redaction.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdOrIdentifier: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE_RE.test(value);
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const ISSUE_UUID = "11111111-1111-4111-8111-111111111111";

function makeIssue() {
  return {
    id: ISSUE_UUID,
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "GEM-2243",
    title: "Surrogate snippet regression",
  };
}

describe("issue comment bodySnippet UTF-16 surrogate safety (GEM-2243)", () => {
  const emojiAt119 = `${"a".repeat(119)}🔴bbbbbbbbbb`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdOrIdentifier.mockResolvedValue(makeIssue());
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "comment-surrogate-1",
      issueId: ISSUE_UUID,
      companyId: "company-1",
      body,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    }));
  });

  it("proves UTF-16 .slice(0, 120) leaves a lone high surrogate while Array.from keeps emoji intact", () => {
    const brokenSnippet = emojiAt119.slice(0, 120);
    expect(hasLoneSurrogate(brokenSnippet)).toBe(true);
    expect(brokenSnippet.charCodeAt(119)).toBe(0xd83d);

    const safeSnippet = Array.from(emojiAt119).slice(0, 120).join("");
    expect(hasLoneSurrogate(safeSnippet)).toBe(false);
    expect(safeSnippet).toBe(`${"a".repeat(119)}🔴`);
  });

  it("passes surrogate-safe bodySnippet on POST /issues/:id/comments", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${ISSUE_UUID}/comments`)
      .set("sec-fetch-site", "same-origin")
      .send({ body: emojiAt119 });

    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          commentId: "comment-surrogate-1",
          bodySnippet: `${"a".repeat(119)}🔴`,
        }),
      }),
    );

    const call = mockLogActivity.mock.calls.find((c) => c[1]?.action === "issue.comment_added");
    const snippet = String(call?.[1]?.details?.bodySnippet ?? "");
    expect(hasLoneSurrogate(snippet)).toBe(false);
  });

  it("passes surrogate-safe bodySnippet on PATCH /issues/:id with comment", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_UUID}`)
      .set("sec-fetch-site", "same-origin")
      .send({ comment: emojiAt119 });

    expect(res.status).toBe(200);
    const call = mockLogActivity.mock.calls.find((c) => c[1]?.action === "issue.comment_added");
    expect(call).toBeDefined();
    const snippet = String(call?.[1]?.details?.bodySnippet ?? "");
    expect(snippet).toBe(`${"a".repeat(119)}🔴`);
    expect(hasLoneSurrogate(snippet)).toBe(false);
  });

  it("strips lone surrogates in redaction helpers while preserving valid emoji pairs", () => {
    const brokenHigh = `ok-${"\uD83D"}-🔴`;
    const brokenLow = `${"\uDD34"}-end`;
    expect(stripLoneSurrogates(brokenHigh)).toBe("ok--🔴");
    expect(stripLoneSurrogates(brokenLow)).toBe("-end");

    const sanitized = sanitizeRecord({
      bodySnippet: brokenHigh,
      nested: { items: [brokenLow, "clean-🔴"] },
    });
    expect(sanitized).toEqual({
      bodySnippet: "ok--🔴",
      nested: { items: ["-end", "clean-🔴"] },
    });
    expect(redactEventPayload({ note: `a${"\uD83D"}b` })).toEqual({ note: "ab" });
  });

  it("static guard: issues.ts uses Array.from(...).slice(0, ...) for comment snippets and lesson queue strings", () => {
    const issuesSource = readFileSync(path.resolve(__dirname, "../routes/issues.ts"), "utf8");
    expect(issuesSource).not.toContain("comment.body.slice(");
    const matches = issuesSource.match(/bodySnippet:\s*Array\.from\(comment\.body\)\.slice\(0,\s*120\)\.join\(""\)/g);
    expect(matches).toHaveLength(2);
    expect(issuesSource).toContain('Array.from(String(req.body.error_message)).slice(0, 1000).join("")');
    expect(issuesSource).toContain('Array.from(String(req.body.lesson_summary)).slice(0, 500).join("")');
  });
});
