import type { Context } from '@aalis/core';
import type { LLMService } from '@aalis/plugin-llm-api';
import type { BridgePromptEvent, BridgeStateEvent } from './protocol.js';

/**
 * Adapter contract — registered by a game-specific plugin (e.g. plugin-slay-spire-agent).
 * The adapter knows the schema of `state` and `action` payloads for its game and
 * is responsible for translating between game data and LLM prompts.
 *
 * Adapters do NOT manage transport or LLM calls; the activity runtime does that.
 */
export interface GameActivityAdapter {
  /** Match `BridgeHelloEvent.game`. */
  game: string;

  /** Human-friendly label for logs/UI. */
  label: string;

  /**
   * Produce a stable system prompt for the long-running decision thread.
   * Called once per session (when the bridge connects).
   */
  buildSystemPrompt(input: AdapterPromptInput): string;

  /**
   * Translate a `prompt` event into the user-facing message that goes to the
   * decision thread. Should embed enough state (current state event optional)
   * for the LLM to make a sound decision.
   */
  buildDecisionRequest(input: AdapterDecisionInput): string;

  /**
   * Parse the LLM's reply into a concrete `action` payload to send back over
   * the bridge. Returning `null` means "no action chosen, ack only".
   */
  parseDecisionReply(input: AdapterParseInput): AdapterActionChoice | null;

  /**
   * Optional game-specific fallback when repeated LLM calls produce no action.
   * The activity runtime owns transport and counting; the adapter owns policy.
   */
  resolveFallbackAction?(input: AdapterFallbackInput): AdapterActionChoice | null;
}

export interface AdapterPromptInput {
  ctx: Context;
  bridgeInfo: Record<string, unknown> | undefined;
  /** Recent chat vibes summary (may be empty in milestone 1). */
  vibes?: string;
  /** Aalis persona descriptor (free text). */
  personaPrompt?: string;
}

export interface AdapterDecisionInput {
  ctx: Context;
  prompt: BridgePromptEvent;
  latestState: BridgeStateEvent | undefined;
  vibes?: string;
}

export interface AdapterParseInput {
  ctx: Context;
  llmRaw: string;
  prompt: BridgePromptEvent;
}

export interface AdapterFallbackInput {
  ctx: Context;
  prompt: BridgePromptEvent;
  latestState: BridgeStateEvent | undefined;
  noChoiceStreak: number;
}

export interface AdapterActionChoice {
  action: Record<string, unknown>;
  reason?: string;
  chat?: string;
}

// ── runtime ─────────────────────────────────────────────────────────────────
export interface DecisionRuntime {
  llm: LLMService;
  /** When `decisionModel` is configured this overrides default LLM provider (contextId). */
  providerOverride?: string;
  /** When `decisionModel` is configured this overrides default LLM model. */
  modelOverride?: string;
  /** ms — soft cap for an LLM decision call. */
  timeoutMs: number;
  /** Override provider thinking mode; undefined means use provider/global default. */
  think?: boolean;
}
