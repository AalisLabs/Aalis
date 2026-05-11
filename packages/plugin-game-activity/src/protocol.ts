/**
 * Bridge protocol — the WebSocket message contract between Aalis (decision side)
 * and a game-side bridge (e.g. AalisBridge mod for STS2).
 *
 * Direction:
 *   Bridge → Aalis : "event" messages (state pushes, prompts, results)
 *   Aalis → Bridge : "command" messages (intents to perform an action)
 *
 * Both sides exchange newline-delimited JSON over a single WebSocket. Each
 * message has a `type` discriminator and an optional `requestId` for pairing.
 *
 * The protocol is intentionally game-agnostic. Concrete game payloads live
 * inside `state` / `action` and are typed by the adapter plugin (e.g.
 * @aalis/plugin-slay-spire-agent).
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeMessage = BridgeEvent | BridgeCommand;

// ── Bridge → Aalis ──────────────────────────────────────────────────────────
export type BridgeEvent =
  | BridgeHelloEvent
  | BridgeStateEvent
  | BridgePromptEvent
  | BridgeNotifyEvent
  | BridgeActionResultEvent
  | BridgeByeEvent;

export interface BridgeHelloEvent {
  type: 'hello';
  /** Unique ID of the connecting bridge instance. */
  bridgeId: string;
  /** Human readable label, e.g. "AalisBridge for STS2". */
  bridgeLabel: string;
  /** Game identifier ("sts2", etc.) — used to route to a matching adapter. */
  game: string;
  protocolVersion: number;
  /** Free-form info (game version, mod versions, player ids, etc.). */
  info?: Record<string, unknown>;
}

/**
 * Periodic / on-change snapshot of the entire game world relevant to Aalis.
 * The bridge SHOULD coalesce rapid changes; Aalis SHOULD treat the latest
 * state as ground truth and discard older ones.
 */
export interface BridgeStateEvent {
  type: 'state';
  /** Monotonic counter from the bridge — useful for debouncing. */
  seq: number;
  /** ms since unix epoch on the bridge clock. */
  timestamp: number;
  /** Phase descriptor, e.g. "menu" | "combat" | "card_reward" | "map" | "event" | "shop" | "game_over". */
  phase: string;
  /** Adapter-specific state payload. Treat as opaque at this layer. */
  state: Record<string, unknown>;
}

/**
 * Bridge asks Aalis to make a decision now. Distinct from `state` so
 * Aalis only spends LLM calls when a decision is actually required (e.g.
 * her turn started, a card-reward screen opened).
 */
export interface BridgePromptEvent {
  type: 'prompt';
  requestId: string;
  /** Optional snapshot embedded for convenience (otherwise use last state). */
  state?: Record<string, unknown>;
  phase: string;
  /** Hard deadline before bridge will auto-default. ms since epoch. */
  deadline?: number;
  /** Bridge's hint about what kind of decision is wanted. */
  intent?: 'choose_action' | 'choose_reward' | 'event_choice' | 'shop_choice' | string;
  /** Adapter-defined list of legal actions / choices. */
  choices?: unknown[];
}

/** Free-form game-side notification (chat from teammates, fight ended, etc.). */
export interface BridgeNotifyEvent {
  type: 'notify';
  /** Lightweight category, e.g. "team_chat" | "combat_start" | "combat_end" | "level_up". */
  category: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** Result of an action requested by Aalis. */
export interface BridgeActionResultEvent {
  type: 'action_result';
  requestId: string;
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface BridgeByeEvent {
  type: 'bye';
  reason?: string;
}

// ── Aalis → Bridge ──────────────────────────────────────────────────────────
export type BridgeCommand = BridgeAckCommand | BridgeActionCommand | BridgeChatCommand | BridgeQueryCommand;

export interface BridgeAckCommand {
  type: 'ack';
  /** What this acks (a prompt requestId, hello, etc.). */
  requestId?: string;
  protocolVersion: number;
}

/**
 * Request the bridge to perform a single in-game action. The shape of
 * `action` is adapter-specific (e.g. for STS2: { kind: "play_card", cardId, targetId }).
 */
export interface BridgeActionCommand {
  type: 'action';
  requestId: string;
  /** Optional reference to the prompt that generated this action. */
  inResponseTo?: string;
  action: Record<string, unknown>;
  /** Free-form rationale Aalis can attach for debugging / replay. */
  reason?: string;
}

/** Aalis posts something visible in the in-game chat lobby. */
export interface BridgeChatCommand {
  type: 'chat';
  requestId: string;
  message: string;
}

/** Adapter-specific query (e.g. ask bridge to dump deck, list relics). */
export interface BridgeQueryCommand {
  type: 'query';
  requestId: string;
  query: string;
  args?: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
export function isBridgeEvent(msg: BridgeMessage): msg is BridgeEvent {
  return ['hello', 'state', 'prompt', 'notify', 'action_result', 'bye'].includes(msg.type);
}

export function isBridgeCommand(msg: BridgeMessage): msg is BridgeCommand {
  return ['ack', 'action', 'chat', 'query'].includes(msg.type);
}
