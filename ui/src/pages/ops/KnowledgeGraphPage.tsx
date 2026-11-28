// Knowledge Graph Page — "Mắt Thần CEO"
// Main page: 3D graph + controls + entity detail panel + dedup tab

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Network, Layers } from "lucide-react";
import { knowledgeGraphApi } from "@/api/knowledge-graph";
import { queryKeys } from "@/lib/queryKeys";
import ForceGraph3D from "@/components/knowledge-graph/ForceGraph3D";
import EntityDetailPanel from "@/components/knowledge-graph/EntityDetailPanel";
import GraphControls from "@/components/knowledge-graph/GraphControls";
import DedupTab from "@/components/knowledge-graph/DedupTab";
import { useGraphStore } from "@/components/knowledge-graph/useGraphStore";
import GraphStylePanel, { GRAPH_PRESETS } from "@/components/knowledge-graph/GraphStylePanel";
import type { GraphStyle } from "@/components/knowledge-graph/GraphStylePanel";
import { ENTITY_TYPES } from "@/lib/kg-config";
import type { KGEntity, KGRelation, EntityType } from "@/api/kg-types";
import {
  graphifyToPaperclip,
  type GraphifyJSON,
  type GraphifyImportStats,
} from "@/lib/graphify-adapter";

type Tab = "graph" | "dedup";
type SourceMode = "live" | "graphify";

