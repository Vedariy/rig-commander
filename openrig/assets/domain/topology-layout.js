/**
 * Adaptive & Fixed Topology Graph Layout Engine (Pure Domain Module).
 *
 * Supports two operator-selectable modes:
 *   - 'dynamic' (Active Stage + Compact Dormant Bench):
 *       Working, urgent, and actively communicating nodes are distributed evenly
 *       across the upper stage with pixel-aware collision & edge-badge clearance,
 *       while dormant/non-communicating nodes dock compactly at the bottom bench.
 *   - 'fixed' (Stable Role-Tiered Coordinates):
 *       Every node keeps a deterministic role-tiered seat invariant to idle/working
 *       state transitions, while preserving pixel-aware collision-free spacing.
 *
 * Zero DOM dependencies — 100% deterministic & unit-testable.
 */

export const GRAPH_LAYOUT_MODES = Object.freeze(['dynamic', 'fixed']);

const DEFAULT_CANVAS_W = 900;
const DEFAULT_CANVAS_H = 460;

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function isEdgeActiveForLayout(edge, visibleIds) {
  if (!edge || !edge.from || !edge.to || edge.from === edge.to) return false;
  if (visibleIds && (!visibleIds.has(edge.from) || !visibleIds.has(edge.to))) return false;
  const status = String(edge.queueStatus || (edge.liveActive ? 'live' : 'ghost')).toLowerCase();
  return status !== 'ghost';
}

/**
 * Classifies visible agents into 'active' (working, urgent, connected to any
 * visible active/queued highway, or recently active within hysteresis window)
 * vs 'dormant' (idle or parked/shell without active graph exchanges).
 */
export function classifyNodeActivityTier(agents = [], edges = [], { recentActiveIds = null, useHysteresis = false } = {}) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const visibleIds = new Set(list.map(a => a.id));
  const recentSet = recentActiveIds instanceof Set
    ? recentActiveIds
    : new Set(Array.isArray(recentActiveIds) ? recentActiveIds : []);

  const activeEndpoints = new Set();
  const activeEdges = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (isEdgeActiveForLayout(edge, visibleIds)) {
      activeEdges.push(edge);
      activeEndpoints.add(edge.from);
      activeEndpoints.add(edge.to);
    }
  }

  const tiers = {};
  const activeNodes = [];
  const dormantNodes = [];

  for (const agent of list) {
    const state = String(agent.state || 'idle').toLowerCase();
    const isDirectlyActive = state === 'working' || state === 'urgent' || activeEndpoints.has(agent.id);
    const isHeldByHysteresis = Boolean(useHysteresis && recentSet.has(agent.id));
    if (isDirectlyActive || isHeldByHysteresis) {
      tiers[agent.id] = 'active';
      activeNodes.push(agent);
    } else {
      tiers[agent.id] = 'dormant';
      dormantNodes.push(agent);
    }
  }

  return { tiers, activeNodes, dormantNodes, activeEdges };
}

/**
 * Semantic role tier for deterministic top-to-bottom hierarchy:
 *   0 = Command / Orchestration / Architecture (owner, senior/architect, operator, advisor)
 *   1 = Builders / Coders / Generic agents
 *   2 = Verification / QA (check, qa)
 */
export function getRolePlacementInfo(agent) {
  const id = String((agent && agent.id) || '').toLowerCase();
  const seat = id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id;

  if (/(check|qa|verif|audit)/i.test(seat)) {
    return { bucket: 2, subRank: 0, seat };
  }
  if (/owner|lead/i.test(seat) && !/advisor/i.test(seat)) {
    return { bucket: 0, subRank: 1, seat };
  }
  if (/senior|architect/i.test(seat)) {
    return { bucket: 0, subRank: 2, seat };
  }
  if (/advisor/i.test(seat)) {
    return { bucket: 0, subRank: 3, seat };
  }
  if (/operator|guardian/i.test(seat)) {
    const isKernel = id.endsWith('@kernel');
    return { bucket: 0, subRank: isKernel ? 0 : 4, seat };
  }
  if (/coder|worker/i.test(seat)) {
    return { bucket: 1, subRank: 0, seat };
  }
  return { bucket: 1, subRank: 5, seat };
}

function sortAgentsDeterministically(list) {
  return [...list].sort((a, b) => {
    const ra = getRolePlacementInfo(a);
    const rb = getRolePlacementInfo(b);
    if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
    if (ra.subRank !== rb.subRank) return ra.subRank - rb.subRank;
    return naturalCompare(a.id, b.id);
  });
}

function getAgentLabelLength(agent) {
  const title = String((agent && (agent.displayTitle || agent.shortName || agent.id)) || '');
  return Math.max(4, title.length);
}

/**
 * Estimates pixel bounding box of a node card for collision & row packing.
 */
export function estimateNodeBox(agent, tier = 'active', { detailed = false } = {}) {
  if (detailed) {
    return { width: 238, height: 116, topExtra: 26 };
  }
  const titleLen = getAgentLabelLength(agent);
  const hasPct = typeof (agent && agent.ctxPct) === 'number' && Number.isFinite(agent.ctxPct);
  const isWaiting = String((agent && agent.state) || '').toLowerCase() === 'waiting';

  if (tier === 'dormant') {
    const flagW = isWaiting ? 42 : 0;
    const pctW = hasPct ? 36 : 0;
    const width = Math.max(76, Math.ceil(20 + titleLen * 6.6 + pctW + flagW));
    return { width, height: 28, topExtra: 6 };
  }

  const hasTokens = hasPct && agent && typeof agent.ctxWindowSize === 'number' && agent.ctxWindowSize > 0;
  const hasCalls = Boolean(agent && ((Number(agent.callsIn) || 0) > 0 || (Number(agent.callsOut) || 0) > 0));
  const pctW = hasPct ? ((agent.ctxPct >= 65) ? 52 : 42) : 0;
  const row1W = 24 + titleLen * 7.5 + pctW;
  const row2W = 24 + (hasTokens ? 74 : 0) + (hasCalls ? 66 : 0) + (hasTokens && hasCalls ? 14 : 0);
  const width = Math.max(158, Math.ceil(Math.max(row1W, row2W)));
  const height = (hasTokens || hasCalls) ? 54 : 38;
  return { width, height, topExtra: 28 };
}

function resolveBox(agent, tier, { detailed = false, measuredBoxes = null } = {}) {
  const m = measuredBoxes && agent && measuredBoxes[agent.id];
  if (
    m &&
    typeof m.width === 'number' && m.width > 30 &&
    typeof m.height === 'number' && m.height > 16 &&
    m.tier === tier &&
    Boolean(m.detailed) === Boolean(detailed)
  ) {
    return {
      width: m.width,
      height: m.height,
      topExtra: detailed ? 26 : (tier === 'dormant' ? 6 : 28)
    };
  }
  return estimateNodeBox(agent, tier, { detailed });
}

function intersectRectBorderDist(hw, hh, ux, uy) {
  const tx = Math.abs(ux) > 1e-5 ? hw / Math.abs(ux) : 1e9;
  const ty = Math.abs(uy) > 1e-5 ? hh / Math.abs(uy) : 1e9;
  return Math.min(tx, ty);
}

function distributeRowX(items, cw, padX) {
  const n = items.length;
  if (n === 0) return [];
  if (n === 1) return [cw / 2];

  const totalCardW = items.reduce((sum, it) => sum + it.box.width, 0);
  const minSpanLeft = padX + items[0].box.width / 2;
  const maxSpanRight = cw - padX - items[n - 1].box.width / 2;

  if (maxSpanRight <= minSpanLeft) {
    return items.map((_, i) => cw * (0.16 + (0.68 * i) / Math.max(1, n - 1)));
  }

  const usableSpan = cw - padX * 2;
  const freeGap = usableSpan - totalCardW;
  if (freeGap >= (n - 1) * 14) {
    // Generous inner gaps between cards while keeping clean outer margins
    const edgeFactor = n === 2 ? 0.48 : (n === 3 ? 0.12 : 0.10);
    const stepGap = freeGap / ((n - 1) + edgeFactor * 2);
    const out = [];
    let cursor = padX + stepGap * edgeFactor;
    for (let i = 0; i < n; i++) {
      out.push(cursor + items[i].box.width / 2);
      cursor += items[i].box.width + stepGap;
    }
    return out;
  }

  // Tight canvas fallback: spread centers evenly from minSpanLeft to maxSpanRight
  return items.map((_, i) => minSpanLeft + ((maxSpanRight - minSpanLeft) * i) / (n - 1));
}

