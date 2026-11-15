import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentRevision, Issue, IssueDocument } from "@paperclipai/shared";
import { useLocation } from "@/lib/router";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, ChevronRight, Copy, Download, FileText, MoreHorizontal, Plus, Trash2, X, Pencil } from "lucide-react";

type DraftState = {
  key: string;
  title: string;
  body: string;
  baseRevisionId: string | null;
  isNew: boolean;
};

type DocumentConflictState = {
  key: string;
  serverDocument: IssueDocument;
  localDraft: DraftState;
  showRemote: boolean;
};

const DOCUMENT_AUTOSAVE_DEBOUNCE_MS = 900;
const DOCUMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function renderBody(body: string, className?: string) {
  return <MarkdownBody className={className}>{body}</MarkdownBody>;
}

function isPlanKey(key: string) {
  return key.trim().toLowerCase() === "plan";
}

function titlesMatchKey(title: string | null | undefined, key: string) {
  return (title ?? "").trim().toLowerCase() === key.trim().toLowerCase();
}

function isDocumentConflictError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function downloadDocumentFile(key: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${key}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getRevisionActorLabel(revision: DocumentRevision) {
  if (revision.createdByUserId) return "board";
  if (revision.createdByAgentId) return "agent";
  return "system";
}

function documentHasUnsavedChanges(doc: IssueDocument, draft: DraftState | null) {
  if (!draft || draft.isNew || draft.key !== doc.key) return false;
  return draft.body !== doc.body || (doc.title ?? "") !== draft.title;
}

/**
 * @archetype form
 */
export function IssueDocumentsSection({
  issue,
  canDeleteDocuments,
  mentions,
  imageUploadHandler,
  extraActions,
  focusDocumentRequest,
  newDocumentRequest,
}: {
  issue: Issue;
  canDeleteDocuments: boolean;
  mentions?: MentionOption[];
  imageUploadHandler?: (file: File) => Promise<string>;
  extraActions?: ReactNode;
  focusDocumentRequest?: { key: string; seq: number } | null;
  newDocumentRequest?: number;
}) {
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const queryClient = useQueryClient();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [documentConflict, setDocumentConflict] = useState<DocumentConflictState | null>(null);
  const [expandedDocumentKeys, setExpandedDocumentKeys] = useState<string[]>([]);
  const [autosaveDocumentKey, setAutosaveDocumentKey] = useState<string | null>(null);
  const [copiedDocumentKey, setCopiedDocumentKey] = useState<string | null>(null);
  const [highlightDocumentKey, setHighlightDocumentKey] = useState<string | null>(null);
  const [revisionMenuOpenKey, setRevisionMenuOpenKey] = useState<string | null>(null);
  const [selectedRevisionIds, setSelectedRevisionIds] = useState<Record<string, string | null>>({});
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedDocumentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRefsMap = useRef(new Map<string, MarkdownEditorRef>());
  const pendingFocusKeyRef = useRef<string | null>(null);
  const hasScrolledToHashRef = useRef(false);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  const {
    data: documents,
    isLoading: isDocumentsLoading,
    isError: isDocumentsError,
    error: documentsError,
    refetch: refetchDocuments,
  } = useQuery({
    queryKey: queryKeys.issues.documents(issue.id),
    queryFn: () => issuesApi.listDocuments(issue.id),
  });

  const { data: activeDocumentRevisions, isFetching: isFetchingDocumentRevisions } = useQuery({
    queryKey: revisionMenuOpenKey
      ? queryKeys.issues.documentRevisions(issue.id, revisionMenuOpenKey)
      : ["issues", "document-revisions", issue.id, "__idle__"],
    queryFn: async () => {
      if (!revisionMenuOpenKey) return [];
      return issuesApi.listDocumentRevisions(issue.id, revisionMenuOpenKey);
    },
    enabled: Boolean(revisionMenuOpenKey),
  });

  const invalidateIssueDocuments = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
    queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey)
        && query.queryKey[0] === "issues"
        && query.queryKey[1] === "document-revisions"
        && query.queryKey[2] === issue.id,
    });
  }, [issue.id, queryClient]);

  const upsertDocument = useMutation({
    mutationFn: async (nextDraft: DraftState) =>
      issuesApi.upsertDocument(issue.id, nextDraft.key, {
        title: isPlanKey(nextDraft.key) ? null : nextDraft.title.trim() || null,
        format: "markdown",
        body: nextDraft.body,
        baseRevisionId: nextDraft.baseRevisionId,
      }),
  });

  const deleteDocument = useMutation({
    mutationFn: (key: string) => issuesApi.deleteDocument(issue.id, key),
    onSuccess: (_data, key) => {
      setError(null);
      setExpandedDocumentKeys((current) => current.filter((entry) => entry !== key));
      invalidateIssueDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to delete document");
    },
  });

  const restoreDocumentRevision = useMutation({
    mutationFn: ({ key, revisionId }: { key: string; revisionId: string }) =>
      issuesApi.restoreDocumentRevision(issue.id, key, revisionId),
    onSuccess: (_document, variables) => {
      setSelectedRevisionIds((current) => ({ ...current, [variables.key]: null }));
      setDraft((current) => current?.key === variables.key ? null : current);
      setDocumentConflict((current) => current?.key === variables.key ? null : current);
      resetAutosaveState();
      setError(null);
      invalidateIssueDocuments();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to restore document revision");
    },
  });

  const sortedDocuments = useMemo(() => {
    return [...(documents ?? [])].sort((a, b) => {
      if (a.key === "plan" && b.key !== "plan") return -1;
      if (a.key !== "plan" && b.key === "plan") return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [documents]);

  const hasRealPlan = sortedDocuments.some((doc) => doc.key === "plan");
  const isEmpty = !isDocumentsLoading && !isDocumentsError && sortedDocuments.length === 0 && !issue.legacyPlanDocument;
  const newDocumentKeyError =
    draft?.isNew && draft.key.trim().length > 0 && !DOCUMENT_KEY_PATTERN.test(draft.key.trim())
      ? "Use lowercase letters, numbers, -, or _, and start with a letter or number."
      : null;

  const resetAutosaveState = useCallback(() => {
    setAutosaveDocumentKey(null);
    reset();
  }, [reset]);

  const markDocumentDirty = useCallback((key: string) => {
    setAutosaveDocumentKey(key);
    markDirty();
  }, [markDirty]);

  const beginNewDocument = () => {
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft({
      key: "",
      title: "",
      body: "",
      baseRevisionId: null,
      isNew: true,
    });
    setError(null);
  };

  const beginEditAndFocus = (key: string) => {
    pendingFocusKeyRef.current = key;
    beginEdit(key);
  };

  const beginEdit = (key: string) => {
    const doc = sortedDocuments.find((entry) => entry.key === key);
    if (!doc) return;
    const conflictedDraft = documentConflict?.key === key ? documentConflict.localDraft : null;
    setExpandedDocumentKeys((current) => current.includes(key) ? current : [...current, key]);
    resetAutosaveState();
    setDocumentConflict((current) => current?.key === key ? current : null);
    setDraft({
      key: conflictedDraft?.key ?? doc.key,
      title: conflictedDraft?.title ?? doc.title ?? "",
      body: conflictedDraft?.body ?? doc.body,
      baseRevisionId: conflictedDraft?.baseRevisionId ?? doc.latestRevisionId,
      isNew: false,
    });
    setError(null);
  };

  const cancelDraft = () => {
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    resetAutosaveState();
    setDocumentConflict(null);
    setDraft(null);
    setError(null);
  };

  const commitDraft = useCallback(async (
    currentDraft: DraftState | null,
    options?: { clearAfterSave?: boolean; trackAutosave?: boolean; overrideConflict?: boolean },
  ) => {
    if (!currentDraft || upsertDocument.isPending) return false;
    const normalizedKey = currentDraft.key.trim().toLowerCase();
    const normalizedBody = currentDraft.body.trim();
    const normalizedTitle = currentDraft.title.trim();
    const activeConflict = documentConflict?.key === normalizedKey ? documentConflict : null;

    if (activeConflict && !options?.overrideConflict) {
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    if (!normalizedKey || !normalizedBody) {
      if (currentDraft.isNew) {
        setError("Document key and body are required");
      } else if (!normalizedBody) {
        setError("Document body cannot be empty");
      }
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    if (!DOCUMENT_KEY_PATTERN.test(normalizedKey)) {
      setError("Document key must start with a letter or number and use only lowercase letters, numbers, -, or _.");
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return false;
    }

    const existing = sortedDocuments.find((doc) => doc.key === normalizedKey);
    if (
      !currentDraft.isNew &&
      existing &&
      existing.body === currentDraft.body &&
      (existing.title ?? "") === currentDraft.title
    ) {
      if (options?.clearAfterSave) {
        setDraft((value) => (value?.key === normalizedKey ? null : value));
      }
      if (options?.trackAutosave) {
        resetAutosaveState();
      }
      return true;
    }

    const save = async () => {
      const saved = await upsertDocument.mutateAsync({
        ...currentDraft,
        key: normalizedKey,
        title: isPlanKey(normalizedKey) ? "" : normalizedTitle,
        body: currentDraft.body,
        baseRevisionId: options?.overrideConflict
          ? activeConflict?.serverDocument.latestRevisionId ?? currentDraft.baseRevisionId
          : currentDraft.baseRevisionId,
      });
      setError(null);
      setDocumentConflict((current) => current?.key === normalizedKey ? null : current);
      setDraft((value) => {
        if (!value || value.key !== normalizedKey) return value;
        if (options?.clearAfterSave) return null;
        return {
          key: saved.key,
          title: saved.title ?? "",
          body: saved.body,
          baseRevisionId: saved.latestRevisionId,
          isNew: false,
        };
      });
      invalidateIssueDocuments();
    };

    try {
      if (options?.trackAutosave) {
        setAutosaveDocumentKey(normalizedKey);
        await runSave(save);
      } else {
        await save();
      }
      return true;
    } catch (err) {
      if (isDocumentConflictError(err)) {
        try {
          const latestDocument = await issuesApi.getDocument(issue.id, normalizedKey);
          setDocumentConflict({
            key: normalizedKey,
            serverDocument: latestDocument,
            localDraft: {
              key: normalizedKey,
              title: isPlanKey(normalizedKey) ? "" : normalizedTitle,
              body: currentDraft.body,
              baseRevisionId: currentDraft.baseRevisionId,
              isNew: false,
            },
            showRemote: true,
          });
          setExpandedDocumentKeys((current) => current.includes(normalizedKey) ? current : [...current, normalizedKey]);
          setError(null);
          resetAutosaveState();
          return false;
        } catch {
          setError("Document changed remotely and the latest version could not be loaded");
          return false;
        }
      }
      setError(err instanceof Error ? err.message : "Failed to save document");
      return false;
    }
  }, [documentConflict, invalidateIssueDocuments, issue.id, resetAutosaveState, runSave, sortedDocuments, upsertDocument]);

  const reloadDocumentFromServer = useCallback((key: string) => {
    if (documentConflict?.key !== key) return;
    const serverDocument = documentConflict.serverDocument;
    setDraft({
      key: serverDocument.key,
      title: serverDocument.title ?? "",
      body: serverDocument.body,
      baseRevisionId: serverDocument.latestRevisionId,
      isNew: false,
    });
    setDocumentConflict(null);
    resetAutosaveState();
    setError(null);
  }, [documentConflict, resetAutosaveState]);

  const overwriteDocumentFromDraft = useCallback(async (key: string) => {
    if (documentConflict?.key !== key) return;
    const sourceDraft =
      draft && draft.key === key && !draft.isNew
        ? draft
        : documentConflict.localDraft;
    await commitDraft(
      {
        ...sourceDraft,
        baseRevisionId: documentConflict.serverDocument.latestRevisionId,
      },
      {
        clearAfterSave: false,
        trackAutosave: true,
        overrideConflict: true,
      },
    );
  }, [commitDraft, documentConflict, draft]);

  const keepConflictedDraft = useCallback((key: string) => {
    if (documentConflict?.key !== key) return;
    setDraft(documentConflict.localDraft);
    setDocumentConflict((current) =>
      current?.key === key
        ? { ...current, showRemote: false }
        : current,
    );
    setError(null);
  }, [documentConflict]);

  const copyDocumentBody = useCallback(async (key: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedDocumentKey(key);
      if (copiedDocumentTimerRef.current) {
        clearTimeout(copiedDocumentTimerRef.current);
      }
      copiedDocumentTimerRef.current = setTimeout(() => {
        setCopiedDocumentKey((current) => current === key ? null : current);
      }, 1400);
    } catch {
      setError("Could not copy document");
    }
  }, []);

  const getDocumentRevisions = useCallback((key: string) => {
    const cached = queryClient.getQueryData<DocumentRevision[]>(queryKeys.issues.documentRevisions(issue.id, key));
    if (cached) return cached;
    if (revisionMenuOpenKey === key) return activeDocumentRevisions ?? [];
    return [];
  }, [activeDocumentRevisions, issue.id, queryClient, revisionMenuOpenKey]);

  const returnToLatestRevision = useCallback((key: string) => {
    setSelectedRevisionIds((current) => ({ ...current, [key]: null }));
    setError(null);
  }, []);

  const previewRevision = useCallback((doc: IssueDocument, revisionId: string) => {
    const revisions = getDocumentRevisions(doc.key);
    const selectedRevision = revisions.find((revision) => revision.id === revisionId);
    if (!selectedRevision) return;
    if (selectedRevision.id === doc.latestRevisionId) {
      returnToLatestRevision(doc.key);
      return;
    }
    if (documentConflict?.key === doc.key || documentHasUnsavedChanges(doc, draft)) {
      setError("Save or cancel your local changes before viewing an older revision.");
      return;
    }
    resetAutosaveState();
    setDraft((current) => current?.key === doc.key ? null : current);
    setDocumentConflict((current) => current?.key === doc.key ? null : current);
    setExpandedDocumentKeys((current) => current.includes(doc.key) ? current : [...current, doc.key]);
    setSelectedRevisionIds((current) => ({ ...current, [doc.key]: selectedRevision.id }));
    setError(null);
  }, [documentConflict, draft, getDocumentRevisions, resetAutosaveState, returnToLatestRevision]);

  const handleDraftBlur = async (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    await commitDraft(draft, { clearAfterSave: true, trackAutosave: true });
  };

  const handleDraftKeyDown = async (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDraft();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      await commitDraft(draft, { clearAfterSave: false, trackAutosave: true });
    }
  };

  useEffect(() => {
    setExpandedDocumentKeys([]);
  }, [issue.id]);

  useEffect(() => {
    hasScrolledToHashRef.current = false;
  }, [issue.id, location.hash]);

  useEffect(() => {
    if (!documentConflict) return;
    const latest = sortedDocuments.find((doc) => doc.key === documentConflict.key);
    if (!latest || latest.latestRevisionId === documentConflict.serverDocument.latestRevisionId) return;
    setDocumentConflict((current) =>
      current?.key === latest.key
        ? { ...current, serverDocument: latest }
        : current,
    );
  }, [documentConflict, sortedDocuments]);

  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith("#document-")) return;
    const documentKey = decodeURIComponent(hash.slice("#document-".length));
    const targetExists = sortedDocuments.some((doc) => doc.key === documentKey)
      || (documentKey === "plan" && Boolean(issue.legacyPlanDocument));
    if (!targetExists || hasScrolledToHashRef.current) return;
    setExpandedDocumentKeys((current) => current.includes(documentKey) ? current : [...current, documentKey]);
    const element = document.getElementById(`document-${documentKey}`);
    if (!element) return;
    hasScrolledToHashRef.current = true;
    setHighlightDocumentKey(documentKey);
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightDocumentKey((current) => current === documentKey ? null : current), 3000);
    return () => clearTimeout(timer);
  }, [issue.legacyPlanDocument, location.hash, sortedDocuments]);

  const focusHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocusedSeqRef = useRef(0);
  useEffect(() => {
    if (!focusDocumentRequest) {
      lastFocusedSeqRef.current = 0;
      return;
    }
    if (focusDocumentRequest.seq === lastFocusedSeqRef.current) return;
    const targetKey = focusDocumentRequest.key;
    const targetExists = sortedDocuments.some((doc) => doc.key === targetKey)
      || (targetKey === "plan" && Boolean(issue.legacyPlanDocument));
    if (!targetExists) return;
    lastFocusedSeqRef.current = focusDocumentRequest.seq;
    setExpandedDocumentKeys((current) =>
      current.includes(targetKey) ? current : [...current, targetKey],
    );
    setHighlightDocumentKey(targetKey);
    requestAnimationFrame(() => {
      const element = document.getElementById(`document-${targetKey}`);
      element?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    if (focusHighlightTimerRef.current) {
      clearTimeout(focusHighlightTimerRef.current);
    }
    focusHighlightTimerRef.current = setTimeout(() => {
      focusHighlightTimerRef.current = null;
      setHighlightDocumentKey((current) => (current === targetKey ? null : current));
    }, 3000);
  }, [focusDocumentRequest, issue.legacyPlanDocument, sortedDocuments]);

  const lastHandledNewDocumentRequestRef = useRef(0);
  useEffect(() => {
    if (!newDocumentRequest) {
      lastHandledNewDocumentRequestRef.current = 0;
      return;
    }
    if (newDocumentRequest <= lastHandledNewDocumentRequestRef.current) return;
    lastHandledNewDocumentRequestRef.current = newDocumentRequest;
    beginNewDocument();
  }, [newDocumentRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
      if (copiedDocumentTimerRef.current) {
        clearTimeout(copiedDocumentTimerRef.current);
      }
      if (focusHighlightTimerRef.current) {
        clearTimeout(focusHighlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const pendingKey = pendingFocusKeyRef.current;
    if (!pendingKey || !draft || draft.key !== pendingKey || draft.isNew) return;
    pendingFocusKeyRef.current = null;
    const editorRef = editorRefsMap.current.get(pendingKey);
    if (editorRef) {
      requestAnimationFrame(() => editorRef.focus());
    }
  }, [draft]);

  useEffect(() => {
    if (!draft || draft.isNew) return;
    if (documentConflict?.key === draft.key) return;
    const existing = sortedDocuments.find((doc) => doc.key === draft.key);
    if (!existing) return;
    const hasChanges =
      existing.body !== draft.body ||
      (existing.title ?? "") !== draft.title;
    if (!hasChanges) {
      if (autosaveState !== "saved") {
        resetAutosaveState();
      }
      return;
    }
    markDocumentDirty(draft.key);
    if (autosaveDebounceRef.current) {
      clearTimeout(autosaveDebounceRef.current);
    }
    autosaveDebounceRef.current = setTimeout(() => {
      void commitDraft(draft, { clearAfterSave: false, trackAutosave: true });
    }, DOCUMENT_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveDebounceRef.current) {
        clearTimeout(autosaveDebounceRef.current);
      }
    };
  }, [autosaveState, commitDraft, documentConflict, draft, markDocumentDirty, resetAutosaveState, sortedDocuments]);

  // Dirty-guard: tài liệu mới chưa lưu (autosave bỏ qua bản mới) hoặc tài liệu đang sửa
  // khác bản đã lưu (gồm cả trường hợp xung đột revision, autosave bị chặn).
  const isDirty = draft != null && (
    draft.isNew
      ? draft.key.trim() !== "" || draft.title.trim() !== "" || draft.body.trim() !== ""
      : sortedDocuments.some((doc) => documentHasUnsavedChanges(doc, draft))
  );
  useUnsavedChangesGuard(isDirty, upsertDocument.isPending);

  const documentBodyShellClassName = "mt-3 rounded-md";
  const documentBodyPaddingClassName = "";
  const documentBodyContentClassName = "paperclip-edit-in-place-content min-h-[220px] text-[15px] leading-7";
  const toggleFoldedDocument = (key: string) => {
    setExpandedDocumentKeys((current) =>
      current.includes(key)
        ? current.filter((entry) => entry !== key)
        : [...current, key],
    );
  };

  const allDocumentKeys = useMemo(() => {
    const keys = sortedDocuments.map((doc) => doc.key);
    if (!hasRealPlan && issue.legacyPlanDocument) keys.unshift("plan");
    return keys;
  }, [sortedDocuments, hasRealPlan, issue.legacyPlanDocument]);
  const allFolded = allDocumentKeys.length > 0 && allDocumentKeys.every((key) => !expandedDocumentKeys.includes(key));

  const toggleAllDocuments = () => {
    if (allFolded) {
      // Mở tất cả
      setExpandedDocumentKeys(allDocumentKeys);
    } else {
      // Đóng tất cả
      setExpandedDocumentKeys([]);
    }
  };

  const isLegacyPlanFolded = !expandedDocumentKeys.includes("plan");

  return (
    <div className="space-y-3">
      {isEmpty && !draft?.isNew ? (
        <div className="flex items-center justify-end gap-2 min-w-0">
          {extraActions}
          <Button variant="outline" size="sm" onClick={beginNewDocument} className="shrink-0">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            <span className="hidden sm:inline">New document</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <button
            type="button"
            className="flex items-center gap-1.5 shrink-0 group"
            onClick={toggleAllDocuments}
            aria-label={allFolded ? "Expand all documents" : "Collapse all documents"}
            title={allFolded ? "Expand all documents" : "Collapse all documents"}
          >
            {allFolded
              ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />}
            <h3 className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
              Documents{sortedDocuments.length > 0 ? ` (${sortedDocuments.length})` : ""}
            </h3>
          </button>
          <div className="flex items-center gap-2 min-w-0">
            {extraActions}
            <Button variant="outline" size="sm" onClick={beginNewDocument} className="shrink-0">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              <span className="hidden sm:inline">New document</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isDocumentsLoading && (
        <div className="space-y-2" aria-busy="true">
          <div className="h-12 animate-pulse rounded-lg border border-border bg-accent/20" />
        </div>
      )}

      {isDocumentsError && !isDocumentsLoading && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>{documentsError instanceof Error ? documentsError.message : "Failed to load documents."}</span>
          <Button variant="outline" size="xs" onClick={() => void refetchDocuments()}>
            Retry
          </Button>
        </div>
      )}

      {draft?.isNew && (
        <div
          className="space-y-3 rounded-lg border border-border bg-accent/10 p-3"
          onBlurCapture={handleDraftBlur}
          onKeyDown={handleDraftKeyDown}
        >
          <Input
            autoFocus
            value={draft.key}
            onChange={(event) =>
              setDraft((current) => current ? { ...current, key: event.target.value.toLowerCase() } : current)
            }
            placeholder="Document key"
          />
          {newDocumentKeyError && (
            <p className="text-xs text-destructive">{newDocumentKeyError}</p>
          )}
          {!isPlanKey(draft.key) && (
            <Input
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => current ? { ...current, title: event.target.value } : current)
              }
              placeholder="Optional title"
            />
          )}
          <MarkdownEditor
            value={draft.body}
            onChange={(body) =>
              setDraft((current) => current ? { ...current, body } : current)
            }
            placeholder="Markdown body"
            bordered={false}
            className="bg-transparent"
            contentClassName="min-h-[220px] text-[15px] leading-7"
            mentions={mentions}
            imageUploadHandler={imageUploadHandler}
            onSubmit={() => void commitDraft(draft, { clearAfterSave: false, trackAutosave: false })}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={cancelDraft}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void commitDraft(draft, { clearAfterSave: false, trackAutosave: false })}
              disabled={upsertDocument.isPending}
            >
              {upsertDocument.isPending ? "Saving..." : "Create document"}
            </Button>
          </div>
        </div>
      )}

      {!hasRealPlan && issue.legacyPlanDocument ? (
        <div
          id="document-plan"
          className={cn(
            "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 transition-colors duration-1000",
            highlightDocumentKey === "plan" && "border-primary/50 bg-primary/5",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left cursor-pointer group"
            onClick={() => toggleFoldedDocument("plan")}
            aria-label={isLegacyPlanFolded ? "Expand plan document" : "Collapse plan document"}
            aria-expanded={!isLegacyPlanFolded}
          >
            {isLegacyPlanFolded
              ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-amber-600/80 group-hover:text-amber-600 transition-colors" />
              : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-600/80 group-hover:text-amber-600 transition-colors" />}
            <FileText className="h-4 w-4 text-amber-600 shrink-0" />
            <span className="rounded-full border border-amber-500/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
              PLAN
            </span>
          </button>
          {!isLegacyPlanFolded ? (
            <div className={cn("mt-3", documentBodyPaddingClassName)}>
              {renderBody(issue.legacyPlanDocument.body, documentBodyContentClassName)}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {sortedDocuments.map((doc) => {
          const activeDraft = draft?.key === doc.key && !draft.isNew ? draft : null;
          const activeConflict = documentConflict?.key === doc.key ? documentConflict : null;
          const isFolded = !expandedDocumentKeys.includes(doc.key);
          const revisionHistory = getDocumentRevisions(doc.key);
          const selectedRevisionId = selectedRevisionIds[doc.key] ?? null;
          const selectedHistoricalRevision = selectedRevisionId
            ? revisionHistory.find((revision) => revision.id === selectedRevisionId) ?? null
            : null;
          const isHistoricalPreview = Boolean(selectedHistoricalRevision);
          const displayedTitle = selectedHistoricalRevision
            ? selectedHistoricalRevision.title ?? ""
            : activeDraft?.title ?? doc.title ?? "";
          const displayedBody = selectedHistoricalRevision?.body ?? activeDraft?.body ?? doc.body;
          const displayedRevisionNumber = selectedHistoricalRevision?.revisionNumber ?? doc.latestRevisionNumber;
          const displayedUpdatedAt = selectedHistoricalRevision?.createdAt ?? doc.updatedAt;
          // Hiển thị title nếu không phải plan key VÀ có title (bất kể title có trùng với key hay không)
          const showTitle = !isPlanKey(doc.key) && !!displayedTitle.trim();

          // Khi không có title và đang đóng → hiện preview dòng đầu tiên của body
          const previewText =
            !showTitle && isFolded && displayedBody
              ? (displayedBody
                  .replace(/^#{1,6}\s+/gm, "") // bỏ heading markers
                  .replace(/[*_`~\[\]]/g, "")  // bỏ markdown inline
                  .split("\n")
                  .map((l) => l.trim())
                  .find((l) => l.length > 0)
                  ?.slice(0, 130) ?? "")
              : "";
          const showPreview = !!previewText;

          return (
            <div
              key={doc.id}
              id={`document-${doc.key}`}
              className={cn(
                "rounded-lg border border-border p-3 transition-colors duration-1000",
                highlightDocumentKey === doc.key && "border-primary/50 bg-primary/5",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                      onClick={() => toggleFoldedDocument(doc.key)}
                      aria-label={isFolded ? `Expand ${doc.key} document` : `Collapse ${doc.key} document`}
                      aria-expanded={!isFolded}
                    >
                      {isFolded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground cursor-pointer"
                      onClick={() => toggleFoldedDocument(doc.key)}
                      aria-expanded={!isFolded}
                    >
                      {doc.key}
                    </button>
                    <DropdownMenu
                      open={revisionMenuOpenKey === doc.key}
                      onOpenChange={(open) => setRevisionMenuOpenKey(open ? doc.key : null)}
                    >
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-auto px-1.5 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground",
                            isHistoricalPreview && "text-amber-300 hover:text-amber-200",
                          )}
                        >
                          rev {displayedRevisionNumber}
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-72">
                        <DropdownMenuLabel>Revision history</DropdownMenuLabel>
                        {revisionMenuOpenKey === doc.key && isFetchingDocumentRevisions && revisionHistory.length === 0 ? (
                          <DropdownMenuItem disabled>Loading revisions...</DropdownMenuItem>
                        ) : revisionHistory.length > 0 ? (
                          <DropdownMenuRadioGroup value={selectedRevisionId ?? doc.latestRevisionId ?? ""}>
                            {revisionHistory.map((revision) => {
                              const isCurrentRevision = revision.id === doc.latestRevisionId;
                              return (
                                <DropdownMenuRadioItem
                                  key={revision.id}
                                  value={revision.id}
                                  onSelect={() => previewRevision(doc, revision.id)}
                                  className="items-start"
                                >
                                  <div className="flex min-w-0 flex-col">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium">rev {revision.revisionNumber}</span>
                                      {isCurrentRevision ? (
                                        <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                          Current
                                        </span>
                                      ) : null}
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                      {relativeTime(revision.createdAt)} • {getRevisionActorLabel(revision)}
                                    </span>
                                  </div>
                                </DropdownMenuRadioItem>
                              );
                            })}
                          </DropdownMenuRadioGroup>
                        ) : (
                          <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span
                      className="truncate text-[11px] text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                      title={`Document key: ${doc.key}`}
                      onClick={() => toggleFoldedDocument(doc.key)}
                    >
                      updated {relativeTime(displayedUpdatedAt)}
                    </span>
                  </div>
                  {/* Title luôn hiển thị bên dưới header bất kể document đang đóng hay mở */}
                  {showTitle && (
                    <button
                      type="button"
                      onClick={() => toggleFoldedDocument(doc.key)}
                      className="mt-1.5 block w-full text-left text-sm font-medium text-foreground leading-snug hover:text-primary transition-colors cursor-pointer"
                    >
                      {displayedTitle}
                    </button>
                  )}
                  {/* Preview dòng đầu body khi không có title và đang đóng */}
                  {showPreview && (
                    <button
                      type="button"
                      onClick={() => toggleFoldedDocument(doc.key)}
                      className="mt-1 block w-full text-left text-xs text-muted-foreground leading-snug truncate italic hover:text-foreground transition-colors cursor-pointer"
                    >
                      {previewText}…
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isHistoricalPreview && !activeDraft && !activeConflict && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground transition-colors hover:text-foreground"
                      title="Edit document"
                      aria-label="Edit document"
                      onClick={() => beginEditAndFocus(doc.key)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      "text-muted-foreground transition-colors",
                      copiedDocumentKey === doc.key && "text-foreground",
                    )}
                    title={copiedDocumentKey === doc.key ? "Copied" : "Copy document"}
                    aria-label={copiedDocumentKey === doc.key ? "Copied" : "Copy document"}
                    onClick={() => void copyDocumentBody(doc.key, displayedBody)}
                  >
                    {copiedDocumentKey === doc.key ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {canDeleteDocuments ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground transition-colors hover:text-destructive"
                      title="Delete document"
                      aria-label="Delete document"
                      disabled={deleteDocument.isPending}
                      onClick={() => deleteDocument.mutate(doc.key)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        title="Document actions"
                        aria-label="Document actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => downloadDocumentFile(doc.key, displayedBody)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download document
                      </DropdownMenuItem>
                      {canDeleteDocuments ? <DropdownMenuSeparator /> : null}
                      {canDeleteDocuments ? (
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={deleteDocument.isPending}
                          onClick={() => deleteDocument.mutate(doc.key)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete document
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {!isFolded ? (
                <div
                  className="mt-3 space-y-3"
                  onFocusCapture={!isHistoricalPreview
                    ? () => {
                        if (!activeDraft) {
                          beginEdit(doc.key);
                        }
                      }
                    : undefined}
                  onBlurCapture={!isHistoricalPreview
                    ? async (event) => {
                        if (activeDraft) {
                          await handleDraftBlur(event);
                        }
                      }
                    : undefined}
                  onKeyDown={!isHistoricalPreview
                    ? async (event) => {
                        if (activeDraft) {
                          await handleDraftKeyDown(event);
                        }
                      }
                    : undefined}
                >
                  {isHistoricalPreview && selectedHistoricalRevision && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-amber-200">
                            Viewing revision {selectedHistoricalRevision.revisionNumber}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            This is a historical preview. Restoring it creates a new latest revision and keeps history append-only.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => returnToLatestRevision(doc.key)}
                          >
                            Return to latest
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => restoreDocumentRevision.mutate({
                              key: doc.key,
                              revisionId: selectedHistoricalRevision.id,
                            })}
                            disabled={restoreDocumentRevision.isPending}
                          >
                            {restoreDocumentRevision.isPending && restoreDocumentRevision.variables?.key === doc.key
                              ? "Restoring..."
                              : "Restore this revision"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                  {activeConflict && !isHistoricalPreview && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-amber-200">Out of date</p>
                          <p className="text-xs text-muted-foreground">
                            This document changed while you were editing. Your local draft is preserved and autosave is paused.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setDocumentConflict((current) =>
                                current?.key === doc.key
                                  ? { ...current, showRemote: !current.showRemote }
                                  : current,
                              )
                            }
                          >
                            {activeConflict.showRemote ? "Hide remote" : "Review remote"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => keepConflictedDraft(doc.key)}
                          >
                            Keep my draft
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => reloadDocumentFromServer(doc.key)}
                          >
                            Reload remote
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void overwriteDocumentFromDraft(doc.key)}
                            disabled={upsertDocument.isPending}
                          >
                            {upsertDocument.isPending ? "Saving..." : "Overwrite remote"}
                          </Button>
                        </div>
                      </div>
                      {activeConflict.showRemote && (
                        <div className="mt-3 rounded-md border border-border/70 bg-background/60 p-3">
                          <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>Remote revision {activeConflict.serverDocument.latestRevisionNumber}</span>
                            <span>•</span>
                            <span>updated {relativeTime(activeConflict.serverDocument.updatedAt)}</span>
                          </div>
                          {!isPlanKey(doc.key) && activeConflict.serverDocument.title ? (
                            <p className="mb-2 text-sm font-medium">{activeConflict.serverDocument.title}</p>
                          ) : null}
                          {renderBody(activeConflict.serverDocument.body, "text-[14px] leading-7")}
                        </div>
                      )}
                    </div>
                  )}
                  {activeDraft && !isPlanKey(doc.key) && !isHistoricalPreview && (
                    <Input
                      value={activeDraft.title}
                      onChange={(event) => {
                        markDocumentDirty(doc.key);
                        setDraft((current) => current ? { ...current, title: event.target.value } : current);
                      }}
                      placeholder="Optional title"
                    />
                  )}
                  <div
                    className={`${documentBodyShellClassName} ${documentBodyPaddingClassName}`}
                  >
                    {isHistoricalPreview ? (
                      <div className="rounded-md border border-amber-500/20 bg-background/50 p-3">
                        {renderBody(displayedBody, documentBodyContentClassName)}
                      </div>
                    ) : activeDraft ? (
                      <MarkdownEditor
                        ref={(editorRef) => {
                          if (editorRef) editorRefsMap.current.set(doc.key, editorRef);
                          else editorRefsMap.current.delete(doc.key);
                        }}
                        value={displayedBody}
                        onChange={(body) => {
                          markDocumentDirty(doc.key);
                          setDraft((current) => {
                            if (current && current.key === doc.key && !current.isNew) {
                              return { ...current, body };
                            }
                            return {
                              key: doc.key,
                              title: doc.title ?? "",
                              body,
                              baseRevisionId: doc.latestRevisionId,
                              isNew: false,
                            };
                          });
                        }}
                        placeholder="Markdown body"
                        bordered={false}
                        className="bg-transparent"
                        contentClassName={documentBodyContentClassName}
                        mentions={mentions}
                        imageUploadHandler={imageUploadHandler}
                        onSubmit={() => void commitDraft(activeDraft ?? draft, { clearAfterSave: false, trackAutosave: true })}
                      />
                    ) : (
                      <div>
                        {renderBody(displayedBody, documentBodyContentClassName)}
                      </div>
                    )}
                  </div>
                  <div className="flex min-h-4 items-center justify-end px-1">
                    <span
                      className={`text-[11px] transition-opacity duration-150 ${
                        isHistoricalPreview
                          ? "text-amber-300"
                          : activeConflict
                          ? "text-amber-300"
                          : autosaveState === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      } ${activeDraft || isHistoricalPreview ? "opacity-100" : "opacity-0"}`}
                    >
                      {isHistoricalPreview
                        ? "Viewing historical revision"
                        : activeDraft
                          ? activeConflict
                          ? "Out of date"
                          : autosaveDocumentKey === doc.key
                            ? autosaveState === "saving"
                              ? "Autosaving..."
                              : autosaveState === "saved"
                                ? "Saved"
                                : autosaveState === "error"
                                  ? "Could not save"
                                  : ""
                            : ""
                          : ""}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
