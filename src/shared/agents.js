const AGENTS = [
  { id: 'FOUNDERS', name: 'Founders', type: 'research', company: 'Platform Visionaries' },
  { id: 'CHIPS', name: 'Chips', type: 'research', company: 'Systems & Silicon' },
  { id: 'BIGTECH', name: 'Big Tech', type: 'research', company: 'Hyper-Scale Platforms' },
  { id: 'AILABS', name: 'AI Labs', type: 'research', company: 'Frontier Research' },
  { id: 'CODERS', name: 'Coders', type: 'research', company: 'AI Engineering' },
  { id: 'TECHVC', name: 'Tech VC', type: 'research', company: 'Venture & Markets' },
  { id: 'CHIEF', name: 'Chief', type: 'chief', company: 'Synthesis' },
  { id: 'TENSION', name: 'Deputy', type: 'tension', company: 'Stress Test' }
];

const RESEARCH_IDS = AGENTS.filter((a) => a.type === 'research').map((a) => a.id);

module.exports = { AGENTS, RESEARCH_IDS };
