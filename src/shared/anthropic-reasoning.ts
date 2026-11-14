import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { PermanentError, RetryableError } from "./errors.ts";
import { AgentAnalysisSchema, type ReasoningPort, type ReasoningRequest, type ReasoningResult } from "./reasoning.ts";

/**
 * Claude adapter. Structured output (output_config.format) is validated
 * against AgentAnalysisSchema by the SDK. Server-side refusal fallbacks are
 * enabled ("default" routing). Docs: https://platform.claude.com/docs
 */
export class AnthropicReasoning implements ReasoningPort {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly effort: "low" | "medium" | "high" | "xhigh" | "max",
  ) {
    this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async analyse(req: ReasoningRequest): Promise<ReasoningResult> {
    const started = Date.now();
    try {
      const response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: this.effort, format: betaZodOutputFormat(AgentAnalysisSchema) },
      });
      const usage = {
        provider: "anthropic",
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - started,
      };
      if (response.stop_reason === "refusal") {
        throw new PermanentError(`model declined the task (${response.stop_details?.category ?? "unspecified"})`);
      }
      if (!response.parsed_output) {
        throw new RetryableError(`model output did not match the schema (stop_reason ${response.stop_reason})`);
      }
      return { analysis: response.parsed_output, usage: { ...usage, outcome: "succeeded" }, simulated: false };
    } catch (err) {
      if (err instanceof PermanentError || err instanceof RetryableError) throw err;
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new RetryableError(`Claude API temporarily unavailable: ${err.message}`);
      }
      if (err instanceof Anthropic.APIError) throw new PermanentError(`Claude API error ${err.status}: ${err.message}`);
      throw err;
    }
  }
}
