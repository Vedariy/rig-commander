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