export default function KnowledgeGraphPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("graph");
  const [detailEntityId, setDetailEntityId] = useState<string | null>(null);
  const [showSidebars, setShowSidebars] = useState(true);
  const [activePreset, setActivePreset] = useState("gem_gold");
  const [graphStyle, setGraphStyle] = useState<GraphStyle>(GRAPH_PRESETS.gem_gold);

  const {
    selectedEntityId,
    selectEntity,
    setHighlights,
    activeFilters,
    toggleFilter,
    clearFilters,
    searchQuery,
    maxDepth,
    isFullscreen,
  } = useGraphStore();

  // Fetch graph data
  const { data: graphData, isLoading: graphLoading } = useQuery({
    queryKey: queryKeys.knowledgeGraph.graph(
      activeFilters.size > 0 ? Array.from(activeFilters).join(",") : undefined,
      50,
    ),
    queryFn: () =>
      knowledgeGraphApi.getGraph({
        limit: 50,
        types: activeFilters.size > 0 ? Array.from(activeFilters).join(",") : undefined,
      }),
  });

  // Fetch stats
  const { data: stats } = useQuery({
    queryKey: queryKeys.knowledgeGraph.stats,
    queryFn: () => knowledgeGraphApi.getStats(),
  });

  // Seed mutation
  const seedMutation = useMutation({
    mutationFn: () => knowledgeGraphApi.seed(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kg"] });
    },
  });

  // ──────────────────────────────────────────────────────
  // Graphify mode — load knowledge/code graph from graphify JSON
  // (alternative source to the live API)
  // ──────────────────────────────────────────────────────
  const [sourceMode, setSourceMode] = useState<SourceMode>("live");
  const [graphifyEntities, setGraphifyEntities] = useState<KGEntity[]>([]);
  const [graphifyRelations, setGraphifyRelations] = useState<KGRelation[]>([]);
  const [graphifyStats, setGraphifyStats] = useState<GraphifyImportStats | null>(null);
  const [graphifyLabel, setGraphifyLabel] = useState<string>("");
  const [graphifyError, setGraphifyError] = useState<string | null>(null);

  // Graphify filter knobs
  const [topNOnly, setTopNOnly] = useState<number | null>(50);
  const [minDegree, setMinDegree] = useState<number>(3);
  const [hideInferred, setHideInferred] = useState<boolean>(false);
  const [graphifySearch, setGraphifySearch] = useState<string>("");

  const handleGraphifyFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as GraphifyJSON;
        if (!Array.isArray(raw.nodes) || !Array.isArray(raw.links)) {
          throw new Error("JSON missing nodes/links — không phải graphify graph.json");
        }
        const { entities: ge, relations: gr, stats: gs } = graphifyToPaperclip(raw);
        setGraphifyEntities(ge);
        setGraphifyRelations(gr);
        setGraphifyStats(gs);
        setGraphifyLabel(file.name);
        setGraphifyError(null);
        // Auto-switch to graphify mode after successful upload — no hidden button
        setSourceMode("graphify");
      } catch (err: any) {
        setGraphifyError(err?.message ?? "Parse failed");
        setSourceMode("graphify"); // still switch so user sees the error
      }
    };
    reader.onerror = () => setGraphifyError("File read failed");
    reader.readAsText(file);
    // Reset input so selecting the same file twice re-triggers onChange
    e.target.value = "";
  }, []);

  // ──────────────────────────────────────────────────────
  // Pick the active dataset based on source mode
  // ──────────────────────────────────────────────────────
  const liveEntities = graphData?.entities || [];
  const liveRelations = graphData?.relations || [];

  const entities = sourceMode === "graphify" ? graphifyEntities : liveEntities;
  const relations = sourceMode === "graphify" ? graphifyRelations : liveRelations;

  // ──────────────────────────────────────────────────────
  // Filter pipeline
  //   live    → search-only (existing behavior)
  //   graphify → degree centrality + topN + search w/ 1-hop + hide inferred
  // ──────────────────────────────────────────────────────
  const { filteredEntities, filteredRelations, maxDegree } = useMemo(() => {
    if (sourceMode === "live") {
      const q = searchQuery.toLowerCase();
      const fe = !searchQuery
        ? entities
        : entities.filter(
            (e) =>
              e.name.toLowerCase().includes(q) ||
              e.external_id.toLowerCase().includes(q) ||
              (e.description && e.description.toLowerCase().includes(q)),
          );
      return { filteredEntities: fe, filteredRelations: relations, maxDegree: 0 };
    }

    // Graphify mode: degree centrality + filters
    if (entities.length === 0) {
      return { filteredEntities: [], filteredRelations: [], maxDegree: 0 };
    }

    const degMap = new Map<string, number>();
    for (const r of relations) {
      degMap.set(r.source_entity_id, (degMap.get(r.source_entity_id) ?? 0) + 1);
      degMap.set(r.target_entity_id, (degMap.get(r.target_entity_id) ?? 0) + 1);
    }
    let mx = 0;
    degMap.forEach((v) => { if (v > mx) mx = v; });

    let keptIds: Set<string>;
    if (topNOnly && topNOnly > 0) {
      const sorted = [...degMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, topNOnly);
      keptIds = new Set(sorted.map(([id]) => id));
    } else {
      keptIds = new Set<string>();
      for (const e of entities) {
        if ((degMap.get(e.id) ?? 0) >= minDegree) keptIds.add(e.id);
      }
    }

    // Search expansion (1-hop)
    const q = graphifySearch.trim().toLowerCase();
    if (q) {
      const seed = new Set(
        entities
          .filter((e) => keptIds.has(e.id) && e.name.toLowerCase().includes(q))
          .map((e) => e.id),
      );
      keptIds = new Set(seed);
      for (const r of relations) {
        if (seed.has(r.source_entity_id)) keptIds.add(r.target_entity_id);
        if (seed.has(r.target_entity_id)) keptIds.add(r.source_entity_id);
      }
    }

    const fe = entities.filter((e) => keptIds.has(e.id));
    const finalIds = new Set(fe.map((e) => e.id));
    const fr = relations.filter((r) => {
      if (!finalIds.has(r.source_entity_id) || !finalIds.has(r.target_entity_id)) return false;
      if (hideInferred && r.relation_type === "inferred_link") return false;
      return true;
    });

    return { filteredEntities: fe, filteredRelations: fr, maxDegree: mx };
  }, [sourceMode, entities, relations, searchQuery, topNOnly, minDegree, hideInferred, graphifySearch]);

  // Build adjacency for highlight computation
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const r of filteredRelations) {
      if (!adj.has(r.source_entity_id)) adj.set(r.source_entity_id, new Set());
      if (!adj.has(r.target_entity_id)) adj.set(r.target_entity_id, new Set());
      adj.get(r.source_entity_id)!.add(r.target_entity_id);
      adj.get(r.target_entity_id)!.add(r.source_entity_id);
    }
    return adj;
  }, [filteredRelations]);

  // ⑩ Compute depth-based highlights via BFS
  const computeHighlights = useCallback(
    (entityId: string) => {
      const highlights = new Map<string, number>();
      highlights.set(entityId, 0);

      const queue: [string, number][] = [[entityId, 0]];
      while (queue.length > 0) {
        const [current, depth] = queue.shift()!;
        if (depth >= maxDepth) continue;

        const neighbors = adjacency.get(current);
        if (!neighbors) continue;

        for (const n of neighbors) {
          if (!highlights.has(n)) {
            highlights.set(n, depth + 1);
            queue.push([n, depth + 1]);
          }
        }
      }

      return highlights;
    },
    [adjacency, maxDepth],
  );

  const handleEntityClick = useCallback(
    (entity: KGEntity) => {
      selectEntity(entity.id);
      const highlights = computeHighlights(entity.id);
      setHighlights(highlights);
    },
    [selectEntity, computeHighlights, setHighlights],
  );

  const handleEntityDoubleClick = useCallback(
    (entity: KGEntity) => {
      setDetailEntityId(entity.id);
    },
    [],
  );

  const handleTraverse = useCallback(
    (entityId: string) => {
      selectEntity(entityId);
      const highlights = computeHighlights(entityId);
      setHighlights(highlights);
    },
    [selectEntity, computeHighlights, setHighlights],
  );

  // Auto recompute highlights if maxDepth changes while an entity is selected
  useEffect(() => {
    if (selectedEntityId) {
      const highlights = computeHighlights(selectedEntityId);
      setHighlights(highlights);
    }
  }, [maxDepth, selectedEntityId, computeHighlights, setHighlights]);

  return (
    <div className="relative w-full h-full text-foreground font-sans">
      {/* Khu vực Biểu đồ không gian (Full nền) */}
      <div className="absolute inset-0 z-0">
        {sourceMode === "live" && graphLoading ? (
          <div className="flex items-center justify-center h-full">Đang tải đồ thị không gian...</div>
        ) : filteredEntities.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {sourceMode === "live"
              ? "Hãy Seed dữ liệu để khởi tạo Vũ Trụ AI"
              : "Upload graph.json từ một thư mục graphify-out/ để bắt đầu"}
          </div>
        ) : (
          <ForceGraph3D
            entities={filteredEntities}
            relations={filteredRelations}
            selectedEntityId={selectedEntityId ?? undefined}
            onEntityClick={handleEntityClick}
            onEntityDoubleClick={handleEntityDoubleClick}
            maxNodes={sourceMode === "graphify" ? 500 : 80}
            graphStyle={graphStyle}
          />
        )}
      </div>

      {/* OVERLAYS UI */}
      
      {/* TOP LEFT HEADER */}
      <div className="absolute top-4 left-4 z-10 pointer-events-none flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 bg-primary rounded-sm shadow-lg"></div>
          <h1 className="text-xl font-bold tracking-wide text-foreground">Vũ Trụ AI — KNOWLEDGE GRAPH</h1>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          Hệ thống Quản trị &gt; Mắt Thần CEO Toàn cảnh
        </p>
        <div className="flex flex-wrap gap-2 mt-1">
          {/* SOURCE MODE TOGGLE */}
          <button
            onClick={() => setSourceMode("live")}
            className={`px-2 py-1 rounded-full border text-xs font-medium backdrop-blur-md pointer-events-auto cursor-pointer transition-colors ${
              sourceMode === "live"
                ? "border-primary bg-primary/20 text-primary"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-accent"
            }`}
          >
            🌌 Live (Mắt Thần CEO)
          </button>
          <button
            onClick={() => setSourceMode("graphify")}
            className={`px-2 py-1 rounded-full border text-xs font-medium backdrop-blur-md pointer-events-auto cursor-pointer transition-colors ${
              sourceMode === "graphify"
                ? "border-chart-2 bg-chart-2/20 text-chart-2"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-accent"
            }`}
          >
            ⚡ Graphify (Code/Knowledge)
          </button>

          {sourceMode === "live" && (
            <span className="px-2 py-1 rounded-full border border-chart-2/40 bg-chart-2/10 text-xs text-chart-2 font-medium backdrop-blur-md pointer-events-auto cursor-pointer" title="Số lượng Agent đang liên kết trong vũ trụ">
              <span className="mr-1">🤖</span>{stats?.entities?.agent || 0} Agents
            </span>
          )}

          {/* Upload — ALWAYS visible. Auto-switches to Graphify mode on successful load. */}
          <label
            className="px-2 py-1 rounded-full border border-chart-2/40 bg-chart-2/10 text-xs text-chart-2 font-medium backdrop-blur-md pointer-events-auto cursor-pointer hover:bg-chart-2/20 transition-colors"
            title="Upload graph.json từ thư mục graphify-out/ của bất kỳ project nào"
          >
            📁 Upload graph.json
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleGraphifyFile}
              className="hidden"
            />
          </label>

          {sourceMode === "graphify" && graphifyEntities.length > 0 && (
            <button
              onClick={() => {
                setGraphifyEntities([]);
                setGraphifyRelations([]);
                setGraphifyStats(null);
                setGraphifyLabel("");
                setGraphifyError(null);
                setSourceMode("live");
              }}
              className="px-2 py-1 rounded-full border border-destructive/40 bg-destructive/10 text-xs text-destructive font-medium backdrop-blur-md pointer-events-auto cursor-pointer hover:bg-destructive/20 transition-colors"
              title="Xóa graph đã upload, quay về live mode"
            >
              ✕ Xóa upload
            </button>
          )}

          <button onClick={() => setShowSidebars(!showSidebars)} className="px-2 py-1 rounded-full border border-border bg-card text-xs text-foreground font-medium backdrop-blur-md hover:bg-accent transition-colors pointer-events-auto shadow-lg hover:shadow-xl">
            {showSidebars ? '🗖 Đóng Panel' : '🗗 Mở Panel'}
          </button>
        </div>

        {/* Graphify filter bar — only when graphify mode + data loaded */}
        {sourceMode === "graphify" && entities.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2 bg-[#0f172a]/70 backdrop-blur-xl border border-[#22d3ee]/20 rounded-xl px-3 py-2 pointer-events-auto">
            <span className="text-[10px] text-[#22d3ee] tracking-wider">VIEW:</span>
            <button
              onClick={() => { setTopNOnly(50); setMinDegree(0); }}
              className={`px-2 py-1 rounded text-[10px] font-mono border ${topNOnly === 50 ? "bg-[#22d3ee]/20 border-[#22d3ee] text-[#22d3ee]" : "border-border text-muted-foreground hover:bg-accent"}`}
            >🌟 Top 50</button>
            <button
              onClick={() => { setTopNOnly(150); setMinDegree(0); }}
              className={`px-2 py-1 rounded text-[10px] font-mono border ${topNOnly === 150 ? "bg-[#22d3ee]/20 border-[#22d3ee] text-[#22d3ee]" : "border-border text-muted-foreground hover:bg-accent"}`}
            >⚡ Top 150</button>
            <button
              onClick={() => { setTopNOnly(null); setMinDegree(3); }}
              className={`px-2 py-1 rounded text-[10px] font-mono border ${(!topNOnly && minDegree === 3) ? "bg-[#22d3ee]/20 border-[#22d3ee] text-[#22d3ee]" : "border-border text-muted-foreground hover:bg-accent"}`}
            >📊 Deg ≥3</button>
            <button
              onClick={() => { setTopNOnly(null); setMinDegree(0); }}
              className={`px-2 py-1 rounded text-[10px] font-mono border ${(!topNOnly && minDegree === 0) ? "bg-[#22d3ee]/20 border-[#22d3ee] text-[#22d3ee]" : "border-border text-muted-foreground hover:bg-accent"}`}
            >🌐 All ({entities.length})</button>

            <label className={"flex items-center gap-1 text-[10px] text-white/70 cursor-pointer ml-2" /* dark-surface-ok */}>
              <input
                type="checkbox"
                checked={hideInferred}
                onChange={(e) => setHideInferred(e.target.checked)}
              />
              Hide INFERRED
            </label>

            <input
              type="text"
              placeholder="🔍 Tìm node..."
              value={graphifySearch}
              onChange={(e) => setGraphifySearch(e.target.value)}
              className="px-2 py-1 bg-[#030712] border border-white/10 rounded text-[10px] text-[#22d3ee] font-mono outline-none focus:border-[#22d3ee]/60 min-w-[160px]"
            />

            <span className="text-[10px] text-[#10b981] ml-auto font-mono">
              <b>{filteredEntities.length}</b>/{entities.length} · <b>{filteredRelations.length}</b>/{relations.length} edges · max deg {maxDegree}
            </span>
          </div>
        )}

        {sourceMode === "graphify" && graphifyStats && (
          <div className="text-[10px] text-muted-foreground mt-1 flex flex-wrap gap-3 pointer-events-auto">
            <span>📊 {graphifyStats.total_entities} nodes · {graphifyStats.total_relations} edges · {graphifyStats.communities} communities</span>
            <span className="text-[#10b981]">EXTRACTED {graphifyStats.extracted_pct}%</span>
            <span className="text-[#f59e0b]">INFERRED {graphifyStats.inferred_pct}%</span>
            {graphifyLabel && <span className="text-[#22d3ee]">📁 {graphifyLabel}</span>}
          </div>
        )}

        {graphifyError && (
          <div className="text-[10px] text-red-700 dark:text-red-300 mt-1 pointer-events-auto">⚠ {graphifyError}</div>
        )}
      </div>

      {showSidebars && (
        <>
          {/* LEFT PANELS: Filters & Legend */}
          <div className="absolute top-28 left-4 bottom-4 w-52 z-10 flex flex-col gap-4 pointer-events-auto overflow-y-auto no-scrollbar">
            {/* Module: Filter Ngày */}
            <div className="bg-card backdrop-blur-xl border border-border rounded-md p-4 shadow-xl">
              <h3 className="text-[10px] font-bold text-muted-foreground tracking-wider uppercase mb-3 text-center">BỘ LỌC DỮ LIỆU</h3>
          <div className="flex flex-col gap-2">
            {[
              { id: "all", label: "Tất cả", color: "#8b5cf6" },
              { id: "agent", label: "Agent Tham gia", color: "#10b981" },
              { id: "task", label: "Theo Công việc", color: "#3b82f6" }
            ].map((item) => {
              const isActive = item.id === "all" ? activeFilters.size === 0 : activeFilters.has(item.id as EntityType);
              return (
                <button 
                  key={item.id} 
                  onClick={() => {
                    if (item.id === "all") {
                      clearFilters();
                    } else {
                      toggleFilter(item.id as EntityType);
                    }
                  }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${isActive ? "bg-[#8b5cf6]/20 border border-[#8b5cf6]/50 text-[#c4b5fd]" : "hover:bg-[#334155]/50 border border-transparent"}`}
                >
                  <div className={`w-2 h-2 rounded-full ${isActive ? "bg-["+item.color+"] shadow-[0_0_5px_"+item.color+"]" : "bg-[#475569]"}`} />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

            {/* Module: Legend */}
            <div className="bg-card backdrop-blur-xl border border-border rounded-md p-4 shadow-xl pointer-events-auto">
              <h3 className="text-[10px] font-bold text-muted-foreground tracking-wider uppercase mb-3 text-center">PHÂN LOẠI NODE</h3>
              <div className="flex flex-col gap-2 text-xs">
            {Object.entries(ENTITY_TYPES).map(([type, config]) => (
              <div key={type} className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full`} style={{ backgroundColor: config.color, boxShadow: `0 0 6px ${config.color}` }}></div>
                <span className="text-foreground">{config.label}</span>
              </div>
            ))}
          </div>
        </div>

            {/* Seed Options */}
            <div className="mt-auto">
                <GraphControls
                  stats={stats}
                  visibleCount={filteredEntities.length}
                  onRefresh={() => queryClient.invalidateQueries({ queryKey: ["kg"] })}
                  onSeed={() => seedMutation.mutate()}
                  seeding={seedMutation.isPending}
                />
            </div>
          </div>

          {/* RIGHT PANELS: Stats & Timeline */}
          <div className="absolute top-4 right-4 bottom-4 w-72 z-10 flex flex-col gap-4 pointer-events-auto overflow-y-auto no-scrollbar">
            {/* Detail Panel Modal (Centered, GlassMorphism) */}
            {detailEntityId && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 dark:bg-[#0B0C10]/60 backdrop-blur-sm p-4 pointer-events-auto">
                <div className="bg-white/90 dark:bg-[#0f172a]/90 backdrop-blur-2xl border border-slate-300 dark:border-[#38bdf8]/30 rounded-3xl overflow-hidden shadow-[0_0_50px_rgba(56,189,248,0.15)] w-full max-w-2xl max-h-[85vh] flex flex-col relative text-slate-800 dark:text-slate-100">
                  <button onClick={() => setDetailEntityId(null)} className="absolute top-5 right-5 text-slate-500 hover:text-foreground/50 dark:hover:text-white z-20 bg-slate-200/50 hover:bg-slate-300 dark:bg-white/5 dark:hover:bg-white/10 w-8 h-8 rounded-full flex items-center justify-center transition-colors">✕</button>
                  <EntityDetailPanel
                    entityId={detailEntityId}
                    onClose={() => setDetailEntityId(null)}
                    onEntityClick={(id) => {
                      setDetailEntityId(id);
                      selectEntity(id);
                      setHighlights(computeHighlights(id));
                    }}
                    onTraverse={handleTraverse}
                  />
                </div>
              </div>
            )}

            {/* Module: Thống Kê */}
            {!detailEntityId && (
              <>
                <div className="bg-card backdrop-blur-xl border border-border rounded-md p-4 shadow-xl">
                  <h3 className="text-[10px] font-bold text-muted-foreground tracking-wider uppercase mb-3 border-b border-slate-200 dark:border-white/10 pb-2 flex items-center gap-2">
                    📊 THỐNG KÊ TOÀN CẢNH
                  </h3>
                  <div className="flex flex-col gap-2 text-xs">
                    <div className="flex justify-between items-center"><span className="text-muted-foreground">Tổng số Node</span><span className="font-mono font-bold text-[#38bdf8]">{filteredEntities.length}</span></div>
                    <div className="flex justify-between items-center"><span className="text-muted-foreground">Kết nối lưới</span><span className="font-mono font-bold text-[#f472b6]">{relations.length}</span></div>
                    <div className="h-px bg-border my-1"></div>
                    <div className="flex justify-between items-center"><span className="text-muted-foreground">Tình trạng phân phối</span><span className="font-mono font-bold text-[#fbbf24]">85%</span></div>
                    <div className="flex justify-between items-center"><span className="text-muted-foreground">Năng suất hệ thống</span><span className="font-mono font-bold text-[#4ade80]">9.2/10 ⭐</span></div>
                  </div>
                </div>

                {/* Module: Timeline */}
                <div className="bg-card backdrop-blur-xl border border-border rounded-md p-4 flex-1 shadow-xl">
                  <h3 className="text-[10px] font-bold text-muted-foreground tracking-wider uppercase mb-3 border-b border-slate-200 dark:border-white/10 pb-2 flex items-center gap-2">
                    🗓 DÒNG THỜI GIAN NHIỆM VỤ
                  </h3>
              <div className="relative pl-3 mt-4 flex flex-col gap-4 border-l border-slate-200 dark:border-[#334155]">
                {[
                  { date: "Hôm nay", info: "Workflow Kiến trúc đồ thị - Hoàn thành Graphic Canvas", cssClass: "bg-[#a855f7] shadow-[0_0_5px_#a855f7]" },
                  { date: "Hôm qua", info: "Lưu trữ vector SQL pgvector", cssClass: "bg-[#10b981] shadow-[0_0_5px_#10b981]" },
                  { date: "2 ngày trước", info: "Trích xuất 7 loại Entity tự động", cssClass: "bg-[#3b82f6] shadow-[0_0_5px_#3b82f6]" },
                  { date: "3 ngày trước", info: "Thiết lập SOP quy trình chuẩn", cssClass: "bg-[#f59e0b] shadow-[0_0_5px_#f59e0b]" }
                ].map((ev, i) => (
                  <div key={i} className="relative">
                    <div className={`absolute -left-[17px] top-1 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-[#0B0C10] ${ev.cssClass}`}></div>
                    <div className="text-[10px] font-bold text-slate-500 dark:text-[#94a3b8]">{ev.date}</div>
                    <div className="text-xs text-foreground mt-0.5 leading-relaxed">{ev.info}</div>
                  </div>
                ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Style Control Panel — floating bottom right */}
      <GraphStylePanel
        style={graphStyle}
        activePreset={activePreset}
        onStyleChange={setGraphStyle}
        onPresetChange={(key) => {
          setActivePreset(key);
          setGraphStyle(GRAPH_PRESETS[key]);
        }}
      />
    </div>
  );
}

