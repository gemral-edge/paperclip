import { useEffect, useRef, lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";

// Content Center — lazy load
const CCLayout = lazy(() => import("./pages/content-center/CCLayout"));
const CCDashboard = lazy(() => import("./pages/content-center/CCDashboard"));
const CCAIGen = lazy(() => import("./pages/content-center/CCAIGen"));
const CCScripts = lazy(() => import("./pages/content-center/CCScripts"));
const CCScriptDetail = lazy(() => import("./pages/content-center/CCScriptDetail"));
const CCCalendar = lazy(() => import("./pages/content-center/CCCalendar"));
const CCRepurpose = lazy(() => import("./pages/content-center/CCRepurpose"));
const CCAnalytics = lazy(() => import("./pages/content-center/CCAnalytics"));
const CCImageGen = lazy(() => import("./pages/content-center/CCImageGen"));
const CCVideoReels = lazy(() => import("./pages/content-center/CCVideoReels"));
const CCBrand = lazy(() => import("./pages/content-center/CCBrand"));
const CCFunnels = lazy(() => import("./pages/content-center/CCFunnels"));
const CCOptim = lazy(() => import("./pages/content-center/CCOptim"));
const CCSettings = lazy(() => import("./pages/content-center/CCSettings"));
const CCEmailCampaigns = lazy(() => import("./pages/content-center/CCEmailCampaigns"));
const CCEmailCampaignDetail = lazy(() => import("./pages/content-center/CCEmailCampaignDetail"));
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { Dashboard } from "./pages/Dashboard";
import { Timetable } from "./pages/Timetable";
import { ContentPipelinePage } from "./pages/ops/ContentPipelinePage";
import { AffiliatePage } from "./pages/ops/AffiliatePage";
import { ScannerPage } from "./pages/ops/ScannerPage";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Issues } from "./pages/Issues";
import { IssueDetail } from "./pages/IssueDetail";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { Routines } from "./pages/Routines";
import { RoutineDetail } from "./pages/RoutineDetail";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { Costs } from "./pages/Costs";
import { Activity } from "./pages/Activity";
import { DelegationLogPage } from "./pages/delegations/DelegationLogPage";
import { DelegationCard } from "./pages/delegations/DelegationCard";
import { Inbox } from "./pages/Inbox";
import { CompanySettings } from "./pages/CompanySettings";
import { DesignGuide } from "./pages/DesignGuide";
import { ZaloPersonalPage } from "./pages/channels/ZaloPersonalPage";
import { ZaloPersonalChat } from "./pages/channels/ZaloPersonalChat";
import { FacebookWebPage } from "./pages/channels/FacebookWebPage";
import { ChannelsOverview } from "./pages/channels/ChannelsOverview";
import { ConversationsPage } from "./pages/channels/ConversationsPage";
import { ConversationChat } from "./pages/channels/ConversationChat";
import { ChannelSettingsPage } from "./pages/channels/ChannelSettingsPage";

import { AgentListPage } from "./pages/agents/AgentListPage";
import { AgentEditPage } from "./pages/agents/AgentEditPage";
import { AgentTestPage } from "./pages/agents/AgentTestPage";
import { AgentSessionsPage } from "./pages/agents/AgentSessionsPage";
import { QAEvaluationPage } from "./pages/channels/QAEvaluationPage";
import { WorkflowListPage } from "./pages/workflows/WorkflowListPage";
import { WorkflowBuilderPage } from "./pages/workflows/WorkflowBuilderPage";
import { UnifiedInbox } from "./pages/channels/UnifiedInbox";
import { InstanceSettings } from "./pages/InstanceSettings";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { PluginPage } from "./pages/PluginPage";
import { RunTranscriptUxLab } from "./pages/RunTranscriptUxLab";
import { WarRoom } from "./pages/WarRoom";
import { CRMOverview } from "./pages/crm/CRMOverview";
import { CustomerListPage } from "./pages/crm/CustomerListPage";
import { CustomerDetailPage } from "./pages/crm/CustomerDetailPage";
import { TicketListPage } from "./pages/crm/TicketListPage";
// TicketBoardPage merged into TicketListPage as view toggle
import { OrderListPage } from "./pages/crm/OrderListPage";
import { ImportPage } from "./pages/crm/ImportPage";
import { EmailCampaignsPage } from "./pages/crm/EmailCampaignsPage";
import { KnowledgeBasePage } from "./pages/crm/KnowledgeBasePage";
import { CrmMessagingShowcase } from "./pages/CrmMessagingShowcase";
import { CrmInbox } from "./pages/CrmInbox";
import { TrainingRoomPage } from "./pages/training/TrainingRoomPage";
import { ToolAuditLogPage } from "./pages/training/ToolAuditLogPage";
import { TrainingHistoryPage } from "./pages/training/TrainingHistoryPage";
import { CommandConsolePage } from "./pages/ops/CommandConsolePage";
import { SopEnginePage } from "./pages/ops/SopEnginePage";
import { SocialAnalyticsPage } from "./pages/analytics/SocialAnalyticsPage";

