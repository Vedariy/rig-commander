const FIXED_AUDIO_PROFILES = {
  'dev-owner':              { freqs: [523.25, 659.25, 783.99], wave: 'triangle', step: 0.15, dur: 0.22, gain: 0.15 },
  'dev-operator':           { freqs: [987.77, 1318.51, 987.77], wave: 'sine',    step: 0.12, dur: 0.15, gain: 0.13 },
  'operator-agent':         { freqs: [1046.50, 783.99, 1046.50], wave: 'sine',   step: 0.12, dur: 0.15, gain: 0.13 },
  'dev-senior-architector': { freqs: [587.33, 880.00, 1174.66], wave: 'triangle', step: 0.16, dur: 0.24, gain: 0.13 },
  'dev-check':              { freqs: [740.00, 554.37, 880.00],  wave: 'triangle', step: 0.11, dur: 0.16, gain: 0.15 },
  'dev-check-argon':        { freqs: [830.61, 622.25, 987.77],  wave: 'sine',     step: 0.10, dur: 0.15, gain: 0.15 },
  'dev-coder':              { freqs: [440.00, 554.37, 659.25],  wave: 'sine',     step: 0.13, dur: 0.17, gain: 0.14 },
  'dev-coder2':             { freqs: [659.25, 554.37, 440.00],  wave: 'triangle', step: 0.13, dur: 0.17, gain: 0.14 },
  'dev-coder3':             { freqs: [493.88, 740.00, 587.33],  wave: 'sine',     step: 0.12, dur: 0.16, gain: 0.14 },
  'dev-coder4':             { freqs: [587.33, 493.88, 783.99],  wave: 'triangle', step: 0.11, dur: 0.16, gain: 0.15 },
  'dev-coder5':             { freqs: [392.00, 587.33, 659.25],  wave: 'sine',     step: 0.14, dur: 0.18, gain: 0.14 }
};

const FALLBACK_SCALE = [392.00, 440.00, 493.88, 587.33, 659.25, 783.99, 880.00, 987.77, 1174.66];

export function getAgentAudioProfile(agentId) {
  const seat = String(agentId || '').split('@')[0].toLowerCase();
  if (FIXED_AUDIO_PROFILES[seat]) return FIXED_AUDIO_PROFILES[seat];

  let hash = 2166136261;
  for (let i = 0; i < seat.length; i++) {
    hash ^= seat.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const u = hash >>> 0;
  const n1 = FALLBACK_SCALE[u % FALLBACK_SCALE.length];
  const n2 = FALLBACK_SCALE[(u >> 4) % FALLBACK_SCALE.length];
  const n3 = FALLBACK_SCALE[(u >> 8) % FALLBACK_SCALE.length];
  const wave = (u & 1) ? 'triangle' : 'sine';
  return { freqs: [n1, n2, n3], wave, step: 0.13, dur: 0.17, gain: 0.14 };
}
