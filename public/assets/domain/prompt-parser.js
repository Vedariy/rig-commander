export function parseInteractivePromptOptions(screenText) {
  if (!screenText || typeof screenText !== 'string') return [];
  const tailLines = screenText.split(/\r?\n/).slice(-42);

  // 1. Multi-line numbered selector (Codex / Claude Code: "› 1. Yes, proceed (y)")
  const candidates = [];
  for (const line of tailLines) {
    const m = line.match(/^\s*(?:[›❯>*•]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/);
    if (m) {
      candidates.push({ num: Number(m[1]), text: m[2].trim() });
    }
  }
  const lastOneIdx = candidates.map(c => c.num).lastIndexOf(1);
  if (lastOneIdx !== -1) {
    const seq = [];
    let expected = 1;
    for (let i = lastOneIdx; i < candidates.length && expected <= 9; i++) {
      if (candidates[i].num === expected) {
        seq.push(candidates[i]);
        expected++;
      }
    }
    if (seq.length >= 2) {
      return seq.map(item => ({
        keyStroke: `${item.num} Enter`,
        badge: String(item.num),
        fullText: item.text,
        shortLabel: item.text.length > 44 ? item.text.slice(0, 42) + '…' : item.text,
        isCancel: /\(esc\)|cancel|no,\s+and\s+tell|отмен/i.test(item.text),
        isPrimary: item.num === 1
      }));
    }
  }

  // 2. Inline bracketed prompt fallback: "[1] Yes  [2] Always  [n] Cancel"
  const nonEmptyTail = tailLines.filter(l => l.trim()).slice(-5).join(' ');
  const inlineMatches = [...nonEmptyTail.matchAll(/\[([1-9a-zA-Z])\]\s*([^[\]\n]{2,36})/g)];
  if (inlineMatches.length >= 2) {
    return inlineMatches.map((m, idx) => {
      const k = m[1];
      const txt = m[2].trim();
      return {
        keyStroke: `${k} Enter`,
        badge: k,
        fullText: txt,
        shortLabel: txt.length > 36 ? txt.slice(0, 34) + '…' : txt,
        isCancel: /^(n|esc|q)$/i.test(k) || /cancel|отмен/i.test(txt),
        isPrimary: idx === 0
      };
    });
  }

  return [];
}

const HITL_NAV_FOOTER_RE = /(?:↑\/↓\s*navigate|esc to cancel|enter to confirm|press enter to|tab\s+amend|ctrl\+g\s+ed|use arrow keys|select an option)/i;
const HITL_HEADER_RE = /(?:requesting permission for:|run this command\?|allow this command\?|allow running\b|do you want to (?:proceed|run|allow|continue)\?|would you like to (?:run|allow|proceed)|permission prompt|waiting for (?:human|approval)|approve\?\s*\(y\/n\)|\[y\/n\]|\(y\/n\)\s*$)/i;
const HITL_CONFIRM_OPT_RE = /^(?:yes\b|no,?\s*(?:cancel|and tell)|allow\b|always allow|deny\b|reject\b|approve\b|cancel\b|разрешить|отмен)/i;
const HITL_BOTTOM_YN_RE = /(?:\[Y\/n\]|\[y\/N\]|\(y\/n\)|run this command\?|allow this command\?|do you want to proceed\?)\s*$/i;

/**
 * High-precision detector for an active, blocking interactive confirmation prompt
 * at the bottom of a tmux screen (Antigravity/agy, Claude Code, Codex CLI, Gemini, Pi).
 * Rejects normal numbered markdown lists and stale scrolled-up prompts.
 */
export function detectLiveHitlPrompt(screenText) {
  if (!screenText || typeof screenText !== 'string') {
    return { blocked: false, reason: '', options: [] };
  }
  const nonEmpty = screenText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { blocked: false, reason: '', options: [] };
  }

  const tail = nonEmpty.slice(-26);
  const tailText = tail.join('\n');
  const bottom4 = tail.slice(-4).join('\n');
  const bottom3 = tail.slice(-3).join('\n');

  const options = parseInteractivePromptOptions(tailText);
  const hasNavFooter = HITL_NAV_FOOTER_RE.test(bottom4);
  const hasPromptHeader = HITL_HEADER_RE.test(tail.slice(-20).join('\n'));
  const hasConfirmOpt = options.some(o => HITL_CONFIRM_OPT_RE.test(o.fullText || '') || o.isCancel);

  // Locate the last option line in tail so scrolled-up historical menus never false-trigger
  let lastOptionIdx = -1;
  if (options.length >= 2) {
    const lastOpt = options[options.length - 1];
    const numRe = new RegExp(`^\\s*(?:[›❯>*•]\\s*)?${lastOpt.badge}[.)]\\s+`);
    for (let i = tail.length - 1; i >= 0; i--) {
      if (numRe.test(tail[i])) {
        lastOptionIdx = i;
        break;
      }
    }
    // Inline bracketed prompt fallback: options live on one of the bottom 4 lines
    if (lastOptionIdx === -1 && /\[[1-9a-zA-Z]\]/.test(bottom4)) {
      lastOptionIdx = tail.length - 1;
    }
  }
  const nearBottom = lastOptionIdx !== -1 && (tail.length - 1 - lastOptionIdx) <= 7;

  if (options.length >= 2 && nearBottom && (hasNavFooter || hasPromptHeader || hasConfirmOpt)) {
    return {
      blocked: true,
      reason: hasPromptHeader ? 'permission_prompt' : `menu (${options.length} options)`,
      options
    };
  }

  if (hasNavFooter && hasPromptHeader) {
    return { blocked: true, reason: 'permission_prompt', options };
  }

  if (HITL_BOTTOM_YN_RE.test(bottom3)) {
    return { blocked: true, reason: 'permission_prompt', options };
  }

  return { blocked: false, reason: '', options: [] };
}