function splitIntoBalancedRows(items, usableW, minGap = 12, maxPerRowCap = 8) {
  if (items.length === 0) return [];
  const totalW = items.reduce((s, it) => s + it.box.width, 0) + Math.max(0, items.length - 1) * minGap;
  if (totalW <= usableW && items.length <= maxPerRowCap) {
    return [items];
  }

  let rowCount = Math.max(2, Math.ceil(totalW / Math.max(160, usableW)));
  rowCount = Math.min(items.length, Math.max(rowCount, Math.ceil(items.length / maxPerRowCap)));

  for (let tries = 0; tries < 6; tries++) {
    const rows = [];
    const baseSize = Math.floor(items.length / rowCount);
    let extra = items.length % rowCount;
    let idx = 0;
    let overflow = false;
    for (let r = 0; r < rowCount; r++) {
      const sz = baseSize + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const slice = items.slice(idx, idx + sz);
      idx += sz;
      const rw = slice.reduce((s, it) => s + it.box.width, 0) + Math.max(0, slice.length - 1) * minGap;
      if (rw > usableW && slice.length > 1) overflow = true;
      rows.push(slice);
    }
    if (!overflow || rowCount >= items.length) {
      return rows;
    }
    rowCount++;
  }
  return [items];
}

function clampItem(it, cw, minY, maxY, padX = 12) {
  const hw = it.box.width / 2;
  const hh = it.box.height / 2;
  const loX = Math.min(cw / 2, hw + padX);
  const hiX = Math.max(cw / 2, cw - hw - padX);
  const loY = Math.min(maxY, Math.max(minY, hh + (it.box.topExtra || 8)));
  const hiY = Math.max(loY, maxY - hh);
  it.px = Math.max(loX, Math.min(hiX, it.px));
  it.py = Math.max(loY, Math.min(hiY, it.py));
}

function relaxStageItems(items, activeEdges, cw, stageTopY, stageBottomY, {
  gapX = 42,
  gapY = 40,
  edgeClearanceTarget = 148,
  iterations = 36
} = {}) {
  if (items.length <= 1) {
    if (items.length === 1) clampItem(items[0], cw, stageTopY, stageBottomY, 14);
    return;
  }

  const byId = new Map(items.map(it => [it.agent.id, it]));
  const internalEdges = (activeEdges || []).filter(e => byId.has(e.from) && byId.has(e.to));

  for (let iter = 0; iter < iterations; iter++) {
    const damping = 0.42 * (1 - iter / (iterations * 1.45));

    // 1. Pairwise non-overlap repulsion (exact pixel boxes + status-led clearance)
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        let dx = b.px - a.px;
        let dy = b.py - a.py;
        const reqX = (a.box.width + b.box.width) / 2 + gapX;
        const reqY = (a.box.height + b.box.height) / 2 + gapY;
        const ovX = reqX - Math.abs(dx);
        const ovY = reqY - Math.abs(dy);

        if (ovX > 0 && ovY > 0) {
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            dx = (i % 2 === 0 ? 1 : -1) * 4;
            dy = 2;
          }
          // Prefer separating along the axis that needs less push, with slight X bias
          if (ovX <= ovY * 1.18) {
            const dir = dx >= 0 ? 1 : -1;
            const shift = ovX * 0.52 * damping;
            a.px -= dir * shift;
            b.px += dir * shift;
          } else {
            const dir = dy >= 0 ? 1 : -1;
            const shift = ovY * 0.52 * damping;
            a.py -= dir * shift;
            b.py += dir * shift;
          }
        }
      }
    }

    // 2. Active-edge breathing room so animated arrows & slice badges never collide with cards
    for (const edge of internalEdges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      let dx = b.px - a.px;
      let dy = b.py - a.py;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) {
        dx = 1;
        dy = 0;
        dist = 1;
      }
      const ux = dx / dist;
      const uy = dy / dist;
      const dA = intersectRectBorderDist(a.box.width / 2, a.box.height / 2, ux, uy);
      const dB = intersectRectBorderDist(b.box.width / 2, b.box.height / 2, -ux, -uy);
      const clearGap = dist - dA - dB;

      const sliceTextLen = String(edge.slice && edge.slice !== 'all' ? edge.slice : 'Active').length + 3;
      const badgeEstW = Math.max(84, sliceTextLen * 7.2 + 20);
      const maxFeasibleGap = Math.max(80, Math.min(edgeClearanceTarget, cw * 0.24));
      const desiredGap = Math.min(maxFeasibleGap, Math.max(108, badgeEstW + 36));

      if (clearGap < desiredGap) {
        const push = (desiredGap - clearGap) * 0.45 * damping;
        a.px -= ux * push;
        a.py -= uy * push;
        b.px += ux * push;
        b.py += uy * push;
      }

      // 3. Keep unrelated active nodes clear of the entire edge segment (not just midpoint)
      for (const c of items) {
        if (c === a || c === b) continue;
        const proj = (c.px - a.px) * ux + (c.py - a.py) * uy;
        const t = proj / Math.max(1, dist);
        if (t < 0.12 || t > 0.88) continue;
        const cx = a.px + ux * proj;
        const cy = a.py + uy * proj;
        const mdx = c.px - cx;
        const mdy = c.py - cy;
        const isNearMid = Math.abs(t - 0.5) < 0.24;
        const clearX = c.box.width / 2 + (isNearMid ? badgeEstW / 2 : 16) + 12;
        const clearY = c.box.height / 2 + (isNearMid ? 20 : 14);
        if (Math.abs(mdx) < clearX && Math.abs(mdy) < clearY) {
          // Nudge perpendicular to edge (u, v) away from the segment
          let nx = -uy;
          let ny = ux;
          if (nx * mdx + ny * mdy < 0) {
            nx = -nx;
            ny = -ny;
          }
          if (Math.abs(mdx) < 1 && Math.abs(mdy) < 1) {
            // Exactly collinear: deterministic push away from vertical center
            nx = -uy;
            ny = ux >= 0 ? Math.abs(ux) : -Math.abs(ux);
            if (Math.abs(ny) < 0.1) ny = 1;
          }
          const nudge = Math.min(clearX - Math.abs(mdx), clearY - Math.abs(mdy)) * 0.52 * damping;
          c.px += nx * nudge;
          c.py += ny * nudge;
        }
      }
    }

    for (const it of items) {
      clampItem(it, cw, stageTopY, stageBottomY, 14);
    }
  }
}

/**
 * Prevents 3+ nodes across distinct vertical rows from stacking on a single
 * vertical center line (e.g. [1,1,1] Owner/Coder/QA or [1,3,1] Owner/3 Coders/QA),
 * where a top-to-bottom structural edge would slice straight through a middle card.
 */
function breakVerticalCenterCollinearity(rows, cw, minY, maxY) {
  if (!Array.isArray(rows) || rows.length < 3) return;
  const centerX = cw / 2;
  const tolX = Math.max(20, cw * 0.045);

  const centerRows = [];
  rows.forEach((row, rIdx) => {
    if (row.some(it => Math.abs(it.px - centerX) <= tolX)) {
      centerRows.push(rIdx);
    }
  });
  if (centerRows.length < 3) return;

  const allSingle = rows.every(r => r.length === 1);
  if (allSingle) {
    // Keep row 0 as the top Command apex at center, stagger lower tiers left/right
    // into a balanced wide triangle/zig-zag so all 3 structural edges stay unobstructed.
    rows.forEach((row, rIdx) => {
      if (rIdx === 0) {
        row[0].px = cw * 0.5;
      } else {
        row[0].px = rIdx % 2 === 1 ? cw * 0.26 : cw * 0.74;
      }
      clampItem(row[0], cw, minY, maxY, 14);
    });
    return;
  }

  // Mixed rows (e.g. [1, 3, 1]): offset lower single-node rows off the center pole
  // so top-to-bottom routes pass through the open corridor between middle cards.
  let sideToggle = 0;
  for (const rIdx of centerRows) {
    if (rIdx === 0) continue;
    const row = rows[rIdx];
    if (row.length === 1) {
      row[0].px = sideToggle % 2 === 0 ? cw * 0.74 : cw * 0.26;
      sideToggle++;
      clampItem(row[0], cw, minY, maxY, 14);
    }
  }
}

