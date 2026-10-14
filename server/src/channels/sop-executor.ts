// SOP Workflow Executor
// Handles executing SOPs step-by-step: script, agent, api, approval, manual

import { supabase } from './zalo-personal/supabase.js';
import { spawn } from 'child_process';
import path from 'path';
import type { Response } from 'express';
import { loadAgentConfig, runAgentWithConfig } from './router.js';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');

// Default company UUID (GEMRAL) for single-tenant agent calls from the SOP executor.
const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID
  || 'f78ffdea-e400-46be-8705-5f6cfbce1eb0';

// ═══ Types ═══

export interface StepDef {
  order: number;
  name: string;
  type: 'script' | 'agent' | 'api' | 'approval' | 'manual';
  config: Record<string, any>;
}

export interface ExecutionContext {
  sopId: string;
  executionId: string;
  triggeredBy: string;
  triggerContext: Record<string, any>;
  stepResults: StepResult[];
  // SSE response object for streaming (optional)
  sseRes?: Response;
}

export interface StepResult {
  order: number;
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'waiting_approval' | 'rejected';
  output?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

// ═══ SSE Helper ═══

function sendSSE(res: Response | undefined, event: string, data: any) {
  if (!res || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ═══ Execute a full SOP ═══

export async function executeSop(
  sopId: string,
  triggeredBy: string,
  triggerContext: Record<string, any> = {},
  sseRes?: Response,
): Promise<{ executionId: string; status: string }> {
  // Fetch SOP definition
  const { data: sop, error: sopErr } = await supabase
    .from('gem_sops')
    .select('*')
    .eq('sop_id', sopId)
    .single();

  if (sopErr || !sop) {
    throw new Error(`Không tìm thấy SOP: ${sopId}`);
  }

  const steps: StepDef[] = sop.steps || [];
  if (steps.length === 0) {
    throw new Error(`SOP ${sopId} chưa có steps. Hãy thêm steps trước khi chạy.`);
  }

  // Create execution record
  const { data: execution, error: execErr } = await supabase
    .from('gem_sop_executions')
    .insert({
      sop_id: sopId,
      status: 'running',
      current_step: 1,
      step_results: [],
      triggered_by: triggeredBy,
      trigger_context: triggerContext,
    })
    .select()
    .single();

  if (execErr || !execution) {
    throw new Error(`Lỗi tạo execution: ${execErr?.message}`);
  }

  const executionId = execution.id;
  const ctx: ExecutionContext = {
    sopId,
    executionId,
    triggeredBy,
    triggerContext,
    stepResults: [],
    sseRes,
  };

  sendSSE(sseRes, 'execution:start', {
    executionId,
    sopId,
    sopName: sop.name,
    totalSteps: steps.length,
  });

  // Audit: execution started
  await supabase.from('gem_sop_audit').insert({
    sop_id: sopId,
    execution_id: executionId,
    action: 'execution_started',
    actor: triggeredBy,
    detail: { trigger_context: triggerContext },
  });

  // Execute steps sequentially
  let finalStatus = 'completed';
  for (const step of steps) {
    sendSSE(sseRes, 'step:start', { step: step.order, name: step.name, type: step.type });

    // Update current step in DB
    await supabase.from('gem_sop_executions')
      .update({ current_step: step.order })
      .eq('id', executionId);

    const result = await executeStep(step, ctx);
    ctx.stepResults.push(result);

    // Update step_results in DB
    await supabase.from('gem_sop_executions')
      .update({ step_results: ctx.stepResults })
      .eq('id', executionId);

    sendSSE(sseRes, 'step:complete', { step: step.order, result });

    if (result.status === 'waiting_approval') {
      finalStatus = 'paused';
      await supabase.from('gem_sop_executions')
        .update({ status: 'paused' })
        .eq('id', executionId);

      sendSSE(sseRes, 'execution:paused', {
        executionId,
        pausedAtStep: step.order,
        reason: 'Đang chờ phê duyệt',
      });
      return { executionId, status: 'paused' };
    }

    if (result.status === 'failed') {
      finalStatus = 'failed';
      await supabase.from('gem_sop_executions')
        .update({
          status: 'failed',
          error_message: result.error || 'Bước thực hiện thất bại',
          completed_at: new Date().toISOString(),
        })
        .eq('id', executionId);

      sendSSE(sseRes, 'execution:failed', {
        executionId,
        failedAtStep: step.order,
        error: result.error,
      });

      // Audit: execution failed
      await supabase.from('gem_sop_audit').insert({
        sop_id: sopId,
        execution_id: executionId,
        action: 'execution_failed',
        actor: 'system',
        detail: { failed_step: step.order, error: result.error },
      });

      return { executionId, status: 'failed' };
    }
  }

  // All steps completed
  await supabase.from('gem_sop_executions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', executionId);

  sendSSE(sseRes, 'execution:complete', { executionId, totalSteps: steps.length });

  // Audit: execution completed
  await supabase.from('gem_sop_audit').insert({
    sop_id: sopId,
    execution_id: executionId,
    action: 'execution_completed',
    actor: 'system',
    detail: { steps_completed: steps.length },
  });

  return { executionId, status: finalStatus };
}

// ═══ Execute a single step ═══

export async function executeStep(step: StepDef, ctx: ExecutionContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const base: Omit<StepResult, 'status'> = {
    order: step.order,
    name: step.name,
    startedAt,
  };

  try {
    switch (step.type) {
      case 'script':
        return await executeScriptStep(step, ctx, base);
      case 'agent':
        return await executeAgentStep(step, ctx, base);
      case 'api':
        return await executeApiStep(step, ctx, base);
      case 'approval':
        return { ...base, status: 'waiting_approval', output: 'Đang chờ phê duyệt' };
      case 'manual':
        return { ...base, status: 'waiting_approval', output: step.config.instructions || 'Cần thao tác thủ công' };
      default:
        return { ...base, status: 'failed', error: `Loại step không hỗ trợ: ${step.type}`, completedAt: new Date().toISOString() };
    }
  } catch (err: any) {
    return { ...base, status: 'failed', error: err.message, completedAt: new Date().toISOString() };
  }
}

// ═══ Script step: spawn child process ═══

async function executeScriptStep(step: StepDef, ctx: ExecutionContext, base: Omit<StepResult, 'status'>): Promise<StepResult> {
  const { command, args = [], cwd, timeout = 120000 } = step.config;
  if (!command) {
    return { ...base, status: 'failed', error: 'Thiếu command trong config', completedAt: new Date().toISOString() };
  }

  const workDir = cwd || PROJECT_ROOT;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn(command, args, {
      shell: true,
      cwd: workDir,
      env: { ...process.env, PYTHONUTF8: '1' },
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        resolve({ ...base, status: 'failed', error: `Timeout sau ${timeout}ms`, completedAt: new Date().toISOString() });
      }
    }, timeout);

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      sendSSE(ctx.sseRes, 'step:stdout', { step: step.order, text });
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      sendSSE(ctx.sseRes, 'step:stderr', { step: step.order, text });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;

      if (code === 0) {
        resolve({ ...base, status: 'success', output: stdout.slice(-4000), completedAt: new Date().toISOString() });
      } else {
        resolve({ ...base, status: 'failed', error: `Exit code ${code}: ${stderr.slice(-2000)}`, completedAt: new Date().toISOString() });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve({ ...base, status: 'failed', error: `Spawn error: ${err.message}`, completedAt: new Date().toISOString() });
    });
  });
}

