import { useEffect, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Eye,
  Heart,
  MessageCircle,
  Share2,
  Users,
  Play,
  Clock,
  ThumbsUp,
  Globe,
  MonitorPlay,
  TrendingUp,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
} from "lucide-react";
import { socialAnalyticsApi } from "@/api/social-analytics";
import type { FBPost, FBOverview, YTVideo, YTOverview } from "@/api/social-analytics";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Period = "7d" | "30d" | "90d";
type Tab = "facebook" | "youtube";

const PERIOD_LABELS: Record<Period, string> = {
  "7d": "7 ngày",
  "30d": "30 ngày",
  "90d": "90 ngày",
};

// ─── Stat Card (R-1: clickable with href) ────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  subtitle,
  href,
}: {
  label: string;
  value: string | number;
  icon: typeof BarChart3;
  subtitle?: string;
  href?: string;
}) {
  const Wrapper = href ? "a" : "div";
  const wrapperProps = href
    ? { href, target: "_blank", rel: "noopener noreferrer" }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      className={cn(
        "border border-border rounded-lg p-4 bg-card block",
        href && "hover:border-foreground/20 hover:shadow-sm transition-all cursor-pointer group",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
            {label}
          </p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">
            {typeof value === "number" ? value.toLocaleString("vi-VN") : value}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/50">
          {href ? (
            <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          ) : (
            <Icon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </div>
    </Wrapper>
  );
}

// ─── Copy Button ─────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="p-1 rounded hover:bg-muted transition-colors"
      title="Sao chép link"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </button>
  );
}

// ─── Period Selector ──────────────────────────────────────────────

function PeriodSelector({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 bg-muted/30">
      {(["7d", "30d", "90d"] as Period[]).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
            value === p
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

// ─── Page Selector ────────────────────────────────────────────────

function PageSelector({
  value,
  onChange,
  pages,
}: {
  value: string;
  onChange: (id: string) => void;
  pages: { id: string; name: string }[];
}) {
  if (pages.length <= 1) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground"
    >
      {pages.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

// ─── Not Configured ───────────────────────────────────────────────

function NotConfigured({ platform }: { platform: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="rounded-full bg-muted/50 p-4 mb-4">
        <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {platform} chưa được cấu hình
      </p>
      <p className="text-xs text-muted-foreground max-w-md">
        Thêm API key vào biến môi trường của server để bắt đầu theo dõi {platform}.
      </p>
    </div>
  );
}

// ─── Error Banner ─────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/20 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
        <p className="text-sm text-red-800 dark:text-red-300">{message}</p>
      </div>
    </div>
  );
}

// ─── Stats Skeleton ───────────────────────────────────────────────

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-lg" />
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-10 w-full rounded-none" />
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-none" />
      ))}
    </div>
  );
}

// ─── AI Insights Panel ───────────────────────────────────────────