function layoutFixedRoleGrid(agents, tiers, cw, ch, { detailed = false, measuredBoxes = null, useActiveSizing = true } = {}) {
  const sorted = sortAgentsDeterministically(agents);
  const items = sorted.map(agent => {
    const boxTier = useActiveSizing ? 'active' : (tiers[agent.id] || 'dormant');
    const box = resolveBox(agent, boxTier, { detailed, measuredBoxes: useActiveSizing ? null : measuredBoxes });
    const role = getRolePlacementInfo(agent);
    return { agent, role, box, px: cw / 2, py: ch / 2 };
  });

  // Group into non-empty role buckets: 0 (Command/Arch), 1 (Coders/Generic), 2 (QA)
  const bucketMap = new Map([[0, []], [1, []], [2, []]]);
  for (const it of items) {
    bucketMap.get(it.role.bucket).push(it);
  }

  const usableW = Math.max(240, cw - 28);
  const allRows = [];
  for (const bucketId of [0, 1, 2]) {
    const group = bucketMap.get(bucketId);
    if (!group || group.length === 0) continue;
    const maxPerRow = bucketId === 1 ? 4 : 5;
    const rows = splitIntoBalancedRows(group, usableW, 18, maxPerRow);
    for (const r of rows) allRows.push(r);
  }

  const topPad = detailed ? 74 : 52;
  const bottomPad = detailed ? 68 : 38;
  const rowCount = allRows.length;
  const rowPitch = rowCount > 1 ? (ch - topPad - bottomPad) / (rowCount - 1) : ch * 0.55;

  allRows.forEach((row, rIdx) => {
    const py = rowCount === 1
      ? ch * 0.46
      : topPad + ((ch - topPad - bottomPad) * rIdx) / Math.max(1, rowCount - 1);
    const xs = distributeRowX(row, cw, 14);
    const maxRowH = Math.max(...row.map(it => it.box.height));
    const staggerRoom = rowPitch - maxRowH - 22;
    const stagger = (row.length >= 3 && staggerRoom > 16)
      ? Math.min(22, Math.max(10, staggerRoom * 0.22))
      : 0;
    row.forEach((it, idx) => {
      it.px = xs[idx];
      if (stagger > 0 && row.length === 3) {
        // Keep apex inside top/bottom bounds instead of clipping against ceiling/floor
        if (rIdx === 0) {
          it.py = idx === 1 ? py : py + stagger * 1.35;
        } else if (rIdx === rowCount - 1 && rowCount > 1) {
          it.py = idx === 1 ? py : py - stagger * 1.35;
        } else {
          it.py = py + (idx === 1 ? -stagger : stagger * 0.75);
        }
      } else if (stagger > 0) {
        it.py = py + (idx % 2 === 0 ? -stagger : stagger);
      } else {
        it.py = py;
      }
      clampItem(it, cw, topPad - 10, ch - 18, 14);
    });
  });

  breakVerticalCenterCollinearity(allRows, cw, topPad - 10, ch - 18);

  // Run collision-only relaxation (no edge forces in fixed mode -> invariant to queue/status changes!)
  relaxStageItems(items, [], cw, topPad - 10, ch - 18, {
    gapX: detailed ? 14 : 20,
    gapY: detailed ? 18 : 26,
    edgeClearanceTarget: 0,
    iterations: 22
  });

  return items;
}

function layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, { detailed = false, measuredBoxes = null } = {}) {
  const sorted = sortAgentsDeterministically(activeNodes);
  const items = sorted.map(agent => ({
    agent,
    role: getRolePlacementInfo(agent),
    box: resolveBox(agent, 'active', { detailed, measuredBoxes }),
    px: cw / 2,
    py: (stageTopY + stageBottomY) / 2
  }));

  const k = items.length;
  const spanY = Math.max(60, stageBottomY - stageTopY);
  const middleArches = [];

  // Degree count across active edges for smart hub ordering
  const degree = new Map(items.map(it => [it.agent.id, 0]));
  const neighbors = new Map(items.map(it => [it.agent.id, new Set()]));
  for (const e of activeEdges) {
    if (degree.has(e.from) && degree.has(e.to)) {
      degree.set(e.from, degree.get(e.from) + 1);
      degree.set(e.to, degree.get(e.to) + 1);
      neighbors.get(e.from).add(e.to);
      neighbors.get(e.to).add(e.from);
    }
  }

  if (k === 1) {
    items[0].px = cw * 0.5;
    items[0].py = stageTopY + spanY * 0.48;
  } else if (k === 2) {
    // Orient primary flow left -> right (or top -> bottom inside narrow cluster columns)
    const direct = activeEdges.find(e =>
      (e.from === items[0].agent.id && e.to === items[1].agent.id) ||
      (e.from === items[1].agent.id && e.to === items[0].agent.id)
    );
    let ordered = items;
    if (direct && direct.from === items[1].agent.id && items[0].role.bucket === items[1].role.bucket) {
      ordered = [items[1], items[0]];
    }
    const pairCardW = ordered[0].box.width + ordered[1].box.width;
    const needsVerticalStack =
      (cw - pairCardW) < (detailed ? 110 : 140) &&
      spanY >= (ordered[0].box.height + ordered[1].box.height + 110);
    if (needsVerticalStack) {
      // Narrow cluster columns: stack source -> target vertically so edge badges
      // and expanded selected cards never collide horizontally.
      if (direct && direct.from === ordered[1].agent.id) {
        ordered = [ordered[1], ordered[0]];
      }
      ordered[0].px = cw * 0.5;
      ordered[1].px = cw * 0.5;
      ordered[0].py = stageTopY + spanY * 0.22;
      ordered[1].py = stageTopY + spanY * 0.78;
    } else {
      const xs = distributeRowX(ordered, cw, Math.max(20, cw * 0.08));
      ordered[0].px = xs[0];
      ordered[1].px = xs[1];
      ordered[0].py = stageTopY + spanY * 0.48;
      ordered[1].py = stageTopY + spanY * 0.48;
    }
  } else if (k === 3) {
    const byBucket = new Map([[0, []], [1, []], [2, []]]);
    for (const it of items) byBucket.get(it.role.bucket).push(it);
    const occupied = [0, 1, 2].map(b => byBucket.get(b)).filter(g => g.length > 0);

    if (occupied.length === 2 && occupied[0].length === 2 && occupied[1].length === 1) {
      // Classic 2-top + 1-bottom wide inverted triangle (e.g. Owner + Architect + QA)
      const topXs = distributeRowX(occupied[0], cw, Math.max(24, cw * 0.07));
      occupied[0][0].px = topXs[0];
      occupied[0][0].py = stageTopY + spanY * 0.22;
      occupied[0][1].px = topXs[1];
      occupied[0][1].py = stageTopY + spanY * 0.22;
      occupied[1][0].px = cw * 0.5;
      occupied[1][0].py = stageTopY + spanY * 0.84;
    } else if (occupied.length === 2 && occupied[0].length === 1 && occupied[1].length === 2) {
      // 1-top + 2-bottom wide apex triangle (e.g. Owner + 2 Coders)
      occupied[0][0].px = cw * 0.5;
      occupied[0][0].py = stageTopY + spanY * 0.18;
      const botXs = distributeRowX(occupied[1], cw, Math.max(24, cw * 0.07));
      occupied[1][0].px = botXs[0];
      occupied[1][0].py = stageTopY + spanY * 0.84;
      occupied[1][1].px = botXs[1];
      occupied[1][1].py = stageTopY + spanY * 0.84;
    } else if (occupied.length === 3) {
      // 3 distinct tiers (e.g. Owner -> Coder -> QA): wide Command-apex triangle
      // aligned with fixed/idle fallback so waking up never jars the graph.
      occupied[0][0].px = cw * 0.5;
      occupied[0][0].py = stageTopY + spanY * 0.16;
      occupied[1][0].px = cw * 0.26;
      occupied[1][0].py = stageTopY + spanY * 0.56;
      occupied[2][0].px = cw * 0.74;
      occupied[2][0].py = stageTopY + spanY * 0.86;
    } else {
      // All 3 in same tier: place highest-degree hub at top center, others below left/right
      const hubFirst = [...items].sort((a, b) =>
        (degree.get(b.agent.id) - degree.get(a.agent.id)) || naturalCompare(a.agent.id, b.agent.id)
      );
      hubFirst[0].px = cw * 0.5;
      hubFirst[0].py = stageTopY + spanY * 0.2;
      const botXs = distributeRowX([hubFirst[1], hubFirst[2]], cw, Math.max(24, cw * 0.07));
      hubFirst[1].px = botXs[0];
      hubFirst[1].py = stageTopY + spanY * 0.82;
      hubFirst[2].px = botXs[1];
      hubFirst[2].py = stageTopY + spanY * 0.82;
    }
  } else {
    // 4+ active nodes: collapse empty role buckets & balance wide rows + 1-pass barycenter ordering
    const usableW = Math.max(240, cw - 36);
    const rows = [];
    for (const bucketId of [0, 1, 2]) {
      const group = items.filter(it => it.role.bucket === bucketId);
      if (group.length === 0) continue;
      const subRows = splitIntoBalancedRows(group, usableW, 24, 4);
      for (const sr of subRows) rows.push(sr);
    }

    // If everything landed in 1 bucket with >= 4 items and only 1 row, split into 2 airy rows
    if (rows.length === 1 && rows[0].length >= 4) {
      const half = Math.ceil(rows[0].length / 2);
      const orig = rows[0];
      rows.splice(0, 1, orig.slice(0, half), orig.slice(half));
    }

    const rCount = rows.length;
    const topFrac = rCount === 2 && rows[0].length >= 3 ? 0.26 : 0.14;
    const botFrac = 0.88;
    const rowPitch = rCount > 1 ? (spanY * (botFrac - topFrac)) / (rCount - 1) : spanY * 0.65;

    rows.forEach((row, rIdx) => {
      // For a 3-node row, center the highest-degree hub (or owner/lead) so edges fan out symmetrically
      if (row.length === 3) {
        let hubIdx = 1;
        let bestScore = -1;
        row.forEach((it, idx) => {
          const deg = degree.get(it.agent.id) || 0;
          const isOwner = it.role.bucket === 0 && it.role.subRank === 1 ? 0.5 : 0;
          const score = deg + isOwner;
          if (score > bestScore) {
            bestScore = score;
            hubIdx = idx;
          }
        });
        if (hubIdx !== 1) {
          const hub = row[hubIdx];
          const others = row.filter((_, idx) => idx !== hubIdx);
          row.splice(0, 3, others[0], hub, others[1]);
        }
      }

      const frac = rCount === 1 ? 0.48 : (topFrac + ((botFrac - topFrac) * rIdx) / Math.max(1, rCount - 1));
      const py = stageTopY + spanY * frac;
      const xs = distributeRowX(row, cw, 20);
      const maxRowH = Math.max(...row.map(it => it.box.height));
      const freeY = rowPitch - maxRowH - 18;
      // Anti-collinear arch / stagger: 3+ nodes in one row NEVER sit on a flat horizontal line
      const archDelta = (row.length === 3 && freeY > 14)
        ? Math.min(54, Math.max(18, freeY * 0.38))
        : 0;
      const waveDelta = (row.length >= 4 && freeY > 14)
        ? Math.min(34, Math.max(14, freeY * 0.24))
        : 0;
      if (archDelta > 0 && rIdx > 0 && rIdx < rCount - 1) middleArches.push(row);

      row.forEach((it, idx) => {
        it.px = xs[idx];
        if (archDelta > 0) {
          // Top row forms a crisp diamond apex (^), bottom row forms a bowl (v)
          const isBottomRow = rCount > 1 && rIdx === rCount - 1;
          const centerSign = isBottomRow ? 1 : -1;
          it.py = py + (idx === 1 ? centerSign * archDelta : -centerSign * archDelta);
        } else if (waveDelta > 0) {
          it.py = py + (idx % 2 === 0 ? -waveDelta : waveDelta);
        } else {
          it.py = py;
        }
        clampItem(it, cw, stageTopY, stageBottomY, 14);
      });
    });

    // 1-pass barycenter horizontal reorder to minimize crossing highways (preserving anti-collinear stagger)
    const byId = new Map(items.map(it => [it.agent.id, it]));
    for (let rIdx = 1; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (row.length < 2) continue;
      // The arch belongs to horizontal slots, not to the agents being reordered.
      const slotY = middleArches.includes(row) ? row.map(it => it.py) : null;
      row.sort((a, b) => {
        const bary = (it) => {
          const nbs = [...(neighbors.get(it.agent.id) || [])].map(id => byId.get(id)).filter(Boolean);
          if (nbs.length === 0) return it.px;
          return nbs.reduce((s, n) => s + n.px, 0) / nbs.length;
        };
        const diff = bary(a) - bary(b);
        return Math.abs(diff) > 1 ? diff : naturalCompare(a.agent.id, b.agent.id);
      });
      const xs = distributeRowX(row, cw, 20);
      row.forEach((it, idx) => { it.px = xs[idx]; if (slotY) it.py = slotY[idx]; });
    }
    breakVerticalCenterCollinearity(rows, cw, stageTopY, stageBottomY);
  }

  relaxStageItems(items, activeEdges, cw, stageTopY, stageBottomY, {
    gapX: detailed ? 18 : 42,
    gapY: detailed ? 22 : 42,
    edgeClearanceTarget: detailed ? 110 : 155,
    iterations: 38
  });

  // Edge-clearance forces may lift a lateral card; retain the middle-row apex
  // after relaxation as well as after barycenter ordering.
  for (const row of middleArches) {
    const [left, center, right] = [...row].sort((a, b) => a.px - b.px);
    center.py = Math.min(center.py, Math.min(left.py, right.py) - 18);
    clampItem(center, cw, stageTopY, stageBottomY, 14);
  }

  return items;
}

function rigIdOf(agent) {
  const id = String(agent.id || '');
  return id.includes('@') ? id.slice(id.lastIndexOf('@') + 1) : 'local';
}

function estimateEdgeBadgeWidthPx(edge) {
  const slice = String((edge && edge.slice) || '').trim();
  if (!slice) return 52;
  return Math.min(168, Math.max(76, slice.length * 7.2 + 34));
}

