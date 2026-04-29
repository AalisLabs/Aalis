#!/usr/bin/env node
import assert from 'node:assert/strict';

const DAY = 86_400_000;
const now = Date.now();

function clampRelationScore(score) {
  return Math.min(100, Math.max(0, Math.round(score * 10) / 10));
}

function relationIncrementFor(triggerType, cfg) {
  if (triggerType === 'immediate') return cfg.relationIncrementImmediate;
  if (triggerType === 'interval') return cfg.relationIncrementInterval;
  if (triggerType === 'idle') return 0;
  return cfg.relationIncrementDirect;
}

function applyRelationUpdate(profile, triggerType, cfg, currentTime = now) {
  const last = profile.lastInteractionAt;
  const daysSinceLast = last ? Math.max(0, (currentTime - last) / DAY) : 0;
  const decayed = clampRelationScore((profile.relationScore ?? 0) - daysSinceLast * cfg.relationScoreDecayPerDay);
  const nextScore = clampRelationScore(decayed + relationIncrementFor(triggerType, cfg));
  return {
    ...profile,
    relationScore: nextScore,
    interactionCount: (profile.interactionCount ?? 0) + (triggerType === 'idle' ? 0 : 1),
    lastInteractionAt: triggerType === 'idle' ? profile.lastInteractionAt : currentTime,
    updatedAt: currentTime,
  };
}

function isFactActive(fact, cfg, currentTime = now) {
  if (fact.temporality !== 'temporary') return true;
  if (cfg.temporaryFactMaxAgeDays <= 0) return true;
  const base = fact.updatedAt || fact.observedAt || 0;
  if (!base) return true;
  return currentTime - base <= cfg.temporaryFactMaxAgeDays * DAY;
}

function selectParticipantIds(messages, dataUserId, hasPrimarySpeaker, maxOtherParticipants) {
  const others = new Map();
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const uid = typeof msg.metadata?.userId === 'string' ? msg.metadata.userId.trim() : undefined;
    if (!uid) continue;
    if (hasPrimarySpeaker && uid === dataUserId) continue;
    if (others.has(uid)) continue;
    others.set(uid, true);
    if (others.size >= maxOtherParticipants) break;
  }
  return [...others.keys()];
}

const cfg = {
  relationIncrementDirect: 1,
  relationIncrementImmediate: 1.5,
  relationIncrementInterval: 0.5,
  relationScoreDecayPerDay: 0.5,
  temporaryFactMaxAgeDays: 90,
};

{
  const profile = applyRelationUpdate({ relationScore: 10, interactionCount: 2, lastInteractionAt: now - 10 * DAY }, 'immediate', cfg, now);
  assert.equal(profile.relationScore, 6.5, 'relationScore should decay then apply immediate increment');
  assert.equal(profile.interactionCount, 3, 'non-idle interactions should increment count');
}

{
  const profile = applyRelationUpdate({ relationScore: 10, interactionCount: 2, lastInteractionAt: now - 10 * DAY }, 'idle', cfg, now);
  assert.equal(profile.relationScore, 5, 'idle should decay but not increment score');
  assert.equal(profile.interactionCount, 2, 'idle should not increment count');
  assert.equal(profile.lastInteractionAt, now - 10 * DAY, 'idle should not replace lastInteractionAt');
}

{
  assert.equal(isFactActive({ temporality: 'permanent', updatedAt: now - 365 * DAY }, cfg, now), true);
  assert.equal(isFactActive({ temporality: 'temporary', updatedAt: now - 30 * DAY }, cfg, now), true);
  assert.equal(isFactActive({ temporality: 'temporary', updatedAt: now - 120 * DAY }, cfg, now), false);
}

{
  const messages = [
    { role: 'user', metadata: { userId: 'A' } },
    { role: 'assistant' },
    { role: 'user', metadata: { userId: 'B' } },
    { role: 'user', metadata: { userId: 'A' } },
  ];
  assert.deepEqual(selectParticipantIds(messages, 'B', true, 3), ['A'], 'immediate/direct should exclude primary speaker');
  assert.deepEqual(selectParticipantIds(messages, 'B', false, 3), ['A', 'B'], 'interval/idle should not invent a primary speaker');
}

console.log('profile-behavior-eval: ok');