function FacebookInsights({
  overview,
  posts,
  period,
}: {
  overview: FBOverview | undefined;
  posts: FBPost[];
  period: Period;
}) {
  if (!overview || posts.length === 0) return null;

  const totalEngagement = posts.reduce((s, p) => s + p.likes + p.comments + p.shares, 0);
  const avgEngagement = posts.length > 0 ? totalEngagement / posts.length : 0;
  const topPost = [...posts].sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares))[0];
  const lowPost = [...posts].sort((a, b) => (a.likes + a.comments + a.shares) - (b.likes + b.comments + b.shares))[0];
  const engagementRate = overview.impressions > 0
    ? ((overview.engagement / overview.impressions) * 100)
    : 0;
  const topTotal = topPost ? topPost.likes + topPost.comments + topPost.shares : 0;
  const lowTotal = lowPost ? lowPost.likes + lowPost.comments + lowPost.shares : 0;
  const gap = topTotal - lowTotal;

  const insights: string[] = [];

  // Engagement rate analysis
  if (engagementRate > 3) {
    insights.push(`Tỉ lệ tương tác ${engagementRate.toFixed(2)}% — cao hơn trung bình ngành (1-3%). Nội dung đang resonating tốt với audience.`);
  } else if (engagementRate > 1) {
    insights.push(`Tỉ lệ tương tác ${engagementRate.toFixed(2)}% — nằm trong mức trung bình ngành. Cần thử nghiệm thêm format mới để tăng engagement.`);
  } else {
    insights.push(`Tỉ lệ tương tác ${engagementRate.toFixed(2)}% — dưới trung bình ngành (1%). Cần đánh giá lại content strategy, thời gian đăng, và targeting.`);
  }

  // Top vs bottom post gap
  if (gap > avgEngagement * 2) {
    insights.push(`Bài đăng tốt nhất (${topTotal.toLocaleString("vi-VN")} tương tác) gấp ${lowTotal > 0 ? (topTotal / lowTotal).toFixed(1) : "∞"}x bài thấp nhất. Phân tích bài top để nhân rộng format thành công.`);
  }

  // Reach vs followers
  if (overview.reach > overview.followers * 0.5) {
    insights.push(`Reach đạt ${((overview.reach / overview.followers) * 100).toFixed(0)}% so với followers — viral reach tốt, nội dung đang được share rộng.`);
  } else if (overview.reach < overview.followers * 0.1) {
    insights.push(`Reach chỉ ${((overview.reach / overview.followers) * 100).toFixed(1)}% followers — thuật toán đang hạn chế phân phối. Thử video/reels hoặc tăng tần suất đăng.`);
  }

  // Comments vs likes ratio
  const totalComments = posts.reduce((s, p) => s + p.comments, 0);
  const totalLikes = posts.reduce((s, p) => s + p.likes, 0);
  if (totalLikes > 0 && totalComments / totalLikes > 0.1) {
    insights.push(`Tỉ lệ comment/like cao (${((totalComments / totalLikes) * 100).toFixed(0)}%) — audience đang tham gia thảo luận tích cực, đây là tín hiệu tốt cho thuật toán.`);
  }

  if (insights.length === 0) return null;

  return (
    <div className="border border-border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-violet-500/10 flex items-center justify-center">
          <TrendingUp className="h-3.5 w-3.5 text-violet-500" />
        </div>
        <h3 className="text-sm font-semibold">Phân tích AI — {PERIOD_LABELS[period]}</h3>
      </div>
      <ul className="space-y-2">
        {insights.map((text, i) => (
          <li key={i} className="flex gap-2 text-xs text-foreground/80 leading-relaxed">
            <span className="text-violet-500 shrink-0 mt-0.5">•</span>
            {text}
          </li>
        ))}
      </ul>
      {topPost && (
        <div className="pt-2 border-t border-border/50">
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Bài đăng tốt nhất:</span>{" "}
            {topPost.message ? topPost.message.slice(0, 80) + (topPost.message.length > 80 ? "..." : "") : "(Không có nội dung)"}
            {" "}— {topTotal.toLocaleString("vi-VN")} tương tác
          </p>
        </div>
      )}
    </div>
  );
}

