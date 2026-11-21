import { useMemo, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import {
  groupModels,
  isSingleModel,
  locateModel,
  variantLabel,
  type ModelBranch,
  type ModelOption,
} from "../lib/model-groups";

// Danh sách model dạng gom nhóm (chị Jennie 21/11): mỗi model gốc 1 dòng; Orchestrator gom
// 1 dòng → chọn planner Neon/Carbon/Argon → chọn mức thinking, giống bảng chọn Antigravity.
export function ModelGroupList({
  models,
  currentModel,
  disabled,
  onSelect,
}: {
  models: readonly ModelOption[];
  /** Mã model đang dùng (rỗng nếu agent ở adapter khác / mặc định). */
  currentModel: string;
  disabled: boolean;
  onSelect: (modelId: string) => void;
}) {
  const groups = useMemo(() => groupModels(models), [models]);
  const current = useMemo(() => locateModel(groups, currentModel), [groups, currentModel]);
  const [openKey, setOpenKey] = useState<string | null>(() => current?.group.key ?? null);

  return (
    <>
      {groups.map((group) => {
        const single = isSingleModel(group);
        const isCurrentGroup = current?.group.key === group.key;
        const expanded = !single && openKey === group.key;
        const summary = isCurrentGroup && current
          ? [current.branch.name, variantLabel(current.variant)].filter(Boolean).join(" · ")
          : null;
        return (
          <div key={group.key}>
            <button
              type="button"
              disabled={disabled}
              aria-expanded={single ? undefined : expanded}
              onClick={() =>
                single
                  ? onSelect(group.branches[0].variants[0].id)
                  : setOpenKey(expanded ? null : group.key)
              }
              className={cn(
                "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60 cursor-pointer disabled:opacity-60",
                isCurrentGroup && "bg-accent/40 font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{single ? group.label : group.name}</span>
              {summary && !single && (
                <span className="shrink-0 truncate text-[10px] text-muted-foreground">{summary}</span>
              )}
              {single ? (
                isCurrentGroup && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              ) : (
                <ChevronRight
                  className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
                />
              )}
            </button>
            {expanded && (
              <div className="space-y-1 bg-muted/30 px-2.5 py-1.5">
                {group.branches.map((branch) => (
                  <BranchLevels
                    key={branch.name ?? group.key}
                    branch={branch}
                    currentModel={currentModel}
                    disabled={disabled}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function BranchLevels({
  branch,
  currentModel,
  disabled,
  onSelect,
}: {
  branch: ModelBranch;
  currentModel: string;
  disabled: boolean;
  onSelect: (modelId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {branch.name && (
        <span className="w-full text-[10px] font-medium text-muted-foreground">Planner {branch.name}</span>
      )}
      {branch.variants.map((v) => {
        const active = v.id === currentModel;
        return (
          <button
            key={v.id}
            type="button"
            disabled={disabled}
            title={v.id}
            onClick={() => onSelect(v.id)}
            className={cn(
              "inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] transition-colors cursor-pointer disabled:opacity-60",
              active
                ? "border-primary bg-primary font-medium text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {variantLabel(v)}
            {active && <Check className="h-3 w-3" />}
          </button>
        );
      })}
    </div>
  );
}