function segmentIntersectsPaddedBox(x1, y1, x2, y2, cx, cy, halfW, halfH) {
  const minX = cx - halfW, maxX = cx + halfW;
  const minY = cy - halfH, maxY = cy + halfH;
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const clips = [
    [-dx, x1 - minX],
    [dx, maxX - x1],
    [-dy, y1 - minY],
    [dy, maxY - y1]
  ];
  for (const [p, q] of clips) {
    if (Math.abs(p) < 1e-6) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 >= t0;
}

function intersectRectBorder(cx, cy, hw, hh, vx, vy, pad) {
  const w = hw + pad;
  const h = hh + pad;
  const tx = Math.abs(vx) > 1e-5 ? w / Math.abs(vx) : 1e9;
  const ty = Math.abs(vy) > 1e-5 ? h / Math.abs(vy) : 1e9;
  const t = Math.min(tx, ty);
  return { x: cx + vx * t, y: cy + vy * t };
}

/**
 * Computes an adaptive SVG edge path (strict straight line on clean horizontal/vertical axes,
 * orthogonal-tangent cubic Bezier S-curve on active diagonals, normal-vector detour around
 * third-party obstacle cards, and symmetric dual-lane offset for bidirectional A <-> B edges),
 * plus the exact on-curve label anchor B(0.5).
 */
export function computeAdaptiveEdgePath({
  cx1, cy1, sz1 = { hw: 100, hh: 32 },
  cx2, cy2, sz2 = { hw: 100, hh: 32 },
  obstacles = [],
  parallelIndex = 0,
  isGhost = false,
  padStart = 2,
  padEnd = 4
} = {}) {
  const dx = cx2 - cx1;
  const dy = cy2 - cy1;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < 1e-3) {
    return {
      pathD: `M ${Number(cx1 || 0).toFixed(1)} ${Number(cy1 || 0).toFixed(1)} L ${Number(cx2 || 0).toFixed(1)} ${Number(cy2 || 0).toFixed(1)}`,
      p1: { x: cx1 || 0, y: cy1 || 0 },
      p2: { x: cx2 || 0, y: cy2 || 0 },
      mx: cx1 || 0,
      my: cy1 || 0,
      curved: false,
      kind: 'straight'
    };
  }

  const p1Straight = intersectRectBorder(cx1, cy1, sz1.hw, sz1.hh, dx, dy, padStart);
  const p2Straight = intersectRectBorder(cx2, cy2, sz2.hw, sz2.hh, -dx, -dy, padEnd);
  const straightResult = () => ({
    pathD: `M ${p1Straight.x.toFixed(1)} ${p1Straight.y.toFixed(1)} L ${p2Straight.x.toFixed(1)} ${p2Straight.y.toFixed(1)}`,
    p1: p1Straight,
    p2: p2Straight,
    mx: (p1Straight.x + p2Straight.x) / 2,
    my: (p1Straight.y + p2Straight.y) / 2,
    curved: false,
    kind: 'straight'
  });

  const blocking = [];
  if (Array.isArray(obstacles) && obstacles.length > 0) {
    for (const o of obstacles) {
      if (!o || !Number.isFinite(o.cx) || !Number.isFinite(o.cy)) continue;
      if (segmentIntersectsPaddedBox(p1Straight.x, p1Straight.y, p2Straight.x, p2Straight.y, o.cx, o.cy, (o.hw || 80) + 8, (o.hh || 24) + 8)) {
        blocking.push(o);
      }
    }
  }

  // Rule 1 & Rule 3: Clean axis-aligned highways and unobstructed single-lane ghosts stay razor-straight
  const isAxisAligned = Math.abs(dx) < 18 || Math.abs(dy) < 18;
  if (parallelIndex === 0 && blocking.length === 0 && (isAxisAligned || isGhost)) {
    return straightResult();
  }

  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;

  // Rule 2: Obstacle avoidance or bidirectional/parallel dual-lane curve
  if (blocking.length > 0 || parallelIndex !== 0) {
    let bowPx;
    if (blocking.length > 0) {
      let clearPos = 0;
      let clearNeg = 0;
      for (const o of blocking) {
        const s = (o.cx - cx1) * nx + (o.cy - cy1) * ny;
        const rObs = Math.abs((o.hw || 80) * nx) + Math.abs((o.hh || 24) * ny);
        clearPos = Math.max(clearPos, rObs + s + 24);
        clearNeg = Math.max(clearNeg, rObs - s + 24);
      }
      // Pick the shorter detour side (break ties deterministically toward +normal)
      const sign = clearNeg < clearPos ? -1 : 1;
      const needed = Math.min(clearPos, clearNeg);
      const maxBow = isGhost ? 72 : 185;
      bowPx = sign * Math.min(maxBow, Math.max(46, needed / 0.72));
      if (parallelIndex !== 0) {
        bowPx += parallelIndex * 18;
      }
    } else {
      const baseLane = isGhost ? 18 : 34;
      bowPx = parallelIndex * Math.min(72, Math.max(baseLane, dist * 0.12));
    }

    const c1 = { x: cx1 + dx * 0.32 + nx * bowPx, y: cy1 + dy * 0.32 + ny * bowPx };
    const c2 = { x: cx1 + dx * 0.68 + nx * bowPx, y: cy1 + dy * 0.68 + ny * bowPx };
    const p1 = intersectRectBorder(cx1, cy1, sz1.hw, sz1.hh, c1.x - cx1, c1.y - cy1, padStart);
    const p2 = intersectRectBorder(cx2, cy2, sz2.hw, sz2.hh, c2.x - cx2, c2.y - cy2, padEnd);
    const mx = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
    const my = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
    return {
      pathD: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
      p1,
      p2,
      c1,
      c2,
      mx,
      my,
      curved: true,
      kind: blocking.length > 0 ? 'avoid' : 'parallel'
    };
  }

  // Rule 4: Unobstructed active/queued diagonal -> orthogonal-tangent S-curve (clean 90-deg port entry)
  const preferVertical = Math.abs(dy) >= Math.abs(dx) * 0.45;
  if (preferVertical) {
    const sy = Math.sign(dy) || 1;
    const shift1 = Math.max(-sz1.hw * 0.32, Math.min(sz1.hw * 0.32, dx * 0.12));
    const shift2 = Math.max(-sz2.hw * 0.32, Math.min(sz2.hw * 0.32, dx * 0.12));
    const p1 = { x: cx1 + shift1, y: cy1 + sy * (sz1.hh + padStart) };
    const p2 = { x: cx2 - shift2, y: cy2 - sy * (sz2.hh + padEnd) };
    const spanY = (p2.y - p1.y) * sy;
    if (spanY >= 24) {
      const k = Math.min(132, Math.max(36, spanY * 0.48));
      const c1 = { x: p1.x, y: p1.y + sy * k };
      const c2 = { x: p2.x, y: p2.y - sy * k };
      const mx = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
      const my = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
      return {
        pathD: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
        p1,
        p2,
        c1,
        c2,
        mx,
        my,
        curved: true,
        kind: 's-vertical'
      };
    }
  }

  const sx = Math.sign(dx) || 1;
  const shift1 = Math.max(-sz1.hh * 0.28, Math.min(sz1.hh * 0.28, dy * 0.12));
  const shift2 = Math.max(-sz2.hh * 0.28, Math.min(sz2.hh * 0.28, dy * 0.12));
  const p1 = { x: cx1 + sx * (sz1.hw + padStart), y: cy1 + shift1 };
  const p2 = { x: cx2 - sx * (sz2.hw + padEnd), y: cy2 - shift2 };
  const spanX = (p2.x - p1.x) * sx;
  if (spanX >= 24) {
    const k = Math.min(132, Math.max(36, spanX * 0.48));
    const c1 = { x: p1.x + sx * k, y: p1.y };
    const c2 = { x: p2.x - sx * k, y: p2.y };
    const mx = 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x;
    const my = 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y;
    return {
      pathD: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
      p1,
      p2,
      c1,
      c2,
      mx,
      my,
      curved: true,
      kind: 's-horizontal'
    };
  }

  return straightResult();
}

/**
 * Deterministic sub-millisecond readability scorer for a single rig cluster layout.
 * Detects border overflows, padded card overlaps, cramped active edge corridors,
 * and active edges slicing through third-party cards.
 */