const ACTIVE_TERMINAL_WORK_RE = /(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|esc to interrupt|ctrl\+c to (?:interrupt|stop|cancel)|(?:thinking|reasoning|generating|streaming|searching|evaluating)\.{2,3}|running\s+\d+\s+test|working\s*\(\d+|⏳\s*running)/i;
const IDLE_FOOTER_MARKER_RE = /(?:^\?\s*for shortcuts\b|^>\s*accept-edits mode\b|shift\+tab\s+to\s+cycle|bypass permissions on\b|auto-accept edits on\b|enter to send\b.*shortcuts|type your message|ask anything|send a message)/i;
const IDLE_BARE_PROMPT_RE = /^\s*[›❯>]\s*(?:$|try\s+"|\/help\b|accept-edits\b)/i;

/**
 * High-precision detector for a terminal AI agent (Antigravity/agy, Claude Code, Codex, Gemini)
 * sitting idle at its empty input prompt — prevents OpenRig terminal-motion false 'working' states.
 * Never returns idle when a live HITL prompt or active spinner/working marker is visible.
 */
export function detectTerminalIdleAtPrompt(screenText) {
  if (!screenText || typeof screenText !== 'string') {
    return { idle: false, reason: '' };
  }
  if (detectLiveHitlPrompt(screenText).blocked) {
    return { idle: false, reason: '' };
  }
  const nonEmpty = screenText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { idle: false, reason: '' };
  }

  const tail12 = nonEmpty.slice(-12);
  const tail12Text = tail12.join('\n');
  if (ACTIVE_TERMINAL_WORK_RE.test(tail12Text)) {
    return { idle: false, reason: '' };
  }

  const bottom6 = nonEmpty.slice(-6);
  const hasFooterMarker = bottom6.some(l => IDLE_FOOTER_MARKER_RE.test(l.trim()));
  const hasBarePrompt = bottom6.some(l => IDLE_BARE_PROMPT_RE.test(l));

  if (hasFooterMarker || hasBarePrompt) {
    return { idle: true, reason: 'idle_at_prompt' };
  }

  return { idle: false, reason: '' };
}