// Knowledge Graph — lazy load (heavy Three.js dependency)
const KnowledgeGraphPage = lazy(() => import("./pages/ops/KnowledgeGraphPage"));

import { ConfigHubPage } from "./pages/config/ConfigHubPage";
import { AgentsConfigRedirect, ConfigHubRedirect } from "./pages/config/ConfigRedirect";
import { OrgChart } from "./pages/OrgChart";
import { NewAgent } from "./pages/NewAgent";
import { AuthPage } from "./pages/Auth";
import { BoardClaimPage } from "./pages/BoardClaim";
import { InviteLandingPage } from "./pages/InviteLanding";
import { NotFoundPage } from "./pages/NotFound";
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { loadLastInboxTab } from "./lib/inbox";
import { DevToolsOverlay } from "./components/devtools/DevToolsOverlay";

function BootstrapPendingPage({ hasActiveInvite = false }: { hasActiveInvite?: boolean }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Instance setup required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {hasActiveInvite
            ? "No instance admin exists yet. A bootstrap invite is already active. Check your Paperclip startup logs for the first admin invite URL, or run this command to rotate it:"
            : "No instance admin exists yet. Run this command in your Paperclip environment to generate the first admin invite URL:"}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
{`pnpm paperclipai auth bootstrap-ceo`}
        </pre>
      </div>
    </div>
  );
}