// ═══ Agent step: real agent invocation via router ═══
//
// Fixed 2026-04-08 — was a stub returning mock success, causing "no agent
// actually works when SOPs run" (BUG-028). Now calls runAgentWithConfig()
// from router.ts with the same buildSystemPrompt pipeline as channel replies,
// so the agent sees Goals + SOUL + TOOLS + HEARTBEAT + MEMORY + company
// context. Every step uses a stable session key `sop:{execId}:{stepOrder}`
// so multi-step SOPs preserve conversation memory across turns.

async function executeAgentStep(
  step: StepDef,
  ctx: ExecutionContext,
  base: Omit<StepResult, 'status'>,
): Promise<StepResult> {
  const { agent_slug, prompt, timeout = 120000 } = step.config;

  if (!agent_slug) {
    return {
      ...base,
      status: 'failed',
      error: 'Thiếu agent_slug trong step.config',
      completedAt: new Date().toISOString(),
    };
  }

  // Load agent config from paperclip_agents table (SSOT)
  const config = await loadAgentConfig(agent_slug);
  if (!config) {
    return {
      ...base,
      status: 'failed',
      error: `Không tìm thấy agent "${agent_slug}" trong paperclip_agents`,
      completedAt: new Date().toISOString(),
    };
  }
  if (!config.enabled) {
    return {
      ...base,
      status: 'skipped',
      output: `Agent "${agent_slug}" đang bị disable. Skip step.`,
      completedAt: new Date().toISOString(),
    };
  }

  // Inject company context so buildSystemPrompt can fetch Goals from DB
  (config as any)._companyId = DEFAULT_COMPANY_ID;

  // Stable session key — lets multi-step SOPs preserve conversation memory
  const sessionKey = `sop:${ctx.executionId}:${step.order}`;

  // Build the prompt with context from previous steps (so step N can reference
  // step N-1's output naturally). Trimmed to last 3 previous results to avoid
  // prompt explosion.
  const prevResults = ctx.stepResults.slice(-3)
    .map((r) => `## Step ${r.order}: ${r.name}\n${(r.output || '').slice(0, 500)}`)
    .join('\n\n');

  const userMessage = [
    prevResults ? `# CONTEXT TỪ CÁC BƯỚC TRƯỚC\n${prevResults}` : '',
    `# YÊU CẦU BƯỚC HIỆN TẠI: ${step.name}`,
    prompt || step.config.instructions || `Hoàn thành bước: ${step.name}`,
  ].filter(Boolean).join('\n\n');

  sendSSE(ctx.sseRes, 'step:agent_start', {
    step: step.order,
    agent: agent_slug,
    sessionKey,
  });

  // Invoke the agent with a hard timeout. We race the agent call against a
  // timer so a hung provider doesn't stall the entire SOP run, and abort the
  // underlying CLI subprocess on timeout so it does not linger (GEM-1427 §6.5).
  let timedOut = false;
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<string>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      reject(new Error(`Agent step timeout sau ${timeout}ms`));
    }, timeout);
  });

  try {
    const reply = await Promise.race([
      runAgentWithConfig(config, sessionKey, userMessage, undefined, abortController.signal),
      timeoutPromise,
    ]);

    // Stream a summarized version of the reply back via SSE so the UI can
    // show live output. We also include the full reply in the step result.
    sendSSE(ctx.sseRes, 'step:stdout', {
      step: step.order,
      text: reply,
    });
    sendSSE(ctx.sseRes, 'step:agent_complete', {
      step: step.order,
      agent: agent_slug,
    });

    return {
      ...base,
      status: 'success',
      output: reply,
      completedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    const message = timedOut
      ? `Timeout sau ${timeout}ms — agent "${agent_slug}" không phản hồi`
      : err?.message || String(err);
    sendSSE(ctx.sseRes, 'step:stderr', {
      step: step.order,
      text: message,
    });
    return {
      ...base,
      status: 'failed',
      error: message,
      completedAt: new Date().toISOString(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ═══ API step: HTTP call ═══

async function executeApiStep(step: StepDef, _ctx: ExecutionContext, base: Omit<StepResult, 'status'>): Promise<StepResult> {
  const { url, method = 'POST', headers = {}, body } = step.config;
  if (!url) {
    return { ...base, status: 'failed', error: 'Thiếu url trong config', completedAt: new Date().toISOString() };
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await resp.text();
    if (!resp.ok) {
      return { ...base, status: 'failed', error: `HTTP ${resp.status}: ${text.slice(0, 1000)}`, completedAt: new Date().toISOString() };
    }

    return { ...base, status: 'success', output: text.slice(0, 4000), completedAt: new Date().toISOString() };
  } catch (err: any) {
    return { ...base, status: 'failed', error: `Fetch error: ${err.message}`, completedAt: new Date().toISOString() };
  }
}

// ═══ Approve a paused step ═══

export async function approveStep(executionId: string, stepOrder: number, approver: string = 'board'): Promise<{ status: string; executionId: string }> {
  const { data: execution, error } = await supabase
    .from('gem_sop_executions')
    .select('*')
    .eq('id', executionId)
    .single();

  if (error || !execution) {
    throw new Error(`Không tìm thấy execution: ${executionId}`);
  }

  if (execution.status !== 'paused') {
    throw new Error(`Execution không ở trạng thái paused (hiện tại: ${execution.status})`);
  }

  const stepResults: StepResult[] = execution.step_results || [];
  const stepIdx = stepResults.findIndex(r => r.order === stepOrder);
  if (stepIdx === -1) {
    throw new Error(`Không tìm thấy step ${stepOrder} trong kết quả`);
  }

  // Mark step as approved
  stepResults[stepIdx].status = 'success';
  stepResults[stepIdx].output = `Đã phê duyệt bởi ${approver}`;
  stepResults[stepIdx].completedAt = new Date().toISOString();

  await supabase.from('gem_sop_executions')
    .update({ step_results: stepResults, status: 'running' })
    .eq('id', executionId);

  // Audit
  await supabase.from('gem_sop_audit').insert({
    sop_id: execution.sop_id,
    execution_id: executionId,
    action: 'step_approved',
    actor: approver,
    detail: { step_order: stepOrder },
  });

  // Fetch SOP to get remaining steps
  const { data: sop } = await supabase
    .from('gem_sops')
    .select('steps, name')
    .eq('sop_id', execution.sop_id)
    .single();

  const allSteps: StepDef[] = sop?.steps || [];
  const remainingSteps = allSteps.filter(s => s.order > stepOrder);

  if (remainingSteps.length === 0) {
    // No more steps — mark completed
    await supabase.from('gem_sop_executions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', executionId);
    return { status: 'completed', executionId };
  }

  // Continue executing remaining steps (without SSE for now)
  const ctx: ExecutionContext = {
    sopId: execution.sop_id,
    executionId,
    triggeredBy: execution.triggered_by,
    triggerContext: execution.trigger_context || {},
    stepResults,
  };

  for (const step of remainingSteps) {
    await supabase.from('gem_sop_executions')
      .update({ current_step: step.order })
      .eq('id', executionId);

    const result = await executeStep(step, ctx);
    ctx.stepResults.push(result);

    await supabase.from('gem_sop_executions')
      .update({ step_results: ctx.stepResults })
      .eq('id', executionId);

    if (result.status === 'waiting_approval') {
      await supabase.from('gem_sop_executions')
        .update({ status: 'paused' })
        .eq('id', executionId);
      return { status: 'paused', executionId };
    }

    if (result.status === 'failed') {
      await supabase.from('gem_sop_executions')
        .update({ status: 'failed', error_message: result.error, completed_at: new Date().toISOString() })
        .eq('id', executionId);
      return { status: 'failed', executionId };
    }
  }

  await supabase.from('gem_sop_executions')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', executionId);

  return { status: 'completed', executionId };
}

// ═══ Reject a paused step ═══

export async function rejectStep(
  executionId: string,
  stepOrder: number,
  feedback: string = '',
  rejector: string = 'board',
): Promise<{ status: string; executionId: string }> {
  const { data: execution, error } = await supabase
    .from('gem_sop_executions')
    .select('*')
    .eq('id', executionId)
    .single();

  if (error || !execution) {
    throw new Error(`Không tìm thấy execution: ${executionId}`);
  }

  if (execution.status !== 'paused') {
    throw new Error(`Execution không ở trạng thái paused (hiện tại: ${execution.status})`);
  }

  const stepResults: StepResult[] = execution.step_results || [];
  const stepIdx = stepResults.findIndex(r => r.order === stepOrder);
  if (stepIdx === -1) {
    throw new Error(`Không tìm thấy step ${stepOrder} trong kết quả`);
  }

  stepResults[stepIdx].status = 'rejected';
  stepResults[stepIdx].output = `Bị từ chối bởi ${rejector}: ${feedback}`;
  stepResults[stepIdx].completedAt = new Date().toISOString();

  await supabase.from('gem_sop_executions')
    .update({
      step_results: stepResults,
      status: 'rejected',
      error_message: `Step ${stepOrder} bị từ chối: ${feedback}`,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId);

  // Audit
  await supabase.from('gem_sop_audit').insert({
    sop_id: execution.sop_id,
    execution_id: executionId,
    action: 'step_rejected',
    actor: rejector,
    detail: { step_order: stepOrder, feedback },
  });

  return { status: 'rejected', executionId };
}
