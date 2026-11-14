import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "@/lib/router";
import type { IssueComment, Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Check, Copy, Paperclip, ArrowUpDown, Filter, ListFilter } from "lucide-react";
import { Identity } from "./Identity";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

/** Strip HTML comment metadata tag khỏi body trước khi render */
const PAPERCLIP_META_RE = /<!--\s*paperclip-run:[a-zA-Z0-9_-]+\s+agent:[a-zA-Z0-9_-]+\s*-->/g;
function stripPaperclipMeta(body: string): string {
  return body.replace(PAPERCLIP_META_RE, "").trim();
}
import { AgentIcon } from "./AgentIconPicker";
import { formatDateTime } from "../lib/utils";
import { restoreSubmittedCommentDraft } from "../lib/comment-submit-draft";
import { PluginSlotOutlet } from "@/plugins/slots";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

interface CommentWithRunMeta extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
}

interface LinkedRunItem {
  runId: string;
  status: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
}

interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface CommentThreadProps {
  comments: CommentWithRunMeta[];
  queuedComments?: CommentWithRunMeta[];
  linkedRuns?: LinkedRunItem[];
  companyId?: string | null;
  projectId?: string | null;
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  issueStatus?: string;
  agentMap?: Map<string, Agent>;
  imageUploadHandler?: (file: File) => Promise<string>;
  /** Callback to attach an image file to the parent issue (not inline in a comment). */
  onAttachImage?: (file: File) => Promise<void>;
  draftKey?: string;
  liveRunSlot?: React.ReactNode;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  onInterruptQueued?: (runId: string) => Promise<void>;
  interruptingQueuedRunId?: string | null;
}

export interface CommentComposerProps {
  onAdd: (body: string, reopen?: boolean, reassignment?: CommentReassignment) => Promise<void>;
  draftKey?: string;
  enableReassign?: boolean;
  reassignOptions?: InlineEntityOption[];
  currentAssigneeValue?: string;
  suggestedAssigneeValue?: string;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachImage?: (file: File) => Promise<void>;
  agentMap?: Map<string, Agent>;
  className?: string;
}

const DRAFT_DEBOUNCE_MS = 800;

