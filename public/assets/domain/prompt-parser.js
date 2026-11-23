const NUMBERED_OPT_RE = /^\s*(?:[›❯>*•]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const HITL_CONFIRM_OPT_RE = /^(?:yes\b|no,?\s*(?:cancel|and tell)|allow\b|always allow|deny\b|reject\b|approve\b|cancel\b|continue\b|persist\b|разрешить|отмен)/i;
const HITL_CANCEL_OPT_RE = /\(esc\)|cancel|no,\s+and\s+tell|deny\b|reject\b|отмен/i;

// Unambiguous interactive confirmation/selection dialog footers across Antigravity/Gemini, Claude Code, Codex, Pi.
// NOTE: bare "esc to cancel" is intentionally excluded here because Antigravity/Gemini CLI prints it while actively streaming.
const HITL_STRONG_NAV_RE = /(?:↑\/↓\s*navigate|↑↓\s*to\s*navigate|tab\s+amend|tab\s+to\s+amend|ctrl\+g\s+ed|enter\s+to\s+(?:confirm|select)|press\s+enter\s+to\s+(?:confirm|select)|use\s+arrow\s+keys|space\s+to\s+select|select\s+an\s+option|esc\s+to\s+cancel\s*[·•|]\s*tab)/i;
const HITL_WEAK_CANCEL_RE = /(?:esc\s+to\s+cancel|press\s+esc\s+to\s+cancel)/i;
const HITL_HEADER_RE = /(?:requesting\s+permission\s+for:|run\s+this\s+command\?|allow\s+this\s+(?:command|tool|action)\?|allow\s+running\b|do\s+you\s+want\s+to\s+(?:proceed|run|allow|continue|make\s+this\s+edit|create|delete)\??|would\s+you\s+like\s+to\s+(?:run|allow|proceed)|permission\s+prompt|waiting\s+for\s+(?:human|approval)|persist\s+to\s+settings\.json|approve\?\s*\(y\/n\)|\[y\/n\]|\(y\/n\)\s*$)/i;
const HITL_BOTTOM_YN_RE = /(?:\[Y\/n\]|\[y\/N\]|\(y\/n\)|run\s+this\s+command\?|allow\s+this\s+command\?|do\s+you\s+want\s+to\s+proceed\?)\s*$/i;

// Covers ALL Unicode Braille spinner glyphs (U+2801..U+28FF, incl. ⠋..⠏ and ⣟⣯⣷⣾⣽⣻⢿⡿) + active streaming markers
const ACTIVE_TERMINAL_WORK_RE = /(?:[\u2801-\u28FF]\s+\S|esc\s+to\s+interrupt|ctrl\+c\s+to\s+(?:interrupt|stop|cancel)|(?:thinking|reasoning|generating|streaming|searching|evaluating)\.{2,3}|running\s+\d+\s+test|working\s*\(\d+|⏳\s*running|●\s+running\b)/i;
const IDLE_FOOTER_MARKER_RE = /(?:^\?\s*for\s+shortcuts\b|^>\s*accept-edits\s+mode\b|shift\+tab\s+to\s+cycle|bypass\s+permissions\s+on\b|auto-accept\s+edits\s+on\b|enter\s+to\s+send\b.*shortcuts|type\s+your\s+message|ask\s+codex\s+to\s+do\s+anything|ask\s+anything|send\s+a\s+message)/i;
const IDLE_BARE_PROMPT_RE = /^\s*[›❯>]\s*(?:$|try\s+"|\/help\b|accept-edits\b|ask\s+codex\b)/i;
// Bare OS shell prompts (zsh/bash/sh) indicating the AI agent process exited back to shell
const SHELL_EXIT_PROMPT_RE = /^(?:[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\s+\S.*[%$#]|(?:sh|bash|zsh)-\d+\.\d+[$%#]|-[a-zA-Z0-9._-]+\s+\S+\s*[%$#]?|[~\/][^\s]*\s*[%$])\s*$/;

function formatParsedOption(item) {
  const txt = String(item.text || '').replace(/\s+/g, ' ').trim();
  return {
    keyStroke: `${item.num} Enter`,
    badge: String(item.num),
    fullText: txt,
    shortLabel: txt.length > 44 ? txt.slice(0, 42) + '…' : txt,
    isCancel: HITL_CANCEL_OPT_RE.test(txt),
    isPrimary: item.num === 1
  };
}

export function parseInteractivePromptOptions(screenText) {
  if (!screenText || typeof screenText !== 'string') return [];
  const tailLines = screenText.split(/\r?\n/).slice(-64);
  const bottom6 = tailLines.filter(l => l.trim()).slice(-6).join('\n');
  const hasStrongNav = HITL_STRONG_NAV_RE.test(bottom6);

  // 1. Multi-line numbered selector (Codex / Claude Code / Antigravity / Gemini CLI)
  // Collects each numbered option along with up to 2 continuation lines for narrow wrapped panes.
  const candidates = [];
  for (let idx = 0; idx < tailLines.length; idx++) {
    const m = tailLines[idx].match(NUMBERED_OPT_RE);
    if (m) {
      let text = m[2].trim();
      for (let look = 1; look <= 2 && idx + look < tailLines.length; look++) {
        const nextLine = tailLines[idx + look].trim();
        if (!nextLine || NUMBERED_OPT_RE.test(nextLine) || HITL_STRONG_NAV_RE.test(nextLine) || HITL_WEAK_CANCEL_RE.test(nextLine) || /^[─━─-]{4,}$/.test(nextLine)) {
          break;
        }
        if (text.length < 70) {
          text += ' ' + nextLine;
        }
      }
      candidates.push({ num: Number(m[1]), text, lineIdx: idx });
    }
  }

  // 1a. Standard full sequence starting at 1..N
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
      return seq.map(formatParsedOption);
    }
  }

  // 1b. Narrow-pane wrapped fallback: options 1..k-1 scrolled above viewport, leaving consecutive tail k..N
  // (e.g. "3. Yes, and always allow ... (Persist to settings.json)" + "4. No, cancel" above "↑/↓ Navigate · tab Amend")
  if (candidates.length >= 2) {
    const tailSeq = [candidates[candidates.length - 1]];
    for (let i = candidates.length - 2; i >= 0; i--) {
      if (candidates[i].num === tailSeq[0].num - 1) {
        tailSeq.unshift(candidates[i]);
      } else if (candidates[i].num < tailSeq[0].num) {
        break;
      }
    }
    const looksLikeHitlTail = tailSeq.length >= 2 &&
      tailSeq[0].num >= 2 &&
      tailSeq[tailSeq.length - 1].num <= 9 &&
      (hasStrongNav || tailSeq.some(c => HITL_CONFIRM_OPT_RE.test(c.text) || HITL_CANCEL_OPT_RE.test(c.text)));

    if (looksLikeHitlTail) {
      const mapped = tailSeq.map(formatParsedOption);
      if (hasStrongNav) {
        // Prepend direct key [1] shortcut so operator can approve option 1 even when narrow pane scrolled it off top
        mapped.unshift({
          keyStroke: '1 Enter',
          badge: '1',
          fullText: 'Yes, allow once (option 1 above fold)',
          shortLabel: 'Yes, allow once (1)',
          isCancel: false,
          isPrimary: true
        });
      }
      return mapped;
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

/**
 * High-precision detector for an active, blocking interactive confirmation prompt
 * at the bottom of a tmux screen (Antigravity/agy, Claude Code, Codex CLI, Gemini, Pi).
 * Handles narrow split panes where long wrapped commands push options 1..2 above viewport,
 * while strictly rejecting normal markdown lists, stale scrollback, and active spinners with bare "esc to cancel".
 */
export function detectLiveHitlPrompt(screenText) {
  if (!screenText || typeof screenText !== 'string') {
    return { blocked: false, reason: '', options: [] };
  }
  const nonEmpty = screenText.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { blocked: false, reason: '', options: [] };
  }

  const tail = nonEmpty.slice(-48);
  const tailText = tail.join('\n');
  const bottom5 = tail.slice(-5).join('\n');
  const bottom3 = tail.slice(-3).join('\n');

  const options = parseInteractivePromptOptions(tailText);
  const hasStrongNav = HITL_STRONG_NAV_RE.test(bottom5);
  const hasWeakCancel = HITL_WEAK_CANCEL_RE.test(bottom5);
  const hasPromptHeader = HITL_HEADER_RE.test(tail.slice(-32).join('\n'));
  const hasConfirmOpt = options.some(o => HITL_CONFIRM_OPT_RE.test(o.fullText || '') || o.isCancel);

  // Rule 1: Unambiguous interactive dialog footer at bottom of viewport (e.g. "↑/↓ Navigate · tab Amend")
  // Never printed while idle or actively streaming; guarantees detection even on narrow 28-col panes.
  if (hasStrongNav) {
    return {
      blocked: true,
      reason: 'permission_prompt',
      options
    };
  }

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
    if (lastOptionIdx === -1 && /\[[1-9a-zA-Z]\]/.test(bottom5)) {
      lastOptionIdx = tail.length - 1;
    }
  }
  const nearBottom = lastOptionIdx !== -1 && (tail.length - 1 - lastOptionIdx) <= 7;

  if (options.length >= 2 && nearBottom && (hasPromptHeader || hasConfirmOpt || hasWeakCancel)) {
    return {
      blocked: true,
      reason: hasPromptHeader ? 'permission_prompt' : `menu (${options.length} options)`,
      options
    };
  }

  // Reject bare "esc to cancel" when an active braille spinner / streaming marker is at the bottom
  const bottomSpinner = ACTIVE_TERMINAL_WORK_RE.test(tail.slice(-8).join('\n'));
  if (hasPromptHeader && hasWeakCancel && !bottomSpinner) {
    return { blocked: true, reason: 'permission_prompt', options };
  }

  if (HITL_BOTTOM_YN_RE.test(bottom3)) {
    return { blocked: true, reason: 'permission_prompt', options };
  }

  return { blocked: false, reason: '', options: [] };
}

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

/**
 * Unified multi-harness screen state classifier (Antigravity/Gemini CLI, Claude Code, Codex CLI, Pi).
 * Produces one canonical verdict ('needs-input' | 'working' | 'idle' | 'unknown') + detected harness profile.
 */
export function classifyTerminalScreen(screenText, hint = '') {
  const raw = typeof screenText === 'string' ? screenText : '';
  const lowerHint = String(hint || '').toLowerCase();

  let harness = 'generic';
  if (/antigravity cli|accept-edits mode|gemini \d|tab amend/i.test(raw) || lowerHint.includes('agy') || lowerHint === 'terminal') {
    harness = 'antigravity';
  } else if (/ask codex to do anything|tell codex what to do/i.test(raw) || lowerHint.includes('codex')) {
    harness = 'codex';
  } else if (/claude code|bypass permissions|auto-accept edits/i.test(raw) || lowerHint.includes('claude')) {
    harness = 'claude-code';
  } else if (lowerHint.includes('pi')) {
    harness = 'pi';
  }

  const hitl = detectLiveHitlPrompt(raw);
  if (hitl.blocked) {
    return {
      state: 'needs-input',
      harness,
      blocked: true,
      working: false,
      idleAtPrompt: false,
      shellExited: false,
      reason: hitl.reason || 'permission_prompt',
      options: hitl.options || []
    };
  }

  const nonEmpty = raw.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  const tail12Text = nonEmpty.slice(-12).join('\n');
  const bottom4Text = nonEmpty.slice(-4).join('\n');
  const isActivelyWorking = ACTIVE_TERMINAL_WORK_RE.test(tail12Text) || HITL_WEAK_CANCEL_RE.test(bottom4Text);
  if (isActivelyWorking) {
    return {
      state: 'working',
      harness,
      blocked: false,
      working: true,
      idleAtPrompt: false,
      shellExited: false,
      reason: 'active_spinner',
      options: []
    };
  }

  const idleRes = detectTerminalIdleAtPrompt(raw);
  if (idleRes.idle) {
    return {
      state: 'idle',
      harness,
      blocked: false,
      working: false,
      idleAtPrompt: true,
      shellExited: false,
      reason: idleRes.reason || 'idle_at_prompt',
      options: []
    };
  }

  // Detect exited agent sitting at a bare OS shell prompt (zsh %, sh-3.2$, bash-5.2$)
  const bottom3Lines = nonEmpty.slice(-3).map(l => l.trim());
  const lastLine = bottom3Lines[bottom3Lines.length - 1] || '';
  const looksLikeBareShell = lastLine && (
    SHELL_EXIT_PROMPT_RE.test(lastLine) ||
    (lastLine === '%' && bottom3Lines.some(l => /@|\.[a-z]+/i.test(l))) ||
    (/[%$]\s*$/.test(lastLine) && bottom3Lines.some(l => /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+/.test(l)))
  );
  if (looksLikeBareShell) {
    return {
      state: 'shell-exited',
      harness,
      blocked: false,
      working: false,
      idleAtPrompt: false,
      shellExited: true,
      reason: 'shell_exited',
      options: []
    };
  }

  return {
    state: 'unknown',
    harness,
    blocked: false,
    working: false,
    idleAtPrompt: false,
    shellExited: false,
    reason: '',
    options: []
  };
}
