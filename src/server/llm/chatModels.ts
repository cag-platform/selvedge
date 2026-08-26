import { agentById, type AgentId } from '../../shared/agents.js';
import { chatModelFor } from './providers.js';

export type ChatModelOption = {
  id: string;
  label: string;
  tier: 'fast' | 'balanced' | 'deep';
  note: string;
};

const BY_PROVIDER: Record<string, readonly ChatModelOption[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'fast', note: 'Fastest' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', tier: 'balanced', note: 'Best balance' },
    { id: 'claude-opus-5', label: 'Opus 5', tier: 'deep', note: 'Deepest' },
  ],
  openai: [
    { id: 'gpt-5.6-luna', label: '5.6 Luna', tier: 'fast', note: 'Fastest' },
    { id: 'gpt-5.6-terra', label: '5.6 Terra', tier: 'balanced', note: 'Best balance' },
    { id: 'gpt-5.6-sol', label: '5.6 Sol', tier: 'deep', note: 'Deepest' },
  ],
};

export function chatModelsFor(agent: AgentId): readonly ChatModelOption[] {
  const descriptor = agentById(agent);
  if (!descriptor) return [];
  return BY_PROVIDER[descriptor.provider] ?? [
    { id: chatModelFor(descriptor.provider), label: chatModelFor(descriptor.provider), tier: 'balanced', note: 'Default' },
  ];
}

export function defaultChatModelFor(agent: AgentId): string {
  const options = chatModelsFor(agent);
  return options.find((option) => option.tier === 'balanced')?.id ?? options[0]?.id ?? '';
}

export function modelBelongsToAgent(agent: AgentId, model: string): boolean {
  return chatModelsFor(agent).some((option) => option.id === model);
}
