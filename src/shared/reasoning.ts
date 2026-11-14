import { z } from "zod";

/** Structured result every reasoning-driven agent task returns. */
export const AgentAnalysisSchema = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      statement: z.string(),
      evidence: z.string(),
      source: z.string(),
    }),
  ),
  recommendations: z.array(
    z.object({
      action: z.string(),
      rationale: z.string(),
      expectedImpact: z.string(),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
  proposedActions: z.array(
    z.object({
      actionType: z.string(),
      title: z.string(),
      rationale: z.string(),
      payloadJson: z.string(),
    }),
  ),
  dataGaps: z.array(z.string()),
  injectionAttemptsObserved: z.array(z.string()),
});
export type AgentAnalysis = z.infer<typeof AgentAnalysisSchema>;

export interface ReasoningRequest {
  agentId: string;
  taskId: string;
  system: string;
  prompt: string;
}

export interface ReasoningUsage {
  provider: string;
  model: string;
  outcome: "succeeded" | "refused" | "invalid_output" | "error" | "simulated";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ReasoningResult {
  analysis: AgentAnalysis;
  usage: ReasoningUsage;
  simulated: boolean;
}

export interface ReasoningPort {
  analyse(req: ReasoningRequest): Promise<ReasoningResult>;
}

/**
 * Used when no API key is configured or in tests. It does not pretend to
 * reason: the output says plainly that no analysis was performed.
 */
export class SimulatedReasoning implements ReasoningPort {
  async analyse(req: ReasoningRequest): Promise<ReasoningResult> {
    return {
      simulated: true,
      analysis: {
        summary: `SIMULATION: no AI analysis was performed for task ${req.taskId}. Configure ANTHROPIC_API_KEY to enable reasoning.`,
        findings: [],
        recommendations: [],
        proposedActions: [],
        dataGaps: ["AI reasoning is not configured"],
        injectionAttemptsObserved: [],
      },
      usage: { provider: "simulation", model: "none", outcome: "simulated", inputTokens: 0, outputTokens: 0, latencyMs: 0 },
    };
  }
}

/**
 * Deterministic stand-in for simulations and tests: returns a scripted
 * analysis per task type. Output is marked simulated and is never presented
 * as real reasoning.
 */
export class ScriptedReasoning implements ReasoningPort {
  readonly calls: ReasoningRequest[] = [];
  constructor(private readonly script: (req: ReasoningRequest) => Partial<AgentAnalysis> | Promise<Partial<AgentAnalysis>>) {}
  async analyse(req: ReasoningRequest): Promise<ReasoningResult> {
    this.calls.push(req);
    const partial = await this.script(req);
    return {
      simulated: true,
      analysis: {
        summary: partial.summary ?? "SIMULATION: scripted analysis",
        findings: partial.findings ?? [],
        recommendations: partial.recommendations ?? [],
        proposedActions: partial.proposedActions ?? [],
        dataGaps: partial.dataGaps ?? [],
        injectionAttemptsObserved: partial.injectionAttemptsObserved ?? [],
      },
      usage: { provider: "simulation", model: "scripted", outcome: "simulated", inputTokens: 0, outputTokens: 0, latencyMs: 0 },
    };
  }
}
