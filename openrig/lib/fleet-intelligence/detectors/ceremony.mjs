/**
 * CeremonyAmplifierDetector: Detects excessive bureaucratic overhead in task handoffs.
 * Separates active slices (p2_medium) from completed retrospective slices (p3_info),
 * deduplicates queue items across activeQueue & recentQueue, caps output to Top-5 slices,
 * and links directly to the interactive Task Gantt instead of fabricated CLI flags.
 */
const MAX_SLICE_FINDINGS = 5;

export class CeremonyAmplifierDetector {
  id = 'workflow.ceremony';
  name = 'Детектор избыточной бюрократии и пинг-понга';

  evaluate({ activeQueue = [], recentQueue = [], healthFindings = [] }) {
    const findings = [];

    // 1. Check for native health detector findings from OpenRig
    for (const h of healthFindings) {
      if (h.detector === 'process.ceremony-amplification' || h.detector?.includes('ceremony')) {
        const qitemId = h.ceremony?.lineageId || (h.evidence?.[0]?.qitemId) || 'qitem';
        const slice = h.ceremony?.slice || '';
        findings.push({
          id: `ceremony-native-${h.id || qitemId}`,
          detectorId: this.id,
          category: 'ceremony',
          severity: 'p2_medium',
          confidence: 0.90,
          title: `🔄 Избыточные переходы в задаче ${qitemId.slice(0, 16)}`,
          summary: `Детектор OpenRig Health зафиксировал ${h.evidence?.length || 'много'} служебных передач для ${qitemId}. Откройте Гант задач, чтобы проверить, на каком узле скапливаются возвраты.`,
          metrics: {
            roiEstimate: 'Сокращение цикла на 15–20 мин',
            riskScore: 58,
            affectedSeats: [],
            affectedSlices: slice ? [slice] : []
          },
          actionPlan: {
            actionId: `gantt-native-${qitemId}`,
            kind: 'open_gantt_slice',
            label: '📊 Разобрать на Ганте',
            commandPreview: '',
            params: { slice, qitemId },
            reversibility: 'fully_reversible',
            safetyLevel: 'safe_auto'
          },
          detectedAt: new Date().toISOString()
        });
      }
    }

    // 2. Deduplicate activeQueue + recentQueue by qitemId/id and separate active vs historical slices
    const activeSliceSet = new Set();
    const seenIds = new Set();
    const sliceHops = new Map();

    const extractSlice = (t) => {
      if (!t) return '';
      if (Array.isArray(t.tags)) {
        const found = t.tags.find(tag => typeof tag === 'string' && tag.startsWith('slice:'));
        if (found) return found.slice('slice:'.length);
      }
      if (typeof t.slice === 'string' && t.slice) return t.slice;
      if (typeof t.chain === 'string' && t.chain.startsWith('slice:')) return t.chain.slice('slice:'.length);
      return '';
    };

    for (const t of activeQueue) {
      const slice = extractSlice(t);
      if (!slice) continue;
      if (t.state !== 'done' && t.state !== 'terminal') {
        activeSliceSet.add(slice);
      }
      const key = t.qitemId || t.id;
      if (key) {
        if (seenIds.has(key)) continue;
        seenIds.add(key);
      }
      sliceHops.set(slice, (sliceHops.get(slice) || 0) + 1);
    }

    for (const t of recentQueue) {
      const slice = extractSlice(t);
      if (!slice) continue;
      const key = t.qitemId || t.id;
      if (key) {
        if (seenIds.has(key)) continue;
        seenIds.add(key);
      }
      sliceHops.set(slice, (sliceHops.get(slice) || 0) + 1);
    }

    const candidates = Array.from(sliceHops.entries())
      .filter(([, hops]) => hops >= 8)
      .map(([slice, hops]) => ({
        slice,
        hops,
        isActive: activeSliceSet.has(slice)
      }))
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.hops - a.hops;
      });

    const topCandidates = candidates.slice(0, MAX_SLICE_FINDINGS);
    const hiddenCount = Math.max(0, candidates.length - topCandidates.length);

    for (let idx = 0; idx < topCandidates.length; idx++) {
      const { slice, hops, isActive } = topCandidates[idx];
      const extraNote = (idx === 0 && hiddenCount > 0)
        ? ` (показаны топ-${MAX_SLICE_FINDINGS} из ${candidates.length} слайсов по числу переходов)`
        : '';

      findings.push({
        id: `ceremony-hops-${slice}`,
        detectorId: this.id,
        category: 'ceremony',
        severity: isActive ? 'p2_medium' : 'p3_info',
        confidence: isActive ? 0.85 : 0.78,
        title: isActive
          ? `🔄 Активный слайс ${slice}: ${hops} переходов очереди`
          : `📊 Ретроспектива слайса ${slice}: ${hops} переходов`,
        summary: isActive
          ? `Активный слайс ${slice} уже прошёл ${hops} передач между агентами${extraNote}. Откройте его на Ганте задач, чтобы увидеть, где копятся возвраты QA или простои ожидания, и при необходимости закрепите прямой handoff в AGENTS.md.`
          : `Завершённый слайс ${slice} в истории потребовал ${hops} передач очереди${extraNote}. Это не авария, а ориентир для оптимизации: откройте цепочку на Ганте, чтобы найти повторяющиеся круги доработки.`,
        metrics: {
          roiEstimate: isActive ? 'Ускорение сдачи слайса' : 'Ретро-инсайт процесса',
          riskScore: isActive ? Math.min(72, 50 + hops) : Math.min(45, 20 + Math.round(hops / 2)),
          affectedSeats: [],
          affectedSlices: [slice]
        },
        actionPlan: {
          actionId: `gantt-slice-${slice}`,
          kind: 'open_gantt_slice',
          label: '📊 Разобрать на Ганте',
          commandPreview: '',
          params: { slice },
          reversibility: 'fully_reversible',
          safetyLevel: 'safe_auto'
        },
        detectedAt: new Date().toISOString()
      });
    }

    return findings;
  }
}