function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as
        | { deploymentMode?: "local_trusted" | "authenticated"; bootstrapStatus?: "ready" | "bootstrap_pending" }
        | undefined;
      return data?.deploymentMode === "authenticated" && data.bootstrapStatus === "bootstrap_pending"
        ? 2000
        : false;
    },
    refetchIntervalInBackground: true,
  });

  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app state"}
      </div>
    );
  }

  if (isAuthenticatedMode && healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
    return <BootstrapPendingPage hasActiveInvite={healthQuery.data.bootstrapInviteActive} />;
  }

  if (isAuthenticatedMode && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return <Outlet />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="timetable" element={<Timetable />} />
      <Route path="lich-hom-nay" element={<Navigate to="/timetable" replace />} />
      <Route path="ops" element={<Navigate to="/dashboard" replace />} />
      <Route path="ops/content-pipeline" element={<ContentPipelinePage />} />
      <Route path="ops/affiliate" element={<AffiliatePage />} />
      <Route path="ops/scanner" element={<ScannerPage />} />
      <Route path="ops/console" element={<CommandConsolePage />} />
      <Route path="ops/sop-engine" element={<SopEnginePage />} />
      <Route path="ops/knowledge-graph" element={
        <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">Đang tải...</div>}>
          <KnowledgeGraphPage />
        </Suspense>
      } />
      <Route path="ops/roster" element={<Navigate to="/config" replace />} />
      {/* Phase 3.7: /config deprecated — merged into Registry Marketplace.
          Show banner + auto-redirect. Original ConfigHubPage kept importable
          for emergency direct access via ?legacy=1 query (not wired in UI). */}
      <Route path="config" element={<ConfigHubRedirect />} />
      <Route path="config/legacy" element={<ConfigHubPage />} />
      <Route path="workflows" element={<WorkflowListPage />} />
      <Route path="workflows/new" element={<WorkflowBuilderPage />} />
      <Route path="workflows/:id" element={<WorkflowBuilderPage />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="agents" element={<Navigate to="/agents/active" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="activity" element={<Activity />} />
      <Route path="delegations" element={<DelegationLogPage />} />
      <Route path="delegations/:traceId" element={<DelegationCard />} />
      <Route path="inbox" element={<InboxRootRedirect />} />
      <Route path="inbox/recent" element={<Inbox />} />
      <Route path="inbox/unread" element={<Inbox />} />
      <Route path="inbox/all" element={<Inbox />} />
      <Route path="inbox/mine" element={<Navigate to="/inbox/recent" replace />} />
      <Route path="inbox/new" element={<Navigate to="/inbox/recent" replace />} />
      <Route path="war-room" element={<WarRoom />} />
      <Route path="crm" element={<CRMOverview />} />
      <Route path="crm/customers" element={<CustomerListPage />} />
      <Route path="crm/customers/:id" element={<CustomerDetailPage />} />
      <Route path="crm/tickets" element={<TicketListPage />} />
      {/* Kanban view merged into TicketListPage via toggle */}
      <Route path="crm/tickets/:id" element={<TicketListPage />} />
      <Route path="crm/orders" element={<OrderListPage />} />
      <Route path="crm/orders/:id" element={<OrderListPage />} />
      <Route path="crm/import" element={<ImportPage />} />
      <Route path="crm/campaigns" element={<EmailCampaignsPage />} />
      <Route path="crm/knowledge-base" element={<KnowledgeBasePage />} />
      <Route path="crm-messaging" element={<CrmMessagingShowcase />} />
      <Route path="crm-inbox" element={<CrmInbox />} />
      <Route path="training" element={<TrainingRoomPage />} />
      <Route path="training/history" element={<TrainingHistoryPage />} />
      <Route path="training/audit-log" element={<ToolAuditLogPage />} />
      {/* Catch-all for any other /training/* path (e.g. /training/dashboard
          from auto-redirect logic). Renders TrainingRoomPage as the default. */}
      <Route path="training/*" element={<TrainingRoomPage />} />
      <Route path="analytics" element={<SocialAnalyticsPage />} />
      <Route path="channels/inbox" element={<UnifiedInbox />} />
      <Route path="channels" element={<ChannelsOverview />} />
      <Route path="channels/zalo-personal" element={<ZaloPersonalPage />} />
      <Route path="channels/zalo-personal/:channelName" element={<Navigate to="../channels/inbox" replace />} />
      <Route path="channels/zalo-personal/:channelName/:threadId" element={<Navigate to="../../channels/inbox" replace />} />
      <Route path="channels/facebook-web" element={<FacebookWebPage />} />
      <Route path="channels/conversations" element={<ConversationsPage />} />
      <Route path="channels/conversations/:sessionKey" element={<ConversationChat />} />
      <Route path="channels/settings" element={<ChannelSettingsPage />} />
      <Route path="channels/settings/:channelName" element={<ChannelSettingsPage />} />
      {/* Phase 3.7: agents-config deprecated — merged into Registry Marketplace.
          Top-level list page shows banner + redirect. Sub-routes for editing
          individual agents (edit/test/sessions) are KEPT functional for
          deep links — they're still the canonical detail pages. */}
      <Route path="agents-config" element={<AgentsConfigRedirect />} />
      <Route path="agents-config/legacy" element={<AgentListPage />} />
      <Route path="agents-config/new" element={<AgentEditPage />} />
      <Route path="agents-config/:slug/edit" element={<AgentEditPage />} />
      <Route path="agents-config/:slug/test" element={<AgentTestPage />} />
      <Route path="agents-config/sessions" element={<AgentSessionsPage />} />
      <Route path="channels/qa" element={<QAEvaluationPage />} />
      {/* ═══ TRUNG TÂM NỘI DUNG (Content Center) ═══ */}
      <Route
        path="cc"
        element={
          <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">Đang tải Trung tâm Nội dung...</div>}>
            <CCLayout />
          </Suspense>
        }
      >
        <Route index element={<Suspense fallback={null}><CCDashboard /></Suspense>} />
        <Route path="ai-gen" element={<Suspense fallback={null}><CCAIGen /></Suspense>} />
        <Route path="scripts" element={<Suspense fallback={null}><CCScripts /></Suspense>} />
        <Route path="scripts/:id" element={<Suspense fallback={null}><CCScriptDetail /></Suspense>} />
        <Route path="calendar" element={<Suspense fallback={null}><CCCalendar /></Suspense>} />
        <Route path="repurpose" element={<Suspense fallback={null}><CCRepurpose /></Suspense>} />
        <Route path="analytics" element={<Suspense fallback={null}><CCAnalytics /></Suspense>} />
        <Route path="image-gen" element={<Suspense fallback={null}><CCImageGen /></Suspense>} />
        <Route path="video-reels" element={<Suspense fallback={null}><CCVideoReels /></Suspense>} />
        <Route path="brand" element={<Suspense fallback={null}><CCBrand /></Suspense>} />
        <Route path="funnels" element={<Suspense fallback={null}><CCFunnels /></Suspense>} />
        <Route path="optim" element={<Suspense fallback={null}><CCOptim /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={null}><CCSettings /></Suspense>} />
        <Route path="email" element={<Suspense fallback={null}><CCEmailCampaigns /></Suspense>} />
        <Route path="email/:id" element={<Suspense fallback={null}><CCEmailCampaignDetail /></Suspense>} />
      </Route>
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="tests/ux/runs" element={<RunTranscriptUxLab />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

function InboxRootRedirect() {
  return <Navigate to={`/inbox/${loadLastInboxTab()}`} replace />;
}

function LegacySettingsRedirect() {
  const location = useLocation();
  return <Navigate to={`/instance/settings/heartbeats${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { companies, loading } = useCompany();
  const { onboardingOpen, openOnboarding } = useDialog();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const opened = useRef(false);
  const matchedCompany = companyPrefix
    ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
    : null;

  useEffect(() => {
    if (loading || opened.current || onboardingOpen) return;
    opened.current = true;
    if (matchedCompany) {
      openOnboarding({ initialStep: 2, companyId: matchedCompany.id });
      return;
    }
    openOnboarding();
  }, [companyPrefix, loading, matchedCompany, onboardingOpen, openOnboarding]);

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : companies.length > 0
      ? "Create another company"
      : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : companies.length > 0
      ? "Run onboarding again to create another company and seed its first agent."
      : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const { onboardingOpen } = useDialog();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  // Keep the first-run onboarding mounted until it completes.
  if (onboardingOpen) {
    return <NoCompaniesStartPage autoOpen={false} />;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage({ autoOpen = true }: { autoOpen?: boolean }) {
  const { openOnboarding } = useDialog();
  const opened = useRef(false);

  useEffect(() => {
    if (!autoOpen) return;
    if (opened.current) return;
    opened.current = true;
    openOnboarding();
  }, [autoOpen, openOnboarding]);

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Create your first company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Get started by creating a company.
        </p>
        <div className="mt-4">
          <Button onClick={() => openOnboarding()}>New Company</Button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="auth" element={<AuthPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />

        <Route element={<CloudAccessGate />}>
          <Route index element={<CompanyRootRedirect />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/heartbeats" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="heartbeats" replace />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="plugins" element={<PluginManager />} />
            <Route path="plugins/:pluginId" element={<PluginSettings />} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="tests/ux/runs" element={<UnprefixedBoardRedirect />} />
          <Route path="war-room" element={<UnprefixedBoardRedirect />} />
          <Route path="crm" element={<UnprefixedBoardRedirect />} />
          <Route path="crm/*" element={<UnprefixedBoardRedirect />} />
          <Route path="crm-messaging" element={<UnprefixedBoardRedirect />} />
          <Route path="crm-inbox" element={<UnprefixedBoardRedirect />} />
          <Route path="timetable" element={<UnprefixedBoardRedirect />} />
          <Route path="timetable/*" element={<UnprefixedBoardRedirect />} />
          <Route path="lich-hom-nay" element={<UnprefixedBoardRedirect />} />
          <Route path="lich-hom-nay/*" element={<UnprefixedBoardRedirect />} />
          <Route path="training" element={<UnprefixedBoardRedirect />} />
          <Route path="training/*" element={<UnprefixedBoardRedirect />} />
          <Route path="analytics" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      <OnboardingWizard />
      <DevToolsOverlay />
    </>
  );
}