function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(draftKey: string, value: string) {
  try {
    if (value.trim()) {
      localStorage.setItem(draftKey, value);
    } else {
      localStorage.removeItem(draftKey);
    }
  } catch {
    // Ignore localStorage failures.
  }
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

function parseReassignment(target: string): CommentReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground transition-colors"
      title="Copy as markdown"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CommentCard({
  comment,
  agentMap,
  companyId,
  projectId,
  highlightCommentId,
  queued = false,
  onAddAndReassign,
}: {
  comment: CommentWithRunMeta;
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  queued?: boolean;
  onAddAndReassign?: (agentId: string, replyBody: string) => Promise<void>;
}) {
  const isHighlighted = highlightCommentId === comment.id;
  const isPending = comment.clientStatus === "pending";
  const isQueued = queued || comment.queueState === "queued" || comment.clientStatus === "queued";
  const [submittingChecklist, setSubmittingChecklist] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const hasChecklists = comment.authorAgentId && (comment.body.includes("[ ]") || comment.body.includes("[x]"));

  const handleSubmitChecklist = async () => {
    if (!contentRef.current || !comment.authorAgentId || !onAddAndReassign) return;
    const items = contentRef.current.querySelectorAll("li.task-list-item");
    const selectedText: string[] = [];
    items.forEach((li) => {
      const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox && checkbox.checked) {
        // Collect text without the checkbox itself.
        // It's usually the rest of the childNodes or textContent (which contains everything).
        // Let's grab textContent and trim it.
        const text = li.textContent?.trim() || "";
        selectedText.push(`- [x] ${text}`);
      }
    });

    if (selectedText.length > 0) {
      const replyBody = `Tôi chọn các mục sau:\n\n${selectedText.join("\n")}`;
      setSubmittingChecklist(true);
      try {
        await onAddAndReassign(comment.authorAgentId, replyBody);
      } finally {
        setSubmittingChecklist(false);
      }
    }
  };

  return (
    <div
      key={comment.id}
      id={`comment-${comment.id}`}
      className={`border p-3 overflow-hidden min-w-0 rounded-sm transition-colors duration-1000 ${
        isQueued
          ? "border-amber-300/70 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-500/10"
          : isHighlighted
            ? "border-primary/50 bg-primary/5"
            : "border-border"
      } ${isPending ? "opacity-80" : ""}`}
    >
      <div className="flex items-center justify-between mb-1">
        {comment.authorAgentId ? (
          <Link to={`/agents/${comment.authorAgentId}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            <Identity
              name={agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8)}
              size="sm"
            />
          </Link>
        ) : (
          <Identity name="You" size="sm" />
        )}
        <span className="flex items-center gap-1.5">
          {isQueued ? (
            <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-100/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200">
              Queued
            </span>
          ) : null}
          {companyId && !isPending ? (
            <PluginSlotOutlet
              slotTypes={["commentContextMenuItem"]}
              entityType="comment"
              context={{
                companyId,
                projectId: projectId ?? null,
                entityId: comment.id,
                entityType: "comment",
                parentEntityId: comment.issueId,
              }}
              className="flex flex-wrap items-center gap-1.5"
              itemClassName="inline-flex"
              missingBehavior="placeholder"
            />
          ) : null}
          {isPending ? (
            <span className="text-xs text-muted-foreground">{isQueued ? "Queueing..." : "Sending..."}</span>
          ) : (
            <a
              href={`#comment-${comment.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
            >
              {formatDateTime(comment.createdAt)}
            </a>
          )}
          <CopyMarkdownButton text={comment.body} />
        </span>
      </div>
      <div ref={contentRef}>
        <MarkdownBody className="text-sm">{stripPaperclipMeta(comment.body)}</MarkdownBody>
      </div>
      {hasChecklists && onAddAndReassign && !isPending && (
        <div className="mt-3 pt-3 border-t border-border/60 flex items-center justify-between">
          <span className="text-xs text-muted-foreground italic">
            Check the items you want to assign, then click send.
          </span>
          <Button size="sm" onClick={handleSubmitChecklist} disabled={submittingChecklist}>
            {submittingChecklist ? "Sending..." : "Gửi Assignment (Selected Items)"}
          </Button>
        </div>
      )}
      {companyId && !isPending ? (
        <div className="mt-2 space-y-2">
          <PluginSlotOutlet
            slotTypes={["commentAnnotation"]}
            entityType="comment"
            context={{
              companyId,
              projectId: projectId ?? null,
              entityId: comment.id,
              entityType: "comment",
              parentEntityId: comment.issueId,
            }}
            className="space-y-2"
            itemClassName="rounded-md"
            missingBehavior="placeholder"
          />
        </div>
      ) : null}
      {comment.runId && !isPending ? (
        <div className="mt-2 pt-2 border-t border-border/60">
          {comment.runAgentId ? (
            <Link
              to={`/agents/${comment.runAgentId}/runs/${comment.runId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              run {comment.runId.slice(0, 8)}
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md border border-border bg-accent/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
              run {comment.runId.slice(0, 8)}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

type TimelineItem =
  | { kind: "comment"; id: string; createdAtMs: number; comment: CommentWithRunMeta }
  | { kind: "run"; id: string; createdAtMs: number; run: LinkedRunItem };

const TimelineList = memo(function TimelineList({
  groupedTimeline,
  agentMap,
  companyId,
  projectId,
  highlightCommentId,
  onAddAndReassign,
}: {
  groupedTimeline: { label: string; items: TimelineItem[] }[];
  agentMap?: Map<string, Agent>;
  companyId?: string | null;
  projectId?: string | null;
  highlightCommentId?: string | null;
  onAddAndReassign?: (agentId: string, replyBody: string) => Promise<void>;
}) {
  if (groupedTimeline.length === 0 || (groupedTimeline.length === 1 && groupedTimeline[0].items.length === 0)) {
    return <p className="text-sm text-muted-foreground">No comments or runs match the filter.</p>;
  }

  return (
    <div className="space-y-5">
      {groupedTimeline.map((group) => {
        if (group.items.length === 0) return null;
        return (
          <div key={group.label} className="space-y-3">
            {group.label !== "None" && (
              <h4 className="text-[13px] font-semibold text-muted-foreground uppercase tracking-widest border-b border-border/40 pb-1">
                {group.label}
              </h4>
            )}
            <div className="space-y-3">
              {group.items.map((item) => {
                if (item.kind === "run") {
                  const run = item.run;
                  return (
                    <div key={`run:${run.runId}`} className="border border-border bg-accent/20 p-3 overflow-hidden min-w-0 rounded-sm">
                      <div className="flex items-center justify-between mb-2">
                        <Link to={`/agents/${run.agentId}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          <Identity
                            name={agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8)}
                            size="sm"
                          />
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(run.startedAt ?? run.createdAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Run</span>
                        <Link
                          to={`/agents/${run.agentId}/runs/${run.runId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                        >
                          {run.runId.slice(0, 8)}
                        </Link>
                        <StatusBadge status={run.status} />
                      </div>
                    </div>
                  );
                }

                const comment = item.comment;
                return (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    agentMap={agentMap}
                    companyId={companyId}
                    projectId={projectId}
                    highlightCommentId={highlightCommentId}
                    onAddAndReassign={onAddAndReassign}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
});

export function CommentComposer({
  onAdd,
  draftKey,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions,
  imageUploadHandler,
  onAttachImage,
  agentMap,
  className,
}: CommentComposerProps) {
  const [body, setBody] = useState("");
  const [reopen, setReopen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const effectiveSuggestedAssigneeValue = suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(effectiveSuggestedAssigneeValue);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed) return;
    const hasReassignment = enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment ? parseReassignment(reassignTarget) : null;
    const submittedBody = trimmed;

    setSubmitting(true);
    setBody("");
    try {
      await onAdd(submittedBody, reopen ? true : undefined, reassignment ?? undefined);
      if (draftKey) clearDraft(draftKey);
      setReopen(true);
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch {
      setBody((current) =>
        restoreSubmittedCommentDraft({
          currentBody: current,
          submittedBody,
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const url = await imageUploadHandler(file);
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        setBody((prev) => prev ? `${prev}\n\n${markdown}` : markdown);
      } else if (onAttachImage) {
        await onAttachImage(file);
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const canSubmit = !submitting && !!body.trim();

  return (
    <div className={className}>
      <MarkdownEditor
        ref={editorRef}
        value={body}
        onChange={setBody}
        placeholder="Leave a comment..."
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={imageUploadHandler}
        contentClassName="min-h-[40px] text-sm"
      />
      <div className="flex items-center justify-end gap-3 mt-1.5">
        {(imageUploadHandler || onAttachImage) && (
          <div className="mr-auto flex items-center gap-3">
            <input
              ref={attachInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAttachFile}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => attachInputRef.current?.click()}
              disabled={attaching}
              title="Attach image"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={reopen}
            onChange={(e) => setReopen(e.target.checked)}
            className="rounded border-border"
          />
          Re-open
        </label>
        {enableReassign && reassignOptions.length > 0 && (
          <InlineEntitySelector
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Assignee"
            noneLabel="No assignee"
            searchPlaceholder="Search assignees..."
            emptyMessage="No assignees found."
            onChange={setReassignTarget}
            className="text-xs h-8"
            renderTriggerValue={(option) => {
              if (!option) return <span className="text-muted-foreground">Assignee</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id) return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:") ? option.id.slice("agent:".length) : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        )}
        <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

export function CommentThread({
  comments,
  queuedComments = [],
  linkedRuns = [],
  companyId,
  projectId,
  onAdd,
  agentMap,
  imageUploadHandler,
  onAttachImage,
  draftKey,
  liveRunSlot,
  enableReassign = false,
  reassignOptions = [],
  currentAssigneeValue = "",
  suggestedAssigneeValue,
  mentions: providedMentions,
  onInterruptQueued,
  interruptingQueuedRunId = null,
}: CommentThreadProps) {
  const [highlightCommentId, setHighlightCommentId] = useState<string | null>(null);
  const location = useLocation();
  const hasScrolledRef = useRef(false);

  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [filterKind, setFilterKind] = useState<"all" | "comment" | "run">("all");
  const [filterAuthor, setFilterAuthor] = useState<"all" | "me" | "agent">("all");
  const [groupBy, setGroupBy] = useState<"none" | "date" | "kind" | "agent" | "status">("none");

  const timeline = useMemo<TimelineItem[]>(() => {
    const commentItems: TimelineItem[] = comments.map((comment) => ({
      kind: "comment",
      id: comment.id,
      createdAtMs: new Date(comment.createdAt).getTime(),
      comment,
    }));
    const runItems: TimelineItem[] = linkedRuns.map((run) => ({
      kind: "run",
      id: run.runId,
      createdAtMs: new Date(run.startedAt ?? run.createdAt).getTime(),
      run,
    }));
    let items = [...commentItems, ...runItems];

    if (filterKind === "comment") items = items.filter((i) => i.kind === "comment");
    if (filterKind === "run") items = items.filter((i) => i.kind === "run");

    if (filterAuthor === "me") {
      items = items.filter((i) => i.kind === "comment" && !i.comment.authorAgentId);
    } else if (filterAuthor === "agent") {
      items = items.filter((i) => (i.kind === "comment" && !!i.comment.authorAgentId) || i.kind === "run");
    }

    items.sort((a, b) => {
      const diff = a.createdAtMs - b.createdAtMs;
      const res = diff !== 0 ? diff : a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "comment" ? -1 : 1;
      return sortOrder === "asc" ? res : -res;
    });

    return items;
  }, [comments, linkedRuns, sortOrder, filterKind, filterAuthor]);

  const groupedTimeline = useMemo(() => {
    if (groupBy === "none") return [{ label: "None", items: timeline }];
    const groups = new Map<string, TimelineItem[]>();
    for (const item of timeline) {
      let label = "Unknown";
      if (groupBy === "kind") {
        label = item.kind === "comment" ? "Comments" : "Runs";
      } else if (groupBy === "agent") {
        if (item.kind === "comment") {
          label = item.comment.authorAgentId ? (agentMap?.get(item.comment.authorAgentId)?.name ?? "Agent") : "You";
        } else {
          label = agentMap?.get(item.run.agentId)?.name ?? "Agent";
        }
      } else if (groupBy === "date") {
        label = new Date(item.createdAtMs).toLocaleDateString();
      } else if (groupBy === "status") {
        if (item.kind === "comment") {
          label = item.comment.queueState === "queued" ? "Queued" : item.comment.clientStatus === "pending" ? "Pending" : "Posted";
        } else {
          label = item.run.status;
        }
      }
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(item);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }, [timeline, groupBy, agentMap]);

  const handleAddAndReassign = async (agentId: string, replyBody: string) => {
    await onAdd(replyBody, true, { assigneeAgentId: agentId, assigneeUserId: null });
  };

  // Build mention options from agent map (exclude terminated agents)
  const mentions = useMemo<MentionOption[]>(() => {
    if (providedMentions) return providedMentions;
    if (!agentMap) return [];
    return Array.from(agentMap.values())
      .filter((a) => a.status !== "terminated")
      .map((a) => ({
        id: `agent:${a.id}`,
        name: a.name,
        kind: "agent",
        agentId: a.id,
        agentIcon: a.icon,
      }));
  }, [agentMap, providedMentions]);

  // Scroll to comment when URL hash matches #comment-{id}
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#comment-") || comments.length + queuedComments.length === 0) return;
    const commentId = hash.slice("#comment-".length);
    // Only scroll once per hash
    if (hasScrolledRef.current) return;
    const el = document.getElementById(`comment-${commentId}`);
    if (el) {
      hasScrolledRef.current = true;
      setHighlightCommentId(commentId);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Clear highlight after animation
      const timer = setTimeout(() => setHighlightCommentId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [location.hash, comments, queuedComments]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h3 className="text-sm font-semibold shrink-0">
          Comments &amp; Runs ({timeline.length + queuedComments.length})
        </h3>
        
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs px-2 gap-1 shadow-none bg-accent/20">
                <ArrowUpDown className="h-3 w-3" />
                <span className="hidden sm:inline">Sắp xếp</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Sắp xếp theo thời gian</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sortOrder} onValueChange={(v) => setSortOrder(v as any)}>
                <DropdownMenuRadioItem value="asc">Cũ nhất trước</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="desc">Mới nhất trước</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs px-2 gap-1 shadow-none bg-accent/20">
                <Filter className="h-3 w-3" />
                <span className="hidden sm:inline">Lọc</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Theo Loại</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={filterKind} onValueChange={(v) => setFilterKind(v as any)}>
                <DropdownMenuRadioItem value="all">Tất cả</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="comment">Chỉ Comments</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="run">Chỉ Runs</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Theo Người tạo</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={filterAuthor} onValueChange={(v) => setFilterAuthor(v as any)}>
                <DropdownMenuRadioItem value="all">Tất cả</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="me">Của Tôi (You)</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="agent">Của Agent</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs px-2 gap-1 shadow-none bg-accent/20">
                <ListFilter className="h-3 w-3" />
                <span className="hidden sm:inline">Nhóm</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => setGroupBy(v as any)}>
                <DropdownMenuRadioItem value="none">Không nhóm</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="date">Theo Ngày</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="agent">Theo Agent</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="kind">Theo Loại (Comment/Run)</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="status">Theo Trạng thái</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Live run card pinned ABOVE the comments/runs list (most prominent — the
          currently-running heartbeat), regardless of the comment sort order. */}
      {liveRunSlot}

      {timeline.length > 0 || filterKind !== "all" || filterAuthor !== "all" ? (
        <TimelineList
          groupedTimeline={groupedTimeline}
          agentMap={agentMap}
          companyId={companyId}
          projectId={projectId}
          highlightCommentId={highlightCommentId}
          onAddAndReassign={handleAddAndReassign}
        />
      ) : null}

      {queuedComments.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
              Queued Comments ({queuedComments.length})
            </h4>
            {onInterruptQueued && queuedComments[0]?.queueTargetRunId ? (
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                disabled={interruptingQueuedRunId === queuedComments[0].queueTargetRunId}
                onClick={() => void onInterruptQueued(queuedComments[0]!.queueTargetRunId!)}
              >
                {interruptingQueuedRunId === queuedComments[0].queueTargetRunId ? "Interrupting..." : "Interrupt"}
              </Button>
            ) : null}
          </div>
          <div className="space-y-3">
            {queuedComments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                agentMap={agentMap}
                companyId={companyId}
                projectId={projectId}
                highlightCommentId={highlightCommentId}
                queued
                onAddAndReassign={handleAddAndReassign}
              />
            ))}
          </div>
        </div>
      )}

      <div className="sticky bottom-0 md:-bottom-6 z-10 -mx-1 px-3 pt-2.5 pb-2.5 mt-4 border-t border-border/60 bg-background shadow-[0_-6px_16px_-8px_rgba(0,0,0,0.08)]">
        <CommentComposer
          onAdd={onAdd}
          draftKey={draftKey}
          enableReassign={enableReassign}
          reassignOptions={reassignOptions}
          currentAssigneeValue={currentAssigneeValue}
          suggestedAssigneeValue={suggestedAssigneeValue}
          mentions={mentions}
          imageUploadHandler={imageUploadHandler}
          onAttachImage={onAttachImage}
          agentMap={agentMap}
        />
      </div>
    </div>
  );
}