function YouTubeInsights({
  overview,
  videos,
  period,
}: {
  overview: YTOverview | undefined;
  videos: YTVideo[];
  period: Period;
}) {
  if (!overview || videos.length === 0) return null;

  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const avgViews = videos.length > 0 ? totalViews / videos.length : 0;
  const topVideo = [...videos].sort((a, b) => b.views - a.views)[0];
  const totalLikes = videos.reduce((s, v) => s + v.likes, 0);
  const likeRatio = totalViews > 0 ? (totalLikes / totalViews) * 100 : 0;
  const avgDuration = videos.reduce((s, v) => s + v.duration_seconds, 0) / videos.length;

  const insights: string[] = [];

  // Views per video
  if (avgViews > 1000) {
    insights.push(`Trung bình ${avgViews.toLocaleString("vi-VN")} views/video — performance tốt. Duy trì tần suất upload hiện tại.`);
  } else if (avgViews > 100) {
    insights.push(`Trung bình ${avgViews.toLocaleString("vi-VN")} views/video — mức ổn, cần tối ưu thumbnail và title để tăng CTR.`);
  } else {
    insights.push(`Trung bình ${avgViews.toLocaleString("vi-VN")} views/video — cần cải thiện SEO (title, tags, description) và đăng thêm Shorts để tăng discoverability.`);
  }

  // Like ratio
  if (likeRatio > 5) {
    insights.push(`Like rate ${likeRatio.toFixed(1)}% — rất cao, audience đánh giá nội dung chất lượng.`);
  } else if (likeRatio > 2) {
    insights.push(`Like rate ${likeRatio.toFixed(1)}% — mức tốt, nội dung đang đúng hướng.`);
  }

  // Watch time insight
  if (overview.estimated_watch_minutes > 0) {
    const avgWatchPerSub = overview.subscribers > 0 ? overview.estimated_watch_minutes / overview.subscribers : 0;
    if (avgWatchPerSub > 1) {
      insights.push(`Thời gian xem TB ${avgWatchPerSub.toFixed(1)} phút/subscriber — retention tốt, subscriber đang xem nội dung thường xuyên.`);
    }
  }

  // Duration analysis
  if (avgDuration > 600) {
    insights.push(`Video TB dài ${formatSeconds(Math.round(avgDuration))} — dạng long-form. Nếu retention thấp, thử cắt thành Shorts < 60s để tận dụng thuật toán.`);
  }

  if (insights.length === 0) return null;

  return (
    <div className="border border-border rounded-lg p-4 bg-card space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-red-500/10 flex items-center justify-center">
          <BarChart3 className="h-3.5 w-3.5 text-red-500" />
        </div>
        <h3 className="text-sm font-semibold">Phân tích AI — {PERIOD_LABELS[period]}</h3>
      </div>
      <ul className="space-y-2">
        {insights.map((text, i) => (
          <li key={i} className="flex gap-2 text-xs text-foreground/80 leading-relaxed">
            <span className="text-red-500 shrink-0 mt-0.5">•</span>
            {text}
          </li>
        ))}
      </ul>
      {topVideo && (
        <div className="pt-2 border-t border-border/50">
          <p className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Video tốt nhất:</span>{" "}
            {topVideo.title.slice(0, 60)}{topVideo.title.length > 60 ? "..." : ""}
            {" "}— {topVideo.views.toLocaleString("vi-VN")} views
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Facebook Post URL helper ────────────────────────────────────

function fbPostUrl(postId: string, pageId: string): string {
  // FB post IDs are pageId_postId or just postId
  if (postId.includes("_")) return `https://facebook.com/${postId}`;
  return `https://facebook.com/${pageId}/posts/${postId}`;
}

// ─── Facebook Tab ─────────────────────────────────────────────────

function FacebookTab() {
  const [period, setPeriod] = useState<Period>("7d");
  const [pageId, setPageId] = useState<string>("");

  const pagesQuery = useQuery({
    queryKey: ["social-analytics", "facebook", "pages"],
    queryFn: () => socialAnalyticsApi.facebookPages(),
  });

  const pages = pagesQuery.data?.pages ?? [];
  const activePageId = pageId || pages[0]?.id || "";

  const overviewQuery = useQuery({
    queryKey: ["social-analytics", "facebook", "overview", activePageId, period],
    queryFn: () => socialAnalyticsApi.facebookOverview(activePageId, period),
    enabled: !!activePageId,
  });

  const postsQuery = useQuery({
    queryKey: ["social-analytics", "facebook", "posts", activePageId],
    queryFn: () => socialAnalyticsApi.facebookPosts(activePageId, 20),
    enabled: !!activePageId,
  });

  if (pagesQuery.isLoading) return <StatsSkeleton />;
  if (pages.length === 0) return <NotConfigured platform="Facebook" />;

  const overview = overviewQuery.data;
  const posts = postsQuery.data?.posts ?? [];
  const engagementRate =
    overview && overview.impressions > 0
      ? ((overview.engagement / overview.impressions) * 100).toFixed(2)
      : "0";

  const pageUrl = `https://facebook.com/${activePageId}`;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <PageSelector
          value={activePageId}
          onChange={setPageId}
          pages={pages}
        />
        <PeriodSelector value={period} onChange={setPeriod} />
        {/* R-1: Open page on Facebook */}
        <a
          href={pageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Mở Facebook Page
        </a>
      </div>

      {overviewQuery.error && (
        <ErrorBanner
          message={
            overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "Lỗi tải dữ liệu Facebook"
          }
        />
      )}

      {/* Stat Cards — R-1: clickable to page insights */}
      {overviewQuery.isLoading ? (
        <StatsSkeleton />
      ) : overview ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Người theo dõi"
            value={overview.followers}
            icon={Users}
            href={`${pageUrl}/followers`}
          />
          <StatCard
            label={`Tiếp cận (${PERIOD_LABELS[period]})`}
            value={overview.reach}
            icon={Eye}
            href={`${pageUrl}/insights`}
          />
          <StatCard
            label={`Lượt hiển thị (${PERIOD_LABELS[period]})`}
            value={overview.impressions}
            icon={TrendingUp}
            href={`${pageUrl}/insights`}
          />
          <StatCard
            label="Tỉ lệ tương tác"
            value={`${engagementRate}%`}
            icon={Heart}
            href={`${pageUrl}/insights`}
          />
        </div>
      ) : null}

      {/* Posts Table — R-1: action column per row */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Bài đăng gần đây</h3>
        {postsQuery.isLoading ? (
          <TableSkeleton />
        ) : posts.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Chưa có bài đăng nào.
          </p>
        ) : (
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Ngày
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Hình
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground min-w-[200px]">
                    Nội dung
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Tiếp cận
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Hiển thị
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <Heart className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <MessageCircle className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <Share2 className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {posts
                  .sort(
                    (a: FBPost, b: FBPost) =>
                      b.likes + b.comments + b.shares -
                      (a.likes + a.comments + a.shares),
                  )
                  .map((post: FBPost, idx: number) => {
                    const url = fbPostUrl(post.id, activePageId);
                    return (
                      <tr
                        key={post.id}
                        onClick={() => window.open(url, "_blank")}
                        className={cn(
                          "border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors cursor-pointer",
                          idx % 2 === 1 && "bg-muted/15",
                        )}
                      >
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(post.created_time)}
                        </td>
                        <td className="px-4 py-2">
                          {post.image ? (
                            <img
                              src={post.image}
                              alt=""
                              className="h-10 w-10 rounded object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded bg-muted/50 flex items-center justify-center">
                              <Globe className="h-4 w-4 text-muted-foreground/30" />
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs max-w-[300px]">
                          <span className="line-clamp-2">
                            {post.message || "(Không có nội dung)"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {post.reach.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {post.impressions.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {post.likes.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {post.comments.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {post.shares.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-0.5 justify-end">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 rounded hover:bg-muted transition-colors"
                              title="Xem trên Facebook"
                            >
                              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                            </a>
                            <CopyBtn text={url} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI Insights */}
      <FacebookInsights overview={overview} posts={posts} period={period} />
    </div>
  );
}

// ─── YouTube Tab ──────────────────────────────────────────────────

function YouTubeTab() {
  const [period, setPeriod] = useState<Period>("7d");

  const overviewQuery = useQuery({
    queryKey: ["social-analytics", "youtube", "overview", period],
    queryFn: () => socialAnalyticsApi.youtubeOverview(period),
    retry: false,
  });

  const videosQuery = useQuery({
    queryKey: ["social-analytics", "youtube", "videos"],
    queryFn: () => socialAnalyticsApi.youtubeVideos(20),
    retry: false,
  });

  // Check for "not configured" error
  const isNotConfigured =
    overviewQuery.error &&
    overviewQuery.error instanceof Error &&
    overviewQuery.error.message.includes("cấu hình");

  if (isNotConfigured) return <NotConfigured platform="YouTube" />;

  const overview = overviewQuery.data;
  const videos = videosQuery.data?.videos ?? [];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <PeriodSelector value={period} onChange={setPeriod} />
        {/* R-1: Open YouTube channel */}
        {overview?.channel_id && (
          <a
            href={`https://youtube.com/channel/${overview.channel_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Mở YouTube Channel
          </a>
        )}
      </div>

      {overviewQuery.error && !isNotConfigured && (
        <ErrorBanner
          message={
            overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "Lỗi tải dữ liệu YouTube"
          }
        />
      )}

      {/* Stat Cards */}
      {overviewQuery.isLoading ? (
        <StatsSkeleton />
      ) : overview ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Người đăng ký"
            value={overview.subscribers}
            icon={Users}
          />
          <StatCard
            label={`Lượt xem (${PERIOD_LABELS[period]})`}
            value={overview.period_views}
            icon={Play}
            subtitle={`Tổng: ${overview.total_views.toLocaleString("vi-VN")}`}
          />
          <StatCard
            label="Thời gian xem (phút)"
            value={overview.estimated_watch_minutes}
            icon={Clock}
          />
          <StatCard
            label="Thời lượng TB"
            value={formatSeconds(overview.avg_duration_seconds)}
            icon={BarChart3}
          />
        </div>
      ) : null}

      {/* Videos Table — R-1: action column per row */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Video gần đây</h3>
        {videosQuery.isLoading ? (
          <TableSkeleton />
        ) : videos.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Chưa có video nào.
          </p>
        ) : (
          <div className="overflow-x-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Ngày
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Thumbnail
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground min-w-[200px]">
                    Tiêu đề
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <Play className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <ThumbsUp className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <MessageCircle className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 inline" />
                  </th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground w-[72px]" />
                </tr>
              </thead>
              <tbody>
                {videos
                  .sort(
                    (a: YTVideo, b: YTVideo) => b.views - a.views,
                  )
                  .map((video: YTVideo, idx: number) => {
                    const url = `https://youtube.com/watch?v=${video.id}`;
                    return (
                      <tr
                        key={video.id}
                        onClick={() => window.open(url, "_blank")}
                        className={cn(
                          "border-b border-border last:border-b-0 hover:bg-accent/30 transition-colors cursor-pointer",
                          idx % 2 === 1 && "bg-muted/15",
                        )}
                      >
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(video.published_at)}
                        </td>
                        <td className="px-4 py-2">
                          {video.thumbnail ? (
                            <img
                              src={video.thumbnail}
                              alt=""
                              className="h-12 w-[86px] rounded object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="h-12 w-[86px] rounded bg-muted flex items-center justify-center">
                              <Play className="h-4 w-4 text-muted-foreground/30" />
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs max-w-[300px]">
                          <span className="line-clamp-2 hover:underline">
                            {video.title}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {video.views.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {video.likes.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums">
                          {video.comments.toLocaleString("vi-VN")}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-right tabular-nums text-muted-foreground">
                          {video.duration_formatted}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-0.5 justify-end">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1 rounded hover:bg-muted transition-colors"
                              title="Xem trên YouTube"
                            >
                              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                            </a>
                            <CopyBtn text={url} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* AI Insights */}
      <YouTubeInsights overview={overview} videos={videos} period={period} />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────

export function SocialAnalyticsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("facebook");

  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Phân Tích Mạng Xã Hội" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">
          Phân Tích Mạng Xã Hội
        </h1>
        <p className="text-sm text-muted-foreground">
          Theo dõi hiệu suất Facebook Pages và YouTube Channel.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setActiveTab("facebook")}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "facebook"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
          )}
        >
          <Globe className="h-4 w-4" />
          Facebook
        </button>
        <button
          onClick={() => setActiveTab("youtube")}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
            activeTab === "youtube"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
          )}
        >
          <MonitorPlay className="h-4 w-4" />
          YouTube
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "facebook" ? <FacebookTab /> : <YouTubeTab />}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatSeconds(totalSeconds: number): string {
  if (!totalSeconds) return "0:00";
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