export function evaluateClusterReadability(local, agents, rigEdges, innerW, innerH, { detailed = false, measuredBoxes = null } = {}) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const positions = (local && local.positions) || {};
  const tiers = (local && local.tiers) || {};
  const geom = new Map();

  let overflowCount = 0;
  for (const agent of list) {
    const p = positions[agent.id];
    if (!p) continue;
    const tier = tiers[agent.id] || 'active';
    const box = resolveBox(agent, tier, { detailed, measuredBoxes });
    const cx = (p.x / 100) * innerW;
    const cy = (p.y / 100) * innerH;
    const hw = box.width / 2;
    const hh = box.height / 2;
    geom.set(agent.id, { cx, cy, hw, hh, tier });
    if (cx - hw < 2 || cx + hw > innerW - 2 || cy - hh < 2 || cy + hh > innerH - 2) {
      overflowCount++;
    }
  }

  let overlapCount = 0;
  const ids = [...geom.keys()];
  for (let i = 0; i < ids.length; i++) {
    const a = geom.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const b = geom.get(ids[j]);
      const pad = (a.tier === 'dormant' && b.tier === 'dormant') ? 4 : 8;
      if (Math.abs(a.cx - b.cx) < (a.hw + b.hw + pad) && Math.abs(a.cy - b.cy) < (a.hh + b.hh + pad)) {
        overlapCount++;
      }
    }
  }

  let crampedEdgeCount = 0;
  let edgeThroughCardCount = 0;
  const seenPairs = new Set();
  for (const edge of (Array.isArray(rigEdges) ? rigEdges : [])) {
    if (!isEdgeActiveForLayout(edge)) continue;
    const u = geom.get(edge.from);
    const v = geom.get(edge.to);
    if (!u || !v) continue;
    const pairKey = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const dx = v.cx - u.cx;
    const dy = v.cy - u.cy;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-3) {
      const ux = dx / dist, uy = dy / dist;
      const rU = Math.min(Math.abs(ux) > 1e-5 ? u.hw / Math.abs(ux) : 1e9, Math.abs(uy) > 1e-5 ? u.hh / Math.abs(uy) : 1e9);
      const rV = Math.min(Math.abs(ux) > 1e-5 ? v.hw / Math.abs(ux) : 1e9, Math.abs(uy) > 1e-5 ? v.hh / Math.abs(uy) : 1e9);
      const corridor = Math.max(0, dist - rU - rV);
      const badgeW = estimateEdgeBadgeWidthPx(edge);
      // Horizontal/shallow edges need the full badge width; steep vertical edges only need badge height + arrow margin.
      const requiredCorridor = Math.abs(ux) > 0.65
        ? Math.min(148, badgeW + 18)
        : Math.max(54, Math.min(92, badgeW * 0.55));
      if (corridor < requiredCorridor) crampedEdgeCount++;

      // Trim segment slightly from endpoints so border touch doesn't self-trigger
      const sx = u.cx + ux * (rU + 4), sy = u.cy + uy * (rU + 4);
      const ex = v.cx - ux * (rV + 4), ey = v.cy - uy * (rV + 4);
      if (corridor > 10) {
        for (const otherId of ids) {
          if (otherId === edge.from || otherId === edge.to) continue;
          const o = geom.get(otherId);
          if (segmentIntersectsPaddedBox(sx, sy, ex, ey, o.cx, o.cy, o.hw + 4, o.hh + 4)) {
            edgeThroughCardCount++;
            break;
          }
        }
      }
    }
  }

  const score = overflowCount * 100 + overlapCount * 80 + edgeThroughCardCount * 50 + crampedEdgeCount * 40;
  return { score, overflowCount, overlapCount, crampedEdgeCount, edgeThroughCardCount };
}

function estimateRigClusterDemand(agents, rigEdges, tiers, { detailed, measuredBoxes, insetX }) {
  const allItems = agents.map(agent => {
    const tier = tiers[agent.id] || 'active';
    return { agent, tier, role: getRolePlacementInfo(agent), box: resolveBox(agent, tier, { detailed, measuredBoxes }) };
  });
  const activeItems = allItems.filter(it => it.tier !== 'dormant');
  const sizedItems = activeItems.length > 0 ? activeItems : allItems;
  const maxCardW = Math.max(...allItems.map(it => it.box.width));
  const minSingleW = Math.max(220, maxCardW + insetX * 2 + 36);

  let needW = minSingleW;
  let weight = 0.85;

  if (sizedItems.length <= 1) {
    needW = minSingleW;
    weight = 0.75;
  } else if (sizedItems.length === 2) {
    // 2-node active pairs stack vertically inside compact columns with spacious vertical badges
    needW = Math.max(280, maxCardW + insetX * 2 + 64);
    weight = 1.3;
  } else {
    const activeEdges = rigEdges.filter(e => isEdgeActiveForLayout(e));
    const byBucket = new Map([[0, []], [1, []], [2, []]]);
    for (const it of sizedItems) byBucket.get(it.role.bucket).push(it);

    let maxTierNeedW = minSingleW;
    let occupiedBuckets = 0;
    for (const bucketId of [0, 1, 2]) {
      const group = byBucket.get(bucketId);
      if (group.length === 0) continue;
      occupiedBuckets++;
      const rowSlice = [...group].sort((a, b) => b.box.width - a.box.width).slice(0, Math.min(3, group.length));
      if (rowSlice.length <= 1) {
        maxTierNeedW = Math.max(maxTierNeedW, rowSlice[0].box.width + insetX * 2 + 48);
        continue;
      }
      const groupIds = new Set(group.map(it => it.agent.id));
      let maxPeerBadgeW = 0;
      for (const e of activeEdges) {
        if (groupIds.has(e.from) && groupIds.has(e.to)) {
          maxPeerBadgeW = Math.max(maxPeerBadgeW, estimateEdgeBadgeWidthPx(e));
        }
      }
      const peerGap = maxPeerBadgeW > 0
        ? Math.min(138, Math.max(92, maxPeerBadgeW + 18))
        : (detailed ? 32 : 48);
      const sumW = rowSlice.reduce((s, it) => s + it.box.width, 0);
      const tierNeed = sumW + (rowSlice.length - 1) * peerGap + insetX * 2 + 36;
      maxTierNeedW = Math.max(maxTierNeedW, tierNeed);
    }

    // 3-tier staggered triangle (Command -> Coder -> QA) needs lateral room for 0.26 / 0.74 offset
    if (occupiedBuckets >= 3) {
      maxTierNeedW = Math.max(maxTierNeedW, maxCardW * 2 + insetX * 2 + 64);
    }
    needW = Math.min(900, Math.max(360, maxTierNeedW));
    weight = Math.min(3.8, Math.max(1.8, needW / 185));
  }

  return {
    agents,
    items: allItems,
    activeCount: activeItems.length,
    dormantCount: allItems.length - activeItems.length,
    rigEdges,
    needW,
    weight
  };
}

function packRigRows(rigs, rigMeta, availCanvasW, gap) {
  const rows = [];
  let curRow = [];
  let curNeedSum = 0;

  for (const rigId of rigs) {
    const needW = rigMeta.get(rigId).needW;
    const projected = curRow.length === 0 ? needW : curNeedSum + gap + needW;
    if (curRow.length > 0 && (curRow.length >= 3 || projected > availCanvasW)) {
      rows.push(curRow);
      curRow = [rigId];
      curNeedSum = needW;
    } else {
      curRow.push(rigId);
      curNeedSum = projected;
    }
  }
  if (curRow.length > 0) rows.push(curRow);
  return rows;
}

