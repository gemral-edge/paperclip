// Gom danh sách model phẳng thành nhóm "model gốc → (planner) → mức thinking",
// để ô Đổi Model hiển thị gọn giống bảng chọn của Antigravity (chị Jennie 21/11).
// Thuần dữ liệu — không phụ thuộc React, dễ test.

export type ModelLevel = "Low" | "Medium" | "High" | "XHigh";

export const LEVEL_ORDER: readonly ModelLevel[] = ["Low", "Medium", "High", "XHigh"];

export const LEVEL_LABEL: Record<ModelLevel, string> = {
  Low: "Low",
  Medium: "Medium",
  High: "High",
  XHigh: "Extra High",
};

export interface ModelOption {
  id: string;
  label: string;
}

/** 1 mức thinking cụ thể = 1 mã model thật. level=null là bản không ghi mức (mặc định của agy). */
export interface ModelVariant {
  id: string;
  level: ModelLevel | null;
}

/** Nhánh con (vd planner "Gemini 4 Neon" của Orchestrator). Model thường có đúng 1 nhánh name=null. */
export interface ModelBranch {
  name: string | null;
  variants: ModelVariant[];
}

export interface ModelGroup {
  key: string;
  name: string;
  /** Nhãn gốc khi nhóm chỉ có 1 model, để giữ mô tả từ adapter. */
  label: string;
  branches: ModelBranch[];
}

const ORCH_RE = /^Orchestrator \((Neon|Carbon|Argon)(?: · (XHigh|High|Medium|Low))?\)$/;
const LEVEL_RE = /^(.*\S) \((XHigh|High|Medium|Low)\)$/;

function classify(id: string): { group: string; branch: string | null; level: ModelLevel | null } {
  const orch = ORCH_RE.exec(id);
  if (orch) {
    return { group: "Orchestrator", branch: `Gemini 4 ${orch[1]}`, level: (orch[2] as ModelLevel) ?? null };
  }
  const lv = LEVEL_RE.exec(id);
  if (lv) return { group: lv[1], branch: null, level: lv[2] as ModelLevel };
  return { group: id, branch: null, level: null };
}

function levelRank(level: ModelLevel | null): number {
  return level === null ? -1 : LEVEL_ORDER.indexOf(level);
}

export function groupModels(models: readonly ModelOption[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const m of models) {
    const c = classify(m.id);
    let g = groups.get(c.group);
    if (!g) {
      g = { key: c.group, name: c.group, label: m.label || m.id, branches: [] };
      groups.set(c.group, g);
    }
    let b = g.branches.find((x) => x.name === c.branch);
    if (!b) {
      b = { name: c.branch, variants: [] };
      g.branches.push(b);
    }
    if (!b.variants.some((v) => v.id === m.id)) b.variants.push({ id: m.id, level: c.level });
  }
  for (const g of groups.values()) {
    for (const b of g.branches) b.variants.sort((a, z) => levelRank(a.level) - levelRank(z.level));
  }
  return Array.from(groups.values());
}

/** Nhóm chỉ có đúng 1 mã model → bấm là chọn luôn, không cần mở menu con. */
export function isSingleModel(group: ModelGroup): boolean {
  return group.branches.length === 1 && group.branches[0].variants.length === 1;
}

/** Tìm vị trí của mã model đang dùng để đánh dấu ✓ và mở sẵn đúng nhánh. */
export function locateModel(
  groups: readonly ModelGroup[],
  id: string,
): { group: ModelGroup; branch: ModelBranch; variant: ModelVariant } | null {
  for (const group of groups) {
    for (const branch of group.branches) {
      const variant = branch.variants.find((v) => v.id === id);
      if (variant) return { group, branch, variant };
    }
  }
  return null;
}

export function variantLabel(v: ModelVariant): string {
  return v.level ? LEVEL_LABEL[v.level] : "Mặc định";
}
