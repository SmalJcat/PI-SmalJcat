// A local observation of one assistant response, never inferred from context size.
export const emptyResponseSpeed = () => ({ startedAt: null, tokensPerSecond: null });
export function responseSpeed(state, event, now) {
  if (event.type === 'agent_start' || event.type === 'transport_exit') return emptyResponseSpeed();
  if (event.type === 'agent_settled') return { ...state, startedAt: null };
  if (event.type === 'message_start' && event.message?.role === 'assistant') return { startedAt: now, tokensPerSecond: null };
  if (event.type !== 'message_end' || event.message?.role !== 'assistant') return state;
  const elapsed = now - state.startedAt, output = event.message.usage?.output;
  // Batched/replayed messages do not provide a meaningful observation interval.
  const valid = state.startedAt !== null && elapsed >= 50 && Number.isFinite(elapsed)
    && Number.isSafeInteger(output) && output > 0 && !['error', 'aborted'].includes(event.message.stopReason);
  return { startedAt: null, tokensPerSecond: valid ? output * 1000 / elapsed : null };
}
export function displayCost(cost) {
  if (!cost || !Number.isFinite(cost.amount) || cost.amount < 0 || typeof cost.currency !== 'string' || !cost.currency.trim()) return '—';
  const amount = cost.amount > 0 && cost.amount < .0001 ? '<0.0001' : cost.amount.toFixed(4);
  return cost.currency.toUpperCase() === 'USD' ? `$${amount}` : `${cost.currency} ${amount}`;
}