function computeZoneGeometry(rowSlices, rigMeta, cw, ch, { pad, gap, insetX, insetTop, insetBottom, bottomReservePx, detailed }) {
  let width = cw;
  for (const rowRigs of rowSlices) {
    const rowMinTotal = pad * 2 + gap * Math.max(0, rowRigs.length - 1) +
      rowRigs.reduce((sum, r) => sum + rigMeta.get(r).needW, 0);
    if (rowMinTotal > width) width = rowMinTotal;
  }

  const zoneRects = new Map();
  for (let rIdx = 0; rIdx < rowSlices.length; rIdx++) {
    const rowRigs = rowSlices[rIdx];
    const availW = width - pad * 2 - gap * Math.max(0, rowRigs.length - 1);
    const sumMin = rowRigs.reduce((s, r) => s + rigMeta.get(r).needW, 0);
    const extraW = Math.max(0, availW - sumMin);
    const sumWeight = rowRigs.reduce((s, r) => s + rigMeta.get(r).weight, 0) || 1;
    let cursorX = pad;
    for (const rigId of rowRigs) {
      const m = rigMeta.get(rigId);
      const zW = m.needW + (extraW * m.weight) / sumWeight;
      zoneRects.set(rigId, { x: cursorX, w: zW, rowIdx: rIdx });
      cursorX += zW + gap;
    }
  }

  // Per-row minimum heights so compact rows (@kernel + @rig-commander) stay crisp
  // without inheriting the tall height of a multi-tier row below them.
  const rowMinHeights = rowSlices.map(rowRigs => {
    let minH = 220;
    for (const rigId of rowRigs) {
      const { items, activeCount, dormantCount } = rigMeta.get(rigId);
      const innerW = Math.max(200, zoneRects.get(rigId).w - insetX * 2);
      const activeItems = items.filter(it => it.tier !== 'dormant');
      const stageItems = activeItems.length > 0 ? activeItems : items;
      const cardH = Math.max(...items.map(it => it.box.height));
      let estH;
      if (stageItems.length <= 1 && dormantCount === 0) {
        estH = Math.max(220, cardH + 116 + insetTop + insetBottom);
      } else if (stageItems.length === 2 && dormantCount === 0) {
        const pairCardW = stageItems[0].box.width + stageItems[1].box.width;
        const verticalStack = (innerW - pairCardW) < (detailed ? 110 : 140);
        estH = verticalStack
          ? Math.max(320, cardH * 2 + 168 + insetTop + insetBottom)
          : Math.max(240, cardH + 128 + insetTop + insetBottom);
      } else {
        let tierRows = 0;
        for (const bucket of [0, 1, 2]) {
          tierRows += splitIntoBalancedRows(
            stageItems.filter(it => it.role.bucket === bucket),
            Math.max(180, innerW - 28),
            20,
            4
          ).length;
        }
        const benchExtra = dormantCount > 0 ? 54 : 0;
        estH = Math.max(340, 82 + tierRows * (cardH + 50) + benchExtra) + insetTop + insetBottom;
      }
      if (estH > minH) minH = estH;
    }
    return minH;
  });

  const rows = rowSlices.length;
  const usableCh = Math.max(240, ch - bottomReservePx);
  const sumMinH = rowMinHeights.reduce((s, h) => s + h, 0);
  const totalGapsH = pad * 2 + gap * Math.max(0, rows - 1);
  const spareH = Math.max(0, usableCh - totalGapsH - sumMinH);
  const rowHeights = rowMinHeights.map(h => h + (spareH * h) / (sumMinH || 1));

  const rowTops = [];
  let cursorY = pad;
  for (let rIdx = 0; rIdx < rows; rIdx++) {
    rowTops.push(cursorY);
    cursorY += rowHeights[rIdx] + gap;
  }
  const contentBottom = rows > 0 ? rowTops[rows - 1] + rowHeights[rows - 1] + pad : ch;
  const height = Math.max(ch, contentBottom + bottomReservePx);

  return { width, height, zoneRects, rowHeights, rowTops };
}

// Each rig uses the existing single-rig engine inside a disjoint, padded region.
// Variable-width shelf packing + deterministic readability scoring automatically wraps
// wide/dense pods onto their own full-width row so cards and edge badges never clip.
function layoutRigClusters(list, edges, options, activity, cw, ch) {
  const groups = new Map();
  for (const agent of list) {
    const rigId = rigIdOf(agent);
    if (!groups.has(rigId)) groups.set(rigId, []);
    groups.get(rigId).push(agent);
  }
  const rigs = [...groups.keys()].sort(naturalCompare);
  const { detailed, measuredBoxes, mode } = options;
  const bottomReservePx = Math.max(0, Number(options.bottomReservePx) || 0);
  const pad = 12, gap = 20, insetX = 16, insetTop = 32, insetBottom = 16;

  const rigMeta = new Map();
  for (const rigId of rigs) {
    const agents = groups.get(rigId);
    const idSet = new Set(agents.map(a => a.id));
    const rigEdges = (Array.isArray(edges) ? edges : []).filter(e => idSet.has(e.from) && idSet.has(e.to));
    rigMeta.set(rigId, estimateRigClusterDemand(agents, rigEdges, activity.tiers, { detailed, measuredBoxes, insetX }));
  }

  const availRowW = Math.max(320, cw - pad * 2);
  let rowSlices = packRigRows(rigs, rigMeta, availRowW, gap);

  const runPass = (slices) => {
    const geom = computeZoneGeometry(slices, rigMeta, cw, ch, { pad, gap, insetX, insetTop, insetBottom, bottomReservePx, detailed });
    const locals = new Map();
    const scores = new Map();
    for (const rigId of rigs) {
      const rect = geom.zoneRects.get(rigId);
      const zoneW = rect.w;
      const zoneH = geom.rowHeights[rect.rowIdx];
      const innerW = zoneW - insetX * 2;
      const innerH = zoneH - insetTop - insetBottom;
      const m = rigMeta.get(rigId);
      const local = computeTopologyLayout({
        ...options,
        bottomReservePx: 0,
        agents: m.agents,
        edges: m.rigEdges,
        canvasWidth: innerW,
        canvasHeight: innerH
      });
      locals.set(rigId, local);
      scores.set(rigId, evaluateClusterReadability(local, m.agents, m.rigEdges, innerW, innerH, { detailed, measuredBoxes }));
    }
    return { geom, locals, scores };
  };

  let pass = runPass(rowSlices);

  // Pass 2 (Readability Guard): if any cluster sharing a multi-rig row has readability
  // penalties (overflow, overlap, edge-through-card, or cramped edge badge) AND gets
  // meaningfully more width on its own row, promote it to a dedicated row and recompute once.
  const refinedSlices = [];
  let promoted = false;
  for (const rowRigs of rowSlices) {
    if (rowRigs.length < 2) {
      refinedSlices.push(rowRigs);
      continue;
    }
    const kept = [];
    const solo = [];
    for (const rigId of rowRigs) {
      const sc = pass.scores.get(rigId);
      const curW = pass.geom.zoneRects.get(rigId).w;
      if (sc && sc.score >= 40 && (availRowW - curW) > 48) {
        solo.push(rigId);
        promoted = true;
      } else {
        kept.push(rigId);
      }
    }
    if (kept.length > 0) refinedSlices.push(kept);
    for (const rigId of solo) refinedSlices.push([rigId]);
  }
  if (promoted) {
    rowSlices = refinedSlices;
    pass = runPass(rowSlices);
  }

  const { width, height, zoneRects, rowHeights, rowTops } = pass.geom;
  const positions = {}, benchEdgeById = {}, rigClusters = [];

  for (const rigId of rigs) {
    const rect = zoneRects.get(rigId);
    const x = rect.x;
    const zoneW = rect.w;
    const zoneH = rowHeights[rect.rowIdx];
    const y = rowTops[rect.rowIdx];
    const innerW = zoneW - insetX * 2;
    const innerH = zoneH - insetTop - insetBottom;
    const agents = groups.get(rigId);
    const local = pass.locals.get(rigId);
    for (const agent of agents) {
      const p = local.positions[agent.id];
      positions[agent.id] = {
        x: +((x + insetX + p.x * innerW / 100) * 100 / width).toFixed(4),
        y: +((y + insetTop + p.y * innerH / 100) * 100 / height).toFixed(4)
      };
      if (local.benchEdgeById[agent.id]) benchEdgeById[agent.id] = local.benchEdgeById[agent.id];
    }
    rigClusters.push({
      rigId,
      xPct: x * 100 / width,
      yPct: y * 100 / height,
      wPct: zoneW * 100 / width,
      hPct: zoneH * 100 / height,
      count: agents.length
    });
  }
  return {
    mode,
    positions,
    tiers: activity.tiers,
    benchEdgeById,
    benchSeparatorY: null,
    activeCount: activity.activeNodes.length,
    dormantCount: activity.dormantNodes.length,
    rigClusters,
    canvasWidth: width,
    canvasHeight: height
  };
}

/**
 * Computes normalized (0..100%) positions and activity tiers for all visible agents.
 */
export function computeTopologyLayout({
  agents = [],
  edges = [],
  mode = 'dynamic',
  canvasWidth = DEFAULT_CANVAS_W,
  canvasHeight = DEFAULT_CANVAS_H,
  detailed = false,
  measuredBoxes = null,
  recentActiveIds = null,
  bottomReservePx = 0
} = {}) {
  const safeMode = GRAPH_LAYOUT_MODES.includes(mode) ? mode : 'dynamic';
  const cw = Math.max(320, Number(canvasWidth) || DEFAULT_CANVAS_W);
  const ch = Math.max(240, Number(canvasHeight) || DEFAULT_CANVAS_H);
  const safeBottomReserve = Math.max(0, Math.min(ch * 0.25, Number(bottomReservePx) || 0));
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];

  const { tiers, activeNodes, dormantNodes, activeEdges } = classifyNodeActivityTier(list, edges, {
    recentActiveIds,
    useHysteresis: safeMode === 'dynamic'
  });

  if (new Set(activeNodes.map(rigIdOf)).size >= 2) {
    return layoutRigClusters(list, edges, { mode: safeMode, detailed, measuredBoxes, recentActiveIds, bottomReservePx: safeBottomReserve },
      { tiers, activeNodes, dormantNodes }, cw, ch);
  }

  const positions = {};
  const benchEdgeById = {};
  let benchSeparatorY = null;

  if (list.length === 0) {
    return {
      mode: safeMode,
      positions,
      tiers,
      benchEdgeById,
      benchSeparatorY,
      activeCount: 0,
      dormantCount: 0,
      rigClusters: [], canvasWidth: cw, canvasHeight: ch
    };
  }

  let placedItems = [];
  const effectiveCh = Math.max(220, ch - safeBottomReserve);

  if (safeMode === 'fixed') {
    // Fixed mode: invariant role-tiered layout sized for active cards so waking up never shifts positions
    placedItems = layoutFixedRoleGrid(list, tiers, cw, effectiveCh, {
      detailed,
      measuredBoxes,
      useActiveSizing: true
    });
  } else if (activeNodes.length === 0) {
    // Dynamic mode fallback when 100% of fleet is asleep: spacious full-canvas role layout
    placedItems = layoutFixedRoleGrid(list, tiers, cw, effectiveCh, {
      detailed,
      measuredBoxes,
      useActiveSizing: false
    });
  } else if (dormantNodes.length === 0) {
    // Dynamic mode when 0 dormant nodes (or hideIdleNodes ON): active stage owns 100% height above any bottom pill
    const stageTopY = detailed ? 74 : 46;
    const stageBottomY = Math.max(stageTopY + 80, effectiveCh - (detailed ? 64 : 26));
    placedItems = layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, {
      detailed,
      measuredBoxes
    });
  } else {
    // Dynamic Stage + Compact Dormant Bench
    const sortedDormant = sortAgentsDeterministically(dormantNodes);
    const dormantItems = sortedDormant.map(agent => ({
      agent,
      box: resolveBox(agent, 'dormant', { detailed, measuredBoxes }),
      px: cw / 2,
      py: ch - 26
    }));

    const usableW = Math.max(220, cw - 28);
    const gapX = detailed ? 14 : 10;
    const dormantRows = splitIntoBalancedRows(dormantItems, usableW, gapX, detailed ? 4 : 9);
    const rowPitchY = detailed ? 124 : 36;
    const bottomCenterPad = detailed ? 66 : 24;
    const maxBenchH = Math.max(60, ch * (detailed ? 0.44 : 0.34));
    const effectivePitchY = dormantRows.length > 1
      ? Math.min(rowPitchY, (maxBenchH - bottomCenterPad) / Math.max(1, dormantRows.length - 1))
      : rowPitchY;

    const topBenchRowCenterY = ch - bottomCenterPad - (dormantRows.length - 1) * effectivePitchY;
    const topBenchRowTopEdge = topBenchRowCenterY - (detailed ? 58 : 14);
    const separatorPx = Math.max(ch * 0.52, topBenchRowTopEdge - 18);
    benchSeparatorY = Number(((separatorPx / ch) * 100).toFixed(2));

    dormantRows.forEach((row, rIdx) => {
      const py = topBenchRowCenterY + rIdx * effectivePitchY;
      const totalRowW = row.reduce((s, it) => s + it.box.width, 0) + Math.max(0, row.length - 1) * gapX;
      if (totalRowW <= usableW) {
        let cursor = (cw - totalRowW) / 2;
        row.forEach(it => {
          it.px = cursor + it.box.width / 2;
          it.py = py;
          cursor += it.box.width + gapX;
          clampItem(it, cw, separatorPx + 8, ch - 8, 10);
        });
      } else {
        const xs = distributeRowX(row, cw, 12);
        row.forEach((it, idx) => {
          it.px = xs[idx];
          it.py = py;
          clampItem(it, cw, separatorPx + 8, ch - 8, 10);
        });
      }
    });

    const stageTopY = detailed ? 70 : 46;
    const stageBottomY = Math.max(stageTopY + 72, separatorPx - (detailed ? 64 : 34));
    const stageItems = layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, {
      detailed,
      measuredBoxes
    });

    placedItems = [...stageItems, ...dormantItems];
  }

  for (const it of placedItems) {
    const xPct = Number(((it.px / cw) * 100).toFixed(2));
    const yPct = Number(((it.py / ch) * 100).toFixed(2));
    positions[it.agent.id] = { x: xPct, y: yPct };
    if (tiers[it.agent.id] === 'dormant') {
      const flags = [];
      if (yPct >= 72) flags.push('bottom');
      if (xPct <= 18) flags.push('left');
      else if (xPct >= 82) flags.push('right');
      if (flags.length) benchEdgeById[it.agent.id] = flags.join(' ');
    }
  }

  return {
    mode: safeMode,
    positions,
    tiers,
    benchEdgeById,
    benchSeparatorY,
    activeCount: activeNodes.length,
    dormantCount: dormantNodes.length,
    rigClusters: [], canvasWidth: cw, canvasHeight: ch
  };
}

/**
 * Computes edge-clamped, flip-aware coordinates for an anchored popover (e.g. Edge X-Ray)
 * inside a container (.canvas-wrap) so it opens right beside the click point without clipping.
 */
export function computeAnchoredPopoverRect({
  anchorX,
  anchorY,
  containerW,
  containerH,
  popoverW,
  popoverH,
  pad = 12,
  offset = 16
} = {}) {
  const cw = Math.max(0, Number(containerW) || 0);
  const ch = Math.max(0, Number(containerH) || 0);
  const pw = Math.max(0, Number(popoverW) || 0);
  const ph = Math.max(0, Number(popoverH) || 0);
  const p = Math.max(0, Number(pad) || 0);
  const gap = Math.max(0, Number(offset) || 0);

  const ax = Number.isFinite(Number(anchorX)) ? Number(anchorX) : cw / 2;
  const ay = Number.isFinite(Number(anchorY)) ? Number(anchorY) : ch / 2;

  const bound = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const maxLeft = Math.max(p, cw - p - pw);
  const maxTop = Math.max(p, ch - p - ph);

  const desiredLeft = ax - pw / 2;
  const left = Math.round(bound(desiredLeft, p, maxLeft));

  const belowTop = ay + gap;
  const aboveTop = ay - gap - ph;

  let top;
  let placement;
  if (belowTop + ph <= ch - p) {
    top = belowTop;
    placement = 'below';
  } else if (aboveTop >= p) {
    top = aboveTop;
    placement = 'above';
  } else {
    // Tight viewport: pick the side with more vertical room and clamp safely inside bounds
    const roomBelow = ch - p - ay;
    const roomAbove = ay - p;
    top = roomBelow >= roomAbove ? bound(belowTop, p, maxTop) : bound(aboveTop, p, maxTop);
    placement = 'clamped';
  }

  return {
    left,
    top: Math.round(bound(top, p, maxTop)),
    placement
  };
}
