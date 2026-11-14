// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Layout Engine ("Best of All Worlds")
 *
 * Implements:
 *  1. Dwindle / BSP Tree (Hyprland / bspwm style) with aspect-ratio smart splits & adjustable ratios
 *  2. Master & Stack (dwm / XMonad style) with configurable masterCount, masterRatio, orientation & per-window weights
 *  3. Centered Master / Three-Column (AwesomeWM / Ultrawide style)
 *  4. Scrolling Columns (Niri / PaperWM style) with viewport tracking & per-window column widths
 *  5. Monocle / Zen Deck (i3 / bspwm style)
 *  6. Balanced Grid (gTile / AwesomeWM fair grid style)
 *  7. Geometric Directional Navigation (Pop!_OS Shell / Hyprland style)
 */

const BspTreeModule = require('./bsp-tree');
const BspTree = BspTreeModule.BspTree;
const clamp = BspTreeModule.clamp;
const snapRatioValue = BspTreeModule.snapRatioValue;

var LAYOUTS = [
    {
        id: 'dwindle',
        name: 'Dwindle / BSP',
        shortName: 'Dwindle',
        description: 'Spiral binary space partitioning (Hyprland / bspwm style)',
        badge: '[@]',
        icon: 'cinnawm-layout-dwindle-symbolic',
        iconFile: 'cinnawm-layout-dwindle-symbolic.svg'
    },
    {
        id: 'master-stack',
        name: 'Master & Stack',
        shortName: 'Master',
        description: 'Primary master area + stacked side column (dwm / XMonad style)',
        badge: '[]=',
        icon: 'cinnawm-layout-master-symbolic',
        iconFile: 'cinnawm-layout-master-symbolic.svg'
    },
    {
        id: 'centered-master',
        name: 'Centered Master',
        shortName: '3-Col',
        description: 'Centered master window + 2 side stacks (Ultrawide)',
        badge: '[|M|]',
        icon: 'cinnawm-layout-centered-symbolic',
        iconFile: 'cinnawm-layout-centered-symbolic.svg'
    },
    {
        id: 'scrolling',
        name: 'Scrolling Columns',
        shortName: 'Scrolling',
        description: 'Horizontally scrolling ribbon of columns (Niri / PaperWM style)',
        badge: '[>>>]',
        icon: 'cinnawm-layout-scrolling-symbolic',
        iconFile: 'cinnawm-layout-scrolling-symbolic.svg'
    },
    {
        id: 'monocle',
        name: 'Monocle / Zen',
        shortName: 'Monocle',
        description: 'Maximized or centered Zen deck (i3 style)',
        badge: '[M]',
        icon: 'cinnawm-layout-monocle-symbolic',
        iconFile: 'cinnawm-layout-monocle-symbolic.svg'
    },
    {
        id: 'grid',
        name: 'Balanced Grid',
        shortName: 'Grid',
        description: 'Balanced automatic R×C grid',
        badge: '[#]',
        icon: 'cinnawm-layout-grid-symbolic',
        iconFile: 'cinnawm-layout-grid-symbolic.svg'
    },
    {
        id: 'floating',
        name: 'Floating',
        shortName: 'Floating',
        description: 'Free floating windows without automatic tiling',
        badge: '[~]',
        icon: 'cinnawm-layout-floating-symbolic',
        iconFile: 'cinnawm-layout-floating-symbolic.svg'
    }
];

function getLayoutMeta(layoutId) {
    for (let i = 0; i < LAYOUTS.length; i++) {
        if (LAYOUTS[i].id === layoutId) {
            return LAYOUTS[i];
        }
    }
    return LAYOUTS[0];
}

function getNextLayoutId(currentId, direction = 1) {
    let idx = LAYOUTS.findIndex(l => l.id === currentId);
    if (idx === -1) idx = 0;
    let nextIdx = (idx + direction + LAYOUTS.length) % LAYOUTS.length;
    return LAYOUTS[nextIdx].id;
}

/**
 * Extracts a single-axis minimum size Map (windowId -> minW or minH) from `minSizes`.
 */
function buildAxisMinMap(minSizes, axis) {
    if (!minSizes || typeof minSizes.entries !== 'function') return null;
    let map = new Map();
    for (let [id, val] of minSizes.entries()) {
        if (val && Number.isFinite(val[axis]) && val[axis] > 60) {
            map.set(id, Math.round(val[axis]));
        }
    }
    return map.size > 0 ? map : null;
}

/**
 * Helper: distributes `totalSpan` across `items` (windowIds) weighted by `weightsMap` with `gap` between items,
 * respecting per-window minimum span constraints (`minSpansMap`) when provided.
 */
function distributeWeightedSpan(startPos, totalSpan, windowIds, weightsMap, gap, minSpansMap = null) {
    let n = windowIds.length;
    if (n === 0) return [];
    totalSpan = Math.max(0, totalSpan);
    if (n === 1) {
        return [{ windowId: windowIds[0], start: Math.round(startPos), size: Math.round(totalSpan) }];
    }

    // Preserve the requested gap when possible, but never let gaps force cells outside the area.
    let effectiveGap = Math.min(Math.max(0, gap), Math.max(0, (totalSpan - n) / (n - 1)));
    let totalGaps = effectiveGap * (n - 1);
    let availSpan = Math.max(0, totalSpan - totalGaps);
    let weights = windowIds.map(id => clamp((weightsMap && weightsMap.get(id)) || 1.0, 0.10, 8.0));
    let mins = windowIds.map(id => {
        let m = minSpansMap ? minSpansMap.get(id) : 60;
        return Number.isFinite(m) && m > 1 ? Math.round(m) : 1;
    });
    let totalMin = mins.reduce((a, b) => a + b, 0);

    let targetSizes = new Array(n).fill(0);

    if (totalMin > availSpan && totalMin > 0) {
        for (let i = 0; i < n; i++) {
            targetSizes[i] = Math.round(availSpan * (mins[i] / totalMin));
        }
    } else {
        let locked = new Array(n).fill(false);
        let remainingSpan = availSpan;

        while (true) {
            let unlockedWeightSum = 0;
            for (let i = 0; i < n; i++) {
                if (!locked[i]) unlockedWeightSum += weights[i];
            }
            if (unlockedWeightSum <= 0) break;

            let anyNewLock = false;
            for (let i = 0; i < n; i++) {
                if (locked[i]) continue;
                let share = remainingSpan * (weights[i] / unlockedWeightSum);
                if (share < mins[i]) {
                    targetSizes[i] = mins[i];
                    locked[i] = true;
                    remainingSpan -= mins[i];
                    anyNewLock = true;
                }
            }
            if (!anyNewLock) {
                for (let i = 0; i < n; i++) {
                    if (!locked[i]) {
                        targetSizes[i] = Math.round(remainingSpan * (weights[i] / unlockedWeightSum));
                    }
                }
                break;
            }
        }
    }

    let out = [];
    let cursor = startPos;
    let usedSpan = 0;

    for (let i = 0; i < n; i++) {
        let remainingMin = 0;
        for (let j = i + 1; j < n; j++) {
            remainingMin += (totalMin <= availSpan) ? mins[j] : 0;
        }
        let minForCurrent = (totalMin <= availSpan) ? mins[i] : 0;
        let maxAllowedForCurrent = Math.max(0, availSpan - usedSpan - remainingMin);
        let size = (i === n - 1)
            ? (availSpan - usedSpan)
            : clamp(targetSizes[i], minForCurrent, maxAllowedForCurrent);
        size = Math.max(0, size);
        out.push({
            windowId: windowIds[i],
            start: Math.round(cursor),
            size: Math.round(size)
        });
        cursor += size + effectiveGap;
        usedSpan += size;
    }
    return out;
}

function placeOverflowGroup(result, ids, spans, makeRect, groupRect, minSpan, minSpansMap = null) {
    if (ids.length > 1 && spans.some(span => {
        let hardMin = minSpansMap ? (minSpansMap.get(span.windowId) || 0) : 0;
        return span.size < minSpan || (hardMin > 60 && span.size < hardMin);
    })) {
        for (let id of ids) result.set(id, { ...groupRect, stacked: true });
        return;
    }
    for (let span of spans) result.set(span.windowId, makeRect(span));
}

/**
 * 2. Master & Stack Layout (dwm / XMonad style)
 */
function computeMasterStack(windowIds, area, options) {
    let result = new Map();
    let n = windowIds.length;
    if (n === 0) return result;

    let innerGap = Number.isFinite(options.innerGap) ? options.innerGap : 0;
    let masterCount = clamp(options.masterCount || 1, 1, n);
    let masterRatio = clamp(options.masterRatio || 0.55, 0.15, 0.85);
    let orientation = options.masterOrientation || 'left';
    let weights = options.weights || new Map();
    let colWeights = options.colWeights || weights;
    let minTileWidth = Math.max(1, options.overflowMinWidthPx || 220);
    let minTileHeight = Math.max(1, options.overflowMinHeightPx || 150);
    let minSizes = options.minSizes;
    let minWMap = buildAxisMinMap(minSizes, 'minW');
    let minHMap = buildAxisMinMap(minSizes, 'minH');

    if (n === 1 && Number.isFinite(options.masterSingleWindowWidthPct) && options.masterSingleWindowWidthPct < 100) {
        let ratio = clamp(options.masterSingleWindowWidthPct / 100.0, 0.4, 1.0);
        let singleW = Math.round(area.width * ratio);
        let singleX = area.x + Math.round((area.width - singleW) / 2);
        result.set(windowIds[0], { x: singleX, y: area.y, width: singleW, height: area.height });
        return result;
    }

    if (n <= masterCount) {
        let isHorizontalMaster = (orientation === 'top' || orientation === 'bottom');
        let allMasterIds = (orientation === 'right' || orientation === 'bottom')
            ? windowIds.slice().reverse()
            : windowIds;
        if (minSizes && n > 1) {
            let sumMinW = allMasterIds.reduce((s, id) => s + (minWMap?.get(id) || 60), 0) + innerGap * (n - 1);
            let sumMinH = allMasterIds.reduce((s, id) => s + (minHMap?.get(id) || 60), 0) + innerGap * (n - 1);
            if (!isHorizontalMaster && sumMinW > area.width && sumMinH <= area.height) {
                isHorizontalMaster = true;
            } else if (isHorizontalMaster && sumMinH > area.height && sumMinW <= area.width) {
                isHorizontalMaster = false;
            }
        }
        if (isHorizontalMaster) {
            let spans = distributeWeightedSpan(area.y, area.height, allMasterIds, weights, innerGap, minHMap);
            placeOverflowGroup(result, allMasterIds, spans,
                s => ({ x: area.x, y: s.start, width: area.width, height: s.size }),
                { x: area.x, y: area.y, width: area.width, height: area.height }, minTileHeight, minHMap);
        } else {
            let spans = distributeWeightedSpan(area.x, area.width, allMasterIds, colWeights, innerGap, minWMap);
            placeOverflowGroup(result, allMasterIds, spans,
                s => ({ x: s.start, y: area.y, width: s.size, height: area.height }),
                { x: area.x, y: area.y, width: area.width, height: area.height }, minTileWidth, minWMap);
        }
        return result;
    }

    let masterIds = windowIds.slice(0, masterCount);
    let stackIds = windowIds.slice(masterCount);

    let isInitiallyLeftRight = orientation === 'left' || orientation === 'right';
    let widestGroup = Math.max(masterIds.length, stackIds.length);
    if (isInitiallyLeftRight && area.width < 2 * minTileWidth + innerGap &&
        area.height >= 2 * minTileHeight + innerGap &&
        widestGroup * minTileWidth + (widestGroup - 1) * innerGap <= area.width) {
        orientation = orientation === 'left' ? 'top' : 'bottom';
    } else if (!isInitiallyLeftRight && area.height < 2 * minTileHeight + innerGap &&
               area.width >= 2 * minTileWidth + innerGap &&
               widestGroup * minTileHeight + (widestGroup - 1) * innerGap <= area.height) {
        orientation = orientation === 'top' ? 'left' : 'right';
    }

    // Smart Reflow: if Master and Stack columns cannot fit side-by-side due to minimum widths,
    // automatically rotate to top/bottom if stacking vertically fits better (and vice versa).
    if (minSizes) {
        let masterColMinW = Math.max(60, ...masterIds.map(id => minWMap?.get(id) || 60));
        let stackColMinW = Math.max(60, ...stackIds.map(id => minWMap?.get(id) || 60));
        let masterRowMinH = Math.max(60, ...masterIds.map(id => minHMap?.get(id) || 60));
        let stackRowMinH = Math.max(60, ...stackIds.map(id => minHMap?.get(id) || 60));
        let masterRowSumW = masterIds.reduce((s, id) => s + (minWMap?.get(id) || 60), 0) + innerGap * (masterIds.length - 1);
        let stackRowSumW = stackIds.reduce((s, id) => s + (minWMap?.get(id) || 60), 0) + innerGap * (stackIds.length - 1);
        let masterColSumH = masterIds.reduce((s, id) => s + (minHMap?.get(id) || 60), 0) + innerGap * (masterIds.length - 1);
        let stackColSumH = stackIds.reduce((s, id) => s + (minHMap?.get(id) || 60), 0) + innerGap * (stackIds.length - 1);

        let isLeftRight = (orientation === 'left' || orientation === 'right');
        if (isLeftRight &&
            (masterColMinW + stackColMinW + innerGap > area.width) &&
            (masterRowMinH + stackRowMinH + innerGap <= area.height) &&
            (Math.max(masterRowSumW, stackRowSumW) <= area.width)) {
            orientation = (orientation === 'left') ? 'top' : 'bottom';
        } else if (!isLeftRight &&
                   (masterRowMinH + stackRowMinH + innerGap > area.height) &&
                   (masterColMinW + stackColMinW + innerGap <= area.width) &&
                   (Math.max(masterColSumH, stackColSumH) <= area.height)) {
            orientation = (orientation === 'top') ? 'left' : 'right';
        }
    }

    if (orientation === 'left' || orientation === 'right') {
        let splitGap = Math.min(innerGap, Math.max(0, area.width - 1));
        let availW = Math.max(0, area.width - splitGap);
        let masterW = Math.round(availW * masterRatio);
        if (minSizes) {
            let masterMinW = Math.max(60, ...masterIds.map(id => minSizes.get(id)?.minW || 60));
            let stackMinW = Math.max(60, ...stackIds.map(id => minSizes.get(id)?.minW || 60));
            if (availW >= masterMinW + stackMinW) {
                masterW = clamp(masterW, masterMinW, availW - stackMinW);
            } else if (masterMinW + stackMinW > 0) {
                masterW = clamp(Math.round(availW * (masterMinW / (masterMinW + stackMinW))), 0, availW);
            }
        }
        let stackW = availW - masterW;

        let masterX = (orientation === 'left') ? area.x : (area.x + stackW + splitGap);
        let stackX = (orientation === 'left') ? (area.x + masterW + splitGap) : area.x;

        let masterSpans = distributeWeightedSpan(area.y, area.height, masterIds, weights, innerGap, minHMap);
        let masterRegion = { x: masterX, y: area.y, width: masterW, height: area.height };
        placeOverflowGroup(result, masterIds, masterSpans,
            s => ({ x: masterX, y: s.start, width: masterW, height: s.size }),
            masterRegion, minTileHeight, minHMap);

        let stackSpans = distributeWeightedSpan(area.y, area.height, stackIds, weights, innerGap, minHMap);
        let stackRegion = { x: stackX, y: area.y, width: stackW, height: area.height };
        placeOverflowGroup(result, stackIds, stackSpans,
            s => ({ x: stackX, y: s.start, width: stackW, height: s.size }),
            stackRegion, minTileHeight, minHMap);
    } else {
        let splitGap = Math.min(innerGap, Math.max(0, area.height - 1));
        let availH = Math.max(0, area.height - splitGap);
        let masterH = Math.round(availH * masterRatio);
        if (minSizes) {
            let masterMinH = Math.max(60, ...masterIds.map(id => minSizes.get(id)?.minH || 60));
            let stackMinH = Math.max(60, ...stackIds.map(id => minSizes.get(id)?.minH || 60));
            if (availH >= masterMinH + stackMinH) {
                masterH = clamp(masterH, masterMinH, availH - stackMinH);
            } else if (masterMinH + stackMinH > 0) {
                masterH = clamp(Math.round(availH * (masterMinH / (masterMinH + stackMinH))), 0, availH);
            }
        }
        let stackH = availH - masterH;

        let masterY = (orientation === 'top') ? area.y : (area.y + stackH + splitGap);
        let stackY = (orientation === 'top') ? (area.y + masterH + splitGap) : area.y;

        let masterSpans = distributeWeightedSpan(area.x, area.width, masterIds, colWeights, innerGap, minWMap);
        placeOverflowGroup(result, masterIds, masterSpans,
            s => ({ x: s.start, y: masterY, width: s.size, height: masterH }),
            { x: area.x, y: masterY, width: area.width, height: masterH }, minTileWidth, minWMap);

        let stackSpans = distributeWeightedSpan(area.x, area.width, stackIds, colWeights, innerGap, minWMap);
        placeOverflowGroup(result, stackIds, stackSpans,
            s => ({ x: s.start, y: stackY, width: s.size, height: stackH }),
            { x: area.x, y: stackY, width: area.width, height: stackH }, minTileWidth, minWMap);
    }

    return result;
}

/**
 * 3. Centered Master / Three-Column Layout (AwesomeWM / Ultrawide style)
 */
function computeCenteredMaster(windowIds, area, options) {
    let result = new Map();
    let n = windowIds.length;
    if (n === 0) return result;

    let innerGap = Number.isFinite(options.innerGap) ? options.innerGap : 0;
    let masterCount = clamp(options.centeredMasterCount || options.masterCount || 1, 1, n);
    let masterRatio = clamp(options.centeredMasterRatio || options.masterRatio || 0.50, 0.25, 0.75);
    let sideBalance = options.centeredMasterSideBalance || 'alternate';
    let weights = options.weights || new Map();
    let minHMap = buildAxisMinMap(options.minSizes, 'minH');
    let minTileWidth = Math.max(1, options.overflowMinWidthPx || 220);
    let minTileHeight = Math.max(1, options.overflowMinHeightPx || 150);

    if (n === 1 && Number.isFinite(options.centeredMasterSingleWidthPct) && options.centeredMasterSingleWidthPct < 100) {
        let ratio = clamp(options.centeredMasterSingleWidthPct / 100.0, 0.4, 1.0);
        let singleW = Math.round(area.width * ratio);
        let singleX = area.x + Math.round((area.width - singleW) / 2);
        result.set(windowIds[0], { x: singleX, y: area.y, width: singleW, height: area.height });
        return result;
    }

    if (n <= masterCount + 1) {
        let effectiveMasterCount = (n === 2) ? 1 : clamp(masterCount, 1, n - 1);
        return computeMasterStack(windowIds, area, {
            ...options,
            masterCount: effectiveMasterCount,
            masterRatio,
            masterOrientation: 'left'
        });
    }

    let masterIds = windowIds.slice(0, masterCount);
    let remainingIds = windowIds.slice(masterCount);
    let rightIds = [];
    let leftIds = [];

    if (sideBalance === 'left-first') {
        for (let i = 0; i < remainingIds.length; i++) {
            if (i % 2 === 0) leftIds.push(remainingIds[i]);
            else rightIds.push(remainingIds[i]);
        }
    } else if (sideBalance === 'equal-split') {
        let half = Math.ceil(remainingIds.length / 2);
        leftIds = remainingIds.slice(0, half);
        rightIds = remainingIds.slice(half);
    } else {
        for (let i = 0; i < remainingIds.length; i++) {
            if (i % 2 === 0) rightIds.push(remainingIds[i]);
            else leftIds.push(remainingIds[i]);
        }
    }

    let centeredGap = Math.min(innerGap, Math.max(0, (area.width - 1) / 2));
    let availW = Math.max(1, area.width - 2 * centeredGap);
    let centerW, sideW, rightW;
    if (Number.isFinite(options.centeredLeftRatio) && Number.isFinite(options.centeredRightRatio)) {
        sideW = clamp(Math.round(availW * options.centeredLeftRatio), 1, Math.max(1, availW - 2));
        rightW = clamp(Math.round(availW * options.centeredRightRatio), 1, Math.max(1, availW - sideW - 1));
        centerW = availW - sideW - rightW;
    } else {
        centerW = Math.round(availW * masterRatio);
        sideW = Math.floor((availW - centerW) / 2);
        rightW = availW - centerW - sideW;
    }

    if (Math.min(sideW, centerW, rightW) < minTileWidth) {
        return computeMasterStack(windowIds, area, {
            ...options,
            masterCount,
            masterRatio,
            masterOrientation: 'left'
        });
    }

    if (options.minSizes) {
        let minSizes = options.minSizes;
        let leftMinW = Math.max(60, ...leftIds.map(id => minSizes.get(id)?.minW || 60));
        let centerMinW = Math.max(60, ...masterIds.map(id => minSizes.get(id)?.minW || 60));
        let rightMinW = Math.max(60, ...rightIds.map(id => minSizes.get(id)?.minW || 60));
        if (availW >= leftMinW + centerMinW + rightMinW) {
            let widthWeights = new Map([[0, Math.max(1, sideW)], [1, Math.max(1, centerW)], [2, Math.max(1, rightW)]]);
            let widthMins = new Map([[0, leftMinW], [1, centerMinW], [2, rightMinW]]);
            let widths = distributeWeightedSpan(0, availW, [0, 1, 2], widthWeights, 0, widthMins);
            sideW = widths[0].size;
            centerW = widths[1].size;
            rightW = widths[2].size;
        } else {
            // Smart Reflow: 3 columns cannot fit side-by-side at their minimum widths -> degrade to 2-column Master & Stack
            return computeMasterStack(windowIds, area, {
                ...options,
                masterCount,
                masterRatio,
                masterOrientation: 'left'
            });
        }
    }

    let leftX = area.x;
    let centerX = area.x + sideW + centeredGap;
    let rightX = centerX + centerW + centeredGap;

    let leftSpans = distributeWeightedSpan(area.y, area.height, leftIds, weights, innerGap, minHMap);
    placeOverflowGroup(result, leftIds, leftSpans,
        s => ({ x: leftX, y: s.start, width: sideW, height: s.size }),
        { x: leftX, y: area.y, width: sideW, height: area.height }, minTileHeight, minHMap);

    let centerSpans = distributeWeightedSpan(area.y, area.height, masterIds, weights, innerGap, minHMap);
    placeOverflowGroup(result, masterIds, centerSpans,
        s => ({ x: centerX, y: s.start, width: centerW, height: s.size }),
        { x: centerX, y: area.y, width: centerW, height: area.height }, minTileHeight, minHMap);

    let rightSpans = distributeWeightedSpan(area.y, area.height, rightIds, weights, innerGap, minHMap);
    placeOverflowGroup(result, rightIds, rightSpans,
        s => ({ x: rightX, y: s.start, width: rightW, height: s.size }),
        { x: rightX, y: area.y, width: rightW, height: area.height }, minTileHeight, minHMap);

    return result;
}

/**
 * 4. Scrolling Columns Layout (Niri / PaperWM style)
 */
function computeScrolling(windowIds, area, options) {
    let result = new Map();
    let n = windowIds.length;
    if (n === 0) return { rects: result, scrollOffset: 0 };

    let innerGap = Number.isFinite(options.innerGap) ? options.innerGap : 0;
    let baseColRatio = clamp(options.scrollingColumnRatio || 0.60, 0.30, 1.0);
    let singleColRatio = Number.isFinite(options.scrollingSingleColumnWidthPct)
        ? clamp(options.scrollingSingleColumnWidthPct / 100.0, 0.40, 1.0)
        : 1.0;
    let focusAlignment = options.scrollingFocusAlignment || 'edge';
    let minVisibleW = clamp(options.scrollingMinVisibleWidthPx || 140, 80, 320);
    let weights = options.weights || new Map();
    let focusedId = options.focusedId;
    let currentScroll = options.scrollOffset || 0;

    if (n === 1) {
        let id = windowIds[0];
        let effRatio = weights.has(id)
            ? clamp(baseColRatio * clamp(weights.get(id), 0.5, 1.65), 0.30, 1.0)
            : singleColRatio;
        if (effRatio < 1.0) {
            let colW = Math.round(area.width * effRatio);
            let colX = area.x + Math.round((area.width - colW) / 2);
            result.set(id, {
                x: colX,
                y: Math.round(area.y),
                width: colW,
                height: Math.round(area.height),
                offscreen: false
            });
            return { rects: result, scrollOffset: 0 };
        }
    }

    let virtualCols = [];
    let cursorX = 0;

    for (let i = 0; i < n; i++) {
        let id = windowIds[i];
        let weight = clamp(weights.get(id) || 1.0, 0.5, 1.65);
        let colRatio = (n === 1) ? 1.0 : clamp(baseColRatio * weight, 0.30, 1.0);
        let colW = Math.round(area.width * colRatio);

        virtualCols.push({
            windowId: id,
            vx: cursorX,
            width: colW
        });
        cursorX += colW + (i < n - 1 ? innerGap : 0);
    }

    let totalStripWidth = cursorX;
    let maxScroll = Math.max(0, totalStripWidth - area.width);

    let focusedCol = virtualCols.find(c => c.windowId === focusedId) || virtualCols[0];
    let scrollOffset = clamp(currentScroll, 0, maxScroll);

    if (focusedCol) {
        if (focusAlignment === 'center') {
            let targetCenter = focusedCol.vx + Math.round(focusedCol.width / 2);
            scrollOffset = clamp(targetCenter - Math.round(area.width / 2), 0, maxScroll);
        } else {
            let colLeft = focusedCol.vx;
            let colRight = focusedCol.vx + focusedCol.width;
            if (colLeft < scrollOffset) {
                scrollOffset = colLeft;
            } else if (colRight > scrollOffset + area.width) {
                scrollOffset = colRight - area.width;
            }
            scrollOffset = clamp(scrollOffset, 0, maxScroll);
        }
    }

    let areaRight = area.x + area.width;
    let leftPeek = null;
    let rightPeek = null;
    for (let col of virtualCols) {
        let screenX = area.x + col.vx - scrollOffset;
        let visibleW = Math.min(areaRight, screenX + col.width) - Math.max(area.x, screenX);
        if (visibleW >= minVisibleW) continue;
        if (screenX < area.x && (!leftPeek || screenX + col.width > leftPeek.screenX + leftPeek.width))
            leftPeek = { ...col, screenX };
        else if (screenX + col.width > areaRight && (!rightPeek || screenX < rightPeek.screenX))
            rightPeek = { ...col, screenX };
    }

    for (let col of virtualCols) {
        let screenX = area.x + (col.vx - scrollOffset);
        let clampedLeft = Math.max(area.x, screenX);
        let clampedRight = Math.min(areaRight, screenX + col.width);
        let visibleW = clampedRight - clampedLeft;

        if (visibleW >= minVisibleW) {
            result.set(col.windowId, {
                x: Math.round(clampedLeft),
                y: Math.round(area.y),
                width: Math.round(visibleW),
                height: Math.round(area.height),
                offscreen: false
            });
        } else if (visibleW > 0 && screenX >= area.x && screenX + col.width <= areaRight) {
            result.set(col.windowId, {
                x: Math.round(screenX), y: Math.round(area.y),
                width: Math.round(col.width), height: Math.round(area.height), offscreen: false
            });
        } else {
            let isLeftPeek = leftPeek && leftPeek.windowId === col.windowId;
            let isRightPeek = rightPeek && rightPeek.windowId === col.windowId;
            if (!isLeftPeek && !isRightPeek) {
                result.set(col.windowId, {
                    x: Math.round(screenX), y: Math.round(area.y),
                    width: Math.round(col.width), height: Math.round(area.height), offscreen: true
                });
                continue;
            }
            let peekW = Math.min(col.width, area.width, Math.max(1, Math.round(area.width * 0.30)));
            let edgeX = isLeftPeek ? area.x : (areaRight - peekW);
            result.set(col.windowId, {
                x: Math.round(edgeX),
                y: Math.round(area.y),
                width: Math.round(peekW),
                height: Math.round(area.height),
                offscreen: true
            });
        }
    }

    return { rects: result, scrollOffset };
}

/**
 * 5. Monocle / Zen Deck Layout (i3 / bspwm style)
 */
function computeMonocle(windowIds, area, options) {
    let result = new Map();
    let requestedMargin = clamp(options.monocleOuterMarginPx || 0, 0, 120);
    let extraMargin = Math.min(requestedMargin, Math.max(0, (area.width - 1) / 2), Math.max(0, (area.height - 1) / 2));
    let effArea = {
        x: area.x + extraMargin,
        y: area.y + extraMargin,
        width: Math.max(1, area.width - 2 * extraMargin),
        height: Math.max(1, area.height - 2 * extraMargin)
    };
    let zenRatioW = clamp((options.monocleZenWidthPct || 100) / 100.0, 0.40, 1.0);
    let zenRatioH = clamp((options.monocleZenHeightPct || 100) / 100.0, 0.45, 1.0);
    let targetW = Math.round(effArea.width * zenRatioW);
    let targetH = Math.round(effArea.height * zenRatioH);
    let targetX = effArea.x + Math.round((effArea.width - targetW) / 2);
    let targetY = effArea.y + Math.round((effArea.height - targetH) / 2);

    for (let id of windowIds) {
        result.set(id, {
            x: targetX,
            y: targetY,
            width: targetW,
            height: targetH
        });
    }
    return result;
}

function computeEffectiveWorkarea(rawWorkarea, n, settings = {}, layoutId = null) {
    let smartGaps = Boolean(settings.smartGaps) && n === 1 &&
        (layoutId !== 'monocle' || (settings.monocleZenWidthPct || 100) === 100);
    let rawInner = Number.isFinite(settings.innerGap) ? settings.innerGap : 8;
    let rawOuter = Number.isFinite(settings.outerGap) ? settings.outerGap : 8;
    let outerGap = smartGaps ? 0 : Math.max(0, rawOuter);
    let workWidth = Math.max(1, rawWorkarea.width);
    let workHeight = Math.max(1, rawWorkarea.height);
    let outerGapX = Math.min(outerGap, Math.max(0, (workWidth - 1) / 2));
    let outerGapY = Math.min(outerGap, Math.max(0, (workHeight - 1) / 2));

    let area = {
        x: rawWorkarea.x + outerGapX,
        y: rawWorkarea.y + outerGapY,
        width: workWidth - 2 * outerGapX,
        height: workHeight - 2 * outerGapY
    };
    // A requested gap is reduced only when n-1 gaps cannot fit on the shorter workarea axis.
    let gapCapacity = n > 1 ? Math.max(0, (Math.min(area.width, area.height) - 1) / (n - 1)) : rawInner;
    let innerGap = smartGaps ? 0 : Math.min(Math.max(0, rawInner), gapCapacity);
    return { area, innerGap, outerGap, smartGaps };
}

function computeGridDimensions(windowIds, area, options = {}) {
    let n = windowIds.length;
    let innerGap = Number.isFinite(options.innerGap) ? options.innerGap : 0;
    let maxCols = Number.isFinite(options.gridMaxCols) && options.gridMaxCols > 0
        ? clamp(options.gridMaxCols, 1, 8)
        : 0;
    let minWMap = buildAxisMinMap(options.minSizes, 'minW');
    let minHMap = buildAxisMinMap(options.minSizes, 'minH');
    let minTileWidth = Math.max(1, options.overflowMinWidthPx || 220);
    let minTileHeight = Math.max(1, options.overflowMinHeightPx || 150);

    let fitCols = Math.max(1, Math.floor((area.width + innerGap) / (minTileWidth + innerGap)));
    let fitRows = Math.max(1, Math.floor((area.height + innerGap) / (minTileHeight + innerGap)));
    let cols = n > 0 ? (maxCols > 0 ? Math.min(n, maxCols) : Math.ceil(Math.sqrt(n))) : 1;
    cols = Math.min(cols, fitCols);

    if (n > 0 && minWMap) {
        const checkRowWidthOverflow = (candCols) => {
            let candRows = Math.ceil(n / candCols);
            let cursor = 0;
            for (let r = 0; r < candRows; r++) {
                let count = (r === candRows - 1) ? (n - cursor) : candCols;
                let reqW = (count - 1) * innerGap;
                for (let c = 0; c < count; c++) {
                    reqW += minWMap.get(windowIds[cursor + c]) || 60;
                }
                if (reqW > area.width) return true;
                cursor += count;
            }
            return false;
        };
        const checkColHeightOverflow = (candCols) => {
            let candRows = Math.ceil(n / candCols);
            let reqH = (candRows - 1) * innerGap;
            let cursor = 0;
            for (let r = 0; r < candRows; r++) {
                let count = (r === candRows - 1) ? (n - cursor) : candCols;
                let rowMaxMinH = 60;
                for (let c = 0; c < count; c++) {
                    rowMaxMinH = Math.max(rowMaxMinH, minHMap?.get(windowIds[cursor + c]) || 60);
                }
                reqH += rowMaxMinH;
                cursor += count;
            }
            return reqH > area.height;
        };

        while (cols > 1 && checkRowWidthOverflow(cols) && !checkColHeightOverflow(cols - 1)) {
            cols--;
        }
    }

    let capacity = cols * fitRows;
    let cellIds = windowIds.slice(0, Math.min(n, capacity));
    let cellCount = cellIds.length;
    let rows = cellCount > 0 ? Math.ceil(cellCount / cols) : 0;

    return {
        cols,
        rows,
        fitCols,
        fitRows,
        cellIds,
        cellCount,
        innerGap,
        minWMap,
        minHMap,
        minTileWidth,
        minTileHeight
    };
}

/**
 * 6. Balanced Grid Layout (Fair Grid style)
 */
function computeGrid(windowIds, area, options) {
    let result = new Map();
    let n = windowIds.length;
    if (n === 0) return result;

    let lastRowBehavior = options.gridLastRowBehavior || 'stretch';
    let colWeights = options.colWeights || options.weights || new Map();
    let dims = computeGridDimensions(windowIds, area, options);
    let {
        cols,
        rows,
        cellIds,
        cellCount,
        innerGap,
        minWMap,
        minHMap,
        minTileWidth,
        minTileHeight
    } = dims;
    let rowIds = [];
    let rowMinHMap = new Map();
    let cellMinWMap = new Map();
    let probeIdx = 0;
    for (let r = 0; r < rows; r++) {
        let count = (r === rows - 1) ? (cellCount - probeIdx) : cols;
        let rowMaxMinH = minTileHeight;
        for (let c = 0; c < count; c++) {
            let id = cellIds[probeIdx + c];
            rowMaxMinH = Math.max(rowMaxMinH, minHMap?.get(id) || 60);
            cellMinWMap.set(id, Math.max(minTileWidth, minWMap?.get(id) || 60));
        }
        rowIds.push(r);
        rowMinHMap.set(r, rowMaxMinH);
        probeIdx += count;
    }

    let rowSpans = distributeWeightedSpan(area.y, area.height, rowIds, options.gridRowWeights || null, innerGap, rowMinHMap);
    let stdCellW = Math.floor((area.width - innerGap * (cols - 1)) / cols);

    let idx = 0;
    for (let r = 0; r < rows; r++) {
        let itemsInRow = (r === rows - 1) ? (cellCount - idx) : cols;
        let isIncompleteLastRow = (r === rows - 1) && (itemsInRow < cols);
        let y = rowSpans[r].start;
        let h = rowSpans[r].size;
        let rowWinIds = cellIds.slice(idx, idx + itemsInRow);

        if (isIncompleteLastRow && (lastRowBehavior === 'center' || lastRowBehavior === 'left')) {
            let cellWidths = rowWinIds.map(id => Math.max(stdCellW, cellMinWMap.get(id) || 1));
            let rowTotalW = cellWidths.reduce((a, b) => a + b, 0) + (itemsInRow - 1) * innerGap;
            if (rowTotalW <= area.width) {
                let startX = (lastRowBehavior === 'center')
                    ? (area.x + Math.round((area.width - rowTotalW) / 2))
                    : area.x;
                let curX = startX;
                for (let c = 0; c < itemsInRow; c++) {
                    result.set(rowWinIds[c], {
                        x: Math.round(curX),
                        y: Math.round(y),
                        width: Math.max(60, Math.round(cellWidths[c])),
                        height: Math.max(0, Math.round(h))
                    });
                    curX += cellWidths[c] + innerGap;
                }
                idx += itemsInRow;
                continue;
            }
        }

        let colSpans = distributeWeightedSpan(area.x, area.width, rowWinIds, colWeights, innerGap, cellMinWMap);
        for (let s of colSpans) {
            result.set(s.windowId, {
                x: s.start,
                y: Math.round(y),
                width: s.size,
                height: Math.max(0, Math.round(h))
            });
        }
        idx += itemsInRow;
    }

    if (cellCount > 0 && cellCount < n) {
        let bucketCounts = new Array(cellCount).fill(1);
        for (let i = cellCount; i < n; i++) bucketCounts[i % cellCount]++;
        for (let i = 0; i < cellCount; i++) {
            let baseId = cellIds[i];
            let baseRect = result.get(baseId);
            if (bucketCounts[i] > 1) result.set(baseId, { ...baseRect, stacked: true });
        }
        for (let i = cellCount; i < n; i++) {
            let baseRect = result.get(cellIds[i % cellCount]);
            result.set(windowIds[i], { ...baseRect, stacked: true });
        }
    }
    return result;
}

function normalizeSubgroupWeights(ids, weightsMap) {
    if (!ids || ids.length < 2 || !weightsMap) return;
    let vals = ids.map(id => clamp(weightsMap.get(id) || 1.0, 0.10, 8.0));
    let sum = vals.reduce((a, b) => a + b, 0);
    if (sum <= 0) return;
    let k = ids.length;
    for (let i = 0; i < k; i++) {
        weightsMap.set(ids[i], clamp((vals[i] / sum) * k, 0.10, 8.0));
    }
}

/**
 * Sanitizes `state.tabGroups` against `validWindowIds` (or `state.fullWindowOrder` / `state.windowOrder`),
 * ensuring every group has >= 2 distinct valid window IDs and updating `state.activeTabMap`.
 */
function sanitizeTabGroups(state, validWindowIds = null) {
    if (!state) return [];
    if (!Array.isArray(state.tabGroups)) {
        state.tabGroups = [];
        return [];
    }
    if (!(state.activeTabMap instanceof Map)) {
        state.activeTabMap = new Map();
    }

    let validSet = null;
    if (validWindowIds) {
        validSet = new Set(validWindowIds);
    } else if (Array.isArray(state.fullWindowOrder) && state.fullWindowOrder.length > 0) {
        validSet = new Set(state.fullWindowOrder);
    } else if (Array.isArray(state.windowOrder) && state.windowOrder.length > 0) {
        validSet = new Set(state.windowOrder);
    }

    let claimed = new Set();
    let cleaned = [];
    for (let rawGroup of state.tabGroups) {
        if (!Array.isArray(rawGroup)) continue;
        let grp = [];
        for (let id of rawGroup) {
            if (typeof id !== 'number' || claimed.has(id)) continue;
            if (validSet && !validSet.has(id)) continue;
            claimed.add(id);
            grp.push(id);
        }
        if (grp.length >= 2) {
            cleaned.push(grp);
        }
    }

    // If we only filtered by visible windows while some windows are minimized/fullscreen, don't overwrite full tabGroups
    if (!validWindowIds || (!state._hadMinimizedWindows && !state._hadHiddenWindows)) {
        state.tabGroups = cleaned;
    }

    for (let grp of cleaned) {
        let leaderId = grp[0];
        if (state.focusedId !== null && state.focusedId !== undefined && grp.includes(state.focusedId)) {
            state.activeTabMap.set(leaderId, state.focusedId);
        } else {
            let curActive = state.activeTabMap.get(leaderId);
            if (!curActive || !grp.includes(curActive)) {
                state.activeTabMap.set(leaderId, leaderId);
            }
        }
    }

    return cleaned;
}

function findTabGroupForWindow(state, winId) {
    if (!state || !Array.isArray(state.tabGroups)) return null;
    for (let grp of state.tabGroups) {
        if (Array.isArray(grp) && grp.length >= 2 && grp.includes(winId)) {
            return grp;
        }
    }
    return null;
}

function getTabGroupLeaderId(state, winId) {
    let grp = findTabGroupForWindow(state, winId);
    return (grp && grp.length >= 2) ? grp[0] : winId;
}

function _transferLeaderBspAndWeights(state, oldLeaderId, newLeaderId, remainingGroup = null) {
    if (!state || oldLeaderId === newLeaderId || newLeaderId === undefined) return;
    if (state.bspTree && typeof state.bspTree.replaceWindowId === 'function') {
        state.bspTree.replaceWindowId(oldLeaderId, newLeaderId);
    }
    if (state.weights && state.weights.has(oldLeaderId)) {
        state.weights.set(newLeaderId, state.weights.get(oldLeaderId));
    }
    if (state.colWeights && state.colWeights.has(oldLeaderId)) {
        state.colWeights.set(newLeaderId, state.colWeights.get(oldLeaderId));
    }
    if (state.savedBspSnapshot && state.savedBspSnapshot.root) {
        let tmpTree = new BspTree();
        tmpTree.restore(state.savedBspSnapshot.root);
        if (tmpTree.replaceWindowId(oldLeaderId, newLeaderId)) {
            state.savedBspSnapshot.root = tmpTree.snapshot();
        }
    }
    if (state.activeTabMap) {
        let prevActive = state.activeTabMap.get(oldLeaderId);
        state.activeTabMap.delete(oldLeaderId);
        if (remainingGroup && remainingGroup.length >= 2) {
            if (prevActive && prevActive !== oldLeaderId && remainingGroup.includes(prevActive)) {
                state.activeTabMap.set(newLeaderId, prevActive);
            } else {
                state.activeTabMap.set(newLeaderId, newLeaderId);
            }
        }
    }
}

/**
 * Merges `sourceWinId` into a Manual Tab Group with `targetWinId`.
 * Returns the resulting tab group array `[leaderId, ...memberIds]`.
 */
function groupWindowsAsTabs(state, sourceWinId, targetWinId) {
    if (!state || sourceWinId === targetWinId) return null;
    if (!Array.isArray(state.tabGroups)) state.tabGroups = [];
    if (!(state.activeTabMap instanceof Map)) state.activeTabMap = new Map();

    let sourceGroup = findTabGroupForWindow(state, sourceWinId);
    let targetGroup = findTabGroupForWindow(state, targetWinId);

    if (sourceGroup && targetGroup && sourceGroup === targetGroup) {
        state.focusedId = sourceWinId;
        state.activeTabMap.set(targetGroup[0], sourceWinId);
        return targetGroup;
    }

    let mergedGroup;
    if (targetGroup && sourceGroup) {
        let oldSourceLeader = sourceGroup[0];
        for (let id of sourceGroup) {
            if (!targetGroup.includes(id)) targetGroup.push(id);
        }
        state.tabGroups = state.tabGroups.filter(g => g !== sourceGroup);
        state.activeTabMap.delete(oldSourceLeader);
        mergedGroup = targetGroup;
    } else if (targetGroup) {
        if (!targetGroup.includes(sourceWinId)) {
            targetGroup.push(sourceWinId);
        }
        mergedGroup = targetGroup;
    } else if (sourceGroup) {
        let wasLeader = (sourceGroup[0] === sourceWinId);
        let idx = sourceGroup.indexOf(sourceWinId);
        if (idx !== -1) sourceGroup.splice(idx, 1);
        let survivingSourceLeader = sourceGroup[0];
        if (wasLeader && survivingSourceLeader !== undefined) {
            _transferLeaderBspAndWeights(state, sourceWinId, survivingSourceLeader, sourceGroup);
        }
        if (sourceGroup.length < 2) {
            state.tabGroups = state.tabGroups.filter(g => g !== sourceGroup);
            if (survivingSourceLeader !== undefined) {
                state.activeTabMap.delete(survivingSourceLeader);
            }
        }
        mergedGroup = [targetWinId, sourceWinId];
        state.tabGroups.push(mergedGroup);
    } else {
        mergedGroup = [targetWinId, sourceWinId];
        state.tabGroups.push(mergedGroup);
    }

    let leaderId = mergedGroup[0];

    // Keep group members contiguous in windowOrder & fullWindowOrder right after leaderId
    const reorderContiguous = (arr) => {
        if (!Array.isArray(arr) || !arr.includes(leaderId)) return;
        let membersInArr = mergedGroup.filter(id => arr.includes(id));
        if (membersInArr.length < 2) return;
        let nonLeaderSet = new Set(membersInArr.slice(1));
        for (let i = arr.length - 1; i >= 0; i--) {
            if (nonLeaderSet.has(arr[i])) arr.splice(i, 1);
        }
        let lIdx = arr.indexOf(leaderId);
        if (lIdx !== -1) {
            arr.splice(lIdx + 1, 0, ...membersInArr.slice(1));
        }
    };
    reorderContiguous(state.windowOrder);
    reorderContiguous(state.fullWindowOrder);

    // Non-leader members share the leader's BSP leaf and weights
    if (state.bspTree) {
        for (let i = 1; i < mergedGroup.length; i++) {
            state.bspTree.remove(mergedGroup[i]);
        }
    }

    state.focusedId = sourceWinId;
    state.activeTabMap.set(leaderId, sourceWinId);
    return mergedGroup;
}

/**
 * Detaches `winId` from its Manual Tab Group so it becomes an independent tile next to the group.
 */
function ungroupWindowFromTabs(state, winId, settings = {}) {
    if (!state || !Array.isArray(state.tabGroups)) return false;
    let grp = findTabGroupForWindow(state, winId);
    if (!grp) return false;

    let wasLeader = (grp[0] === winId);
    let idx = grp.indexOf(winId);
    if (idx !== -1) grp.splice(idx, 1);

    let survivingLeaderId = grp[0];
    if (wasLeader && survivingLeaderId !== undefined) {
        _transferLeaderBspAndWeights(state, winId, survivingLeaderId, grp);
    }

    if (grp.length < 2) {
        state.tabGroups = state.tabGroups.filter(g => g !== grp);
        if (state.activeTabMap && survivingLeaderId !== undefined) {
            state.activeTabMap.delete(survivingLeaderId);
        }
    } else if (state.activeTabMap && survivingLeaderId !== undefined) {
        state.activeTabMap.set(survivingLeaderId, grp[0]);
    }

    if (survivingLeaderId !== undefined && state.bspTree) {
        let defaultRatio = Number.isFinite(settings.dwindleDefaultSplitRatioPct)
            ? (settings.dwindleDefaultSplitRatioPct / 100.0)
            : 0.50;
        state.bspTree.insertRelativeTo(winId, survivingLeaderId, 'right', defaultRatio);
    }

    state.focusedId = winId;
    return true;
}

/**
 * Cleanly detaches `winId` from `state` (tabGroups, orders, weights, BSP tree, saved snapshot)
 * while promoting the next tab-group member to leader if `winId` was the group leader.
 */
function detachWindowFromState(state, winId) {
    let changed = false;
    if (!state) return changed;

    let grp = findTabGroupForWindow(state, winId);
    if (grp) {
        changed = true;
        let wasLeader = (grp[0] === winId);
        let gIdx = grp.indexOf(winId);
        if (gIdx !== -1) grp.splice(gIdx, 1);
        let nextLeaderId = grp[0];
        if (wasLeader && nextLeaderId !== undefined) {
            _transferLeaderBspAndWeights(state, winId, nextLeaderId, grp);
        }
        if (grp.length < 2) {
            state.tabGroups = state.tabGroups.filter(g => g !== grp);
            if (state.activeTabMap && nextLeaderId !== undefined) {
                state.activeTabMap.delete(nextLeaderId);
            }
        }
    }

    if (Array.isArray(state.windowOrder)) {
        let idx = state.windowOrder.indexOf(winId);
        if (idx !== -1) {
            state.windowOrder.splice(idx, 1);
            changed = true;
        }
    }
    if (Array.isArray(state.fullWindowOrder)) {
        let fIdx = state.fullWindowOrder.indexOf(winId);
        if (fIdx !== -1) {
            state.fullWindowOrder.splice(fIdx, 1);
            changed = true;
        }
    }
    if (state.weights && state.weights.delete(winId)) changed = true;
    if (state.colWeights && state.colWeights.delete(winId)) changed = true;
    if (state.bspTree && state.bspTree.hasWindow && state.bspTree.hasWindow(winId)) {
        state.bspTree.remove(winId);
        changed = true;
    } else if (state.bspTree) {
        state.bspTree.remove(winId);
    }
    if (state.lastRects && state.lastRects.delete(winId)) changed = true;

    if (state.savedBspSnapshot && state.savedBspSnapshot.root) {
        if (Array.isArray(state.savedBspSnapshot.windowOrder)) {
            let sIdx = state.savedBspSnapshot.windowOrder.indexOf(winId);
            if (sIdx !== -1) {
                state.savedBspSnapshot.windowOrder.splice(sIdx, 1);
                changed = true;
            }
        }
        let tmpTree = new BspTree();
        tmpTree.restore(state.savedBspSnapshot.root);
        if (tmpTree.hasWindow(winId)) {
            tmpTree.remove(winId);
            state.savedBspSnapshot.root = tmpTree.snapshot();
            changed = true;
        }
    }

    return changed;
}

function _swapBlocksInOrderArray(arr, blockA, blockB) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    let setA = new Set(blockA);
    let setB = new Set(blockB);
    let seqA = arr.filter(id => setA.has(id));
    let seqB = arr.filter(id => setB.has(id));
    if (seqA.length === 0 || seqB.length === 0) return false;

    let emittedA = false;
    let emittedB = false;
    let next = [];
    for (let id of arr) {
        if (setA.has(id)) {
            if (!emittedA) {
                next.push(...seqB);
                emittedA = true;
            }
        } else if (setB.has(id)) {
            if (!emittedB) {
                next.push(...seqA);
                emittedB = true;
            }
        } else {
            next.push(id);
        }
    }
    arr.splice(0, arr.length, ...next);
    return true;
}

/**
 * Swaps two windows (or their containing Manual Tab Group blocks) coherently across
 * `tabGroups`, `windowOrder`, `fullWindowOrder`, and `bspTree`.
 */
function swapWindowIdsInState(state, idA, idB) {
    if (!state || idA === idB) return false;
    let grpA = findTabGroupForWindow(state, idA);
    let grpB = findTabGroupForWindow(state, idB);

    if (grpA && grpB && grpA === grpB) {
        let idxA = grpA.indexOf(idA);
        let idxB = grpA.indexOf(idB);
        if (idxA === -1 || idxB === -1) return false;
        let oldLeader = grpA[0];
        let tmp = grpA[idxA];
        grpA[idxA] = grpA[idxB];
        grpA[idxB] = tmp;
        let newLeader = grpA[0];
        if (newLeader !== oldLeader) {
            _transferLeaderBspAndWeights(state, oldLeader, newLeader, grpA);
        }
        _swapBlocksInOrderArray(state.windowOrder, [idA], [idB]);
        _swapBlocksInOrderArray(state.fullWindowOrder, [idA], [idB]);
        return true;
    }

    let repA = grpA ? grpA[0] : idA;
    let repB = grpB ? grpB[0] : idB;
    if (repA === repB) return false;

    let blockA = grpA ? grpA.slice() : [idA];
    let blockB = grpB ? grpB.slice() : [idB];
    let swapped = false;
    if (state.bspTree) {
        swapped = state.bspTree.swap(repA, repB) || swapped;
    }
    swapped = _swapBlocksInOrderArray(state.windowOrder, blockA, blockB) || swapped;
    swapped = _swapBlocksInOrderArray(state.fullWindowOrder, blockA, blockB) || swapped;
    return swapped;
}

/**
 * Inserts `winId` spatially relative to `targetWinId` (`'left'|'right'|'top'|'bottom'`)
 * without splitting a target Manual Tab Group in `windowOrder` or missing non-leader BSP leaves.
 */
function insertWindowRelativeInState(state, winId, targetWinId, side, defaultRatio = 0.5) {
    if (!state || winId === targetWinId) return false;

    let sourceGrp = findTabGroupForWindow(state, winId);
    let targetGrp = findTabGroupForWindow(state, targetWinId);
    if (sourceGrp && targetGrp && sourceGrp === targetGrp) {
        return false;
    }
    if (sourceGrp) {
        ungroupWindowFromTabs(state, winId, { dwindleDefaultSplitRatioPct: Math.round(defaultRatio * 100) });
        targetGrp = findTabGroupForWindow(state, targetWinId);
    }

    let effectiveTargetId = targetGrp ? targetGrp[0] : targetWinId;
    let insertBefore = (side === 'left' || side === 'top');

    const moveInArray = (arr) => {
        if (!Array.isArray(arr)) return;
        let curIdx = arr.indexOf(winId);
        if (curIdx !== -1) arr.splice(curIdx, 1);

        let anchorIds = targetGrp ? targetGrp : [targetWinId];
        if (insertBefore) {
            let firstIdx = arr.findIndex(id => anchorIds.includes(id));
            if (firstIdx !== -1) {
                arr.splice(firstIdx, 0, winId);
                return;
            }
        } else {
            let lastIdx = -1;
            for (let i = arr.length - 1; i >= 0; i--) {
                if (anchorIds.includes(arr[i])) {
                    lastIdx = i;
                    break;
                }
            }
            if (lastIdx !== -1) {
                arr.splice(lastIdx + 1, 0, winId);
                return;
            }
        }
        arr.push(winId);
    };

    moveInArray(state.windowOrder);
    moveInArray(state.fullWindowOrder);

    if (state.bspTree) {
        return state.bspTree.insertRelativeTo(winId, effectiveTargetId, side, defaultRatio);
    }
    return true;
}

/**
 * Dissolves the entire Manual Tab Group containing `winId` into independent tiles.
 */
function dissolveTabGroup(state, winId, settings = {}) {
    if (!state || !Array.isArray(state.tabGroups)) return false;
    let grp = findTabGroupForWindow(state, winId);
    if (!grp) return false;

    let members = grp.slice();
    let leaderId = members[0];
    state.tabGroups = state.tabGroups.filter(g => g !== grp);
    if (state.activeTabMap) state.activeTabMap.delete(leaderId);

    if (state.bspTree) {
        let defaultRatio = Number.isFinite(settings.dwindleDefaultSplitRatioPct)
            ? (settings.dwindleDefaultSplitRatioPct / 100.0)
            : 0.50;
        let anchorId = leaderId;
        for (let i = 1; i < members.length; i++) {
            state.bspTree.insertRelativeTo(members[i], anchorId, 'right', defaultRatio);
            anchorId = members[i];
        }
    }
    return true;
}

/**
 * Synchronizes `state.windowOrder` (currently visible tiled windows) and
 * `state.fullWindowOrder` (all tiled windows on the workspace/monitor, including
 * minimized / show-desktop windows) so that minimizing one or all windows (Super+D)
 * and restoring them preserves exact window ordering, BSP splits, weights, and focus
 * across all layouts.
 */
function syncWindowOrderWithMinimized(state, visibleTileableIds, minimizedTileableIds = [], fullscreenTileableIds = []) {
    if (!state) return [];

    let visibleArr = Array.from(visibleTileableIds || []);
    let minimizedArr = Array.from(minimizedTileableIds || []);
    let fullscreenArr = Array.from(fullscreenTileableIds || []);
    let visibleSet = new Set(visibleArr);
    let minimizedSet = new Set(minimizedArr);
    let hiddenSet = new Set([...minimizedArr, ...fullscreenArr]);
    let allKnownSet = new Set([...visibleArr, ...minimizedArr, ...fullscreenArr]);

    if (!Array.isArray(state.windowOrder)) {
        state.windowOrder = [];
    }
    if (!Array.isArray(state.fullWindowOrder) || state.fullWindowOrder.length === 0) {
        state.fullWindowOrder = state.windowOrder.slice();
    }

    // 1. Insert any newly added IDs in state.windowOrder (e.g. unshifted master or stack-top)
    //    into the corresponding position in state.fullWindowOrder.
    for (let i = 0; i < state.windowOrder.length; i++) {
        let id = state.windowOrder[i];
        if (!allKnownSet.has(id) || state.fullWindowOrder.includes(id)) continue;
        if (i === 0) {
            state.fullWindowOrder.unshift(id);
        } else {
            let prevId = state.windowOrder[i - 1];
            let prevIdx = state.fullWindowOrder.indexOf(prevId);
            if (prevIdx !== -1) {
                state.fullWindowOrder.splice(prevIdx + 1, 0, id);
            } else {
                state.fullWindowOrder.push(id);
            }
        }
    }

    // 2. Propagate any in-place reordering (swaps, master promotions) among windows in state.windowOrder
    //    into their corresponding slots in state.fullWindowOrder while keeping minimized/fullscreen windows in place.
    let activeInBoth = state.windowOrder.filter(id => allKnownSet.has(id) && state.fullWindowOrder.includes(id));
    if (activeInBoth.length >= 2) {
        let activeSet = new Set(activeInBoth);
        let slotIdx = 0;
        for (let i = 0; i < state.fullWindowOrder.length; i++) {
            if (activeSet.has(state.fullWindowOrder[i]) && slotIdx < activeInBoth.length) {
                state.fullWindowOrder[i] = activeInBoth[slotIdx++];
            }
        }
    }

    // 3. Prune closed / floated / moved windows and append any brand-new windows
    let seenFull = new Set();
    let nextFull = [];
    for (let id of state.fullWindowOrder) {
        if (allKnownSet.has(id) && !seenFull.has(id)) {
            seenFull.add(id);
            nextFull.push(id);
        }
    }
    for (let id of visibleArr) {
        if (!seenFull.has(id)) {
            seenFull.add(id);
            nextFull.push(id);
        }
    }
    for (let id of minimizedArr) {
        if (!seenFull.has(id)) {
            seenFull.add(id);
            nextFull.push(id);
        }
    }
    for (let id of fullscreenArr) {
        if (!seenFull.has(id)) {
            seenFull.add(id);
            nextFull.push(id);
        }
    }
    state.fullWindowOrder = nextFull;

    // 4. Filter visible order strictly according to fullWindowOrder
    let prunedOrder = state.fullWindowOrder.filter(id => visibleSet.has(id));
    state.windowOrder = prunedOrder;

    // 5. Track hidden (minimized + fullscreen) for tabGroup preservation, and restore
    //    saved BSP/focus snapshot specifically after minimize/Show Desktop exits.
    state._hadHiddenWindows = hiddenSet.size > 0;
    if (minimizedSet.size > 0) {
        state._hadMinimizedWindows = true;
    } else if (state._hadMinimizedWindows && prunedOrder.length > 0) {
        if (state.savedBspSnapshot && state.savedBspSnapshot.root && state.bspTree) {
            state.bspTree.restore(state.savedBspSnapshot.root);
        }
        if (state.savedFocusedId !== null && state.savedFocusedId !== undefined && visibleSet.has(state.savedFocusedId)) {
            state.focusedId = state.savedFocusedId;
        }
        if (Number.isFinite(state.savedScrollOffset)) {
            state.scrollOffset = state.savedScrollOffset;
        }
        state._hadMinimizedWindows = false;
        state._justRestoredFromMinimize = true;
    }

    return prunedOrder;
}

/**
 * Cleans up and renormalizes workspace layout state when `closedWinId` is closed so
 * surviving windows expand coherently without inheriting cross-axis or stale weights.
 */
function onWindowClosedStateCleanup(state, closedWinId, settings = {}) {
    if (!state) return;

    if (!detachWindowFromState(state, closedWinId)) {
        return;
    }

    let effectiveOrder = (Array.isArray(state.fullWindowOrder) &&
        state.fullWindowOrder.length > (Array.isArray(state.windowOrder) ? state.windowOrder.length : 0))
        ? state.fullWindowOrder
        : (Array.isArray(state.windowOrder) ? state.windowOrder : []);
    let n = effectiveOrder.length;
    if (n <= 1) {
        if (state.weights) state.weights.clear();
        if (state.colWeights) state.colWeights.clear();
        if (state.gridRowWeights) state.gridRowWeights.clear();
        state.centeredLeftRatio = null;
        state.centeredRightRatio = null;
        return;
    }

    let masterCount = clamp(state.masterCount || 1, 1, n);
    let cmCount = clamp(settings.centeredMasterCount || state.masterCount || 1, 1, n);

    if (state.layoutId === 'master-stack') {
        if (n <= masterCount) {
            if (state.weights) state.weights.clear();
            if (state.colWeights) normalizeSubgroupWeights(effectiveOrder, state.colWeights);
        } else {
            let masterIds = effectiveOrder.slice(0, masterCount);
            let stackIds = effectiveOrder.slice(masterCount);
            if (masterIds.length === 1 && state.weights) {
                state.weights.delete(masterIds[0]);
            } else if (masterIds.length > 1 && state.weights) {
                normalizeSubgroupWeights(masterIds, state.weights);
            }
            if (stackIds.length <= 1 && state.weights) {
                if (stackIds.length === 1) state.weights.delete(stackIds[0]);
            } else if (state.weights) {
                normalizeSubgroupWeights(stackIds, state.weights);
            }
        }
    } else if (state.layoutId === 'centered-master') {
        if (n <= cmCount + 1) {
            state.centeredLeftRatio = null;
            state.centeredRightRatio = null;
            let effMaster = (n === 2) ? 1 : clamp(cmCount, 1, n - 1);
            let masterIds = effectiveOrder.slice(0, effMaster);
            let stackIds = effectiveOrder.slice(effMaster);
            if (masterIds.length === 1 && state.weights) state.weights.delete(masterIds[0]);
            else if (masterIds.length > 1 && state.weights) normalizeSubgroupWeights(masterIds, state.weights);
            if (stackIds.length <= 1 && state.weights) {
                if (stackIds.length === 1) state.weights.delete(stackIds[0]);
            } else if (state.weights) {
                normalizeSubgroupWeights(stackIds, state.weights);
            }
        }
    } else if (state.layoutId === 'grid') {
        let maxCols = Number.isFinite(settings.gridMaxCols) && settings.gridMaxCols > 0
            ? clamp(settings.gridMaxCols, 1, 8)
            : 0;
        let cols = maxCols > 0 ? Math.min(n, maxCols) : Math.ceil(Math.sqrt(n));
        let rows = Math.ceil(n / cols);
        if (state.gridRowWeights) {
            if (rows <= 1) {
                state.gridRowWeights.clear();
            } else {
                for (let r of Array.from(state.gridRowWeights.keys())) {
                    if (r >= rows) state.gridRowWeights.delete(r);
                }
            }
        }
        if (state.colWeights) {
            for (let r = 0; r < rows; r++) {
                let rowIds = effectiveOrder.slice(r * cols, Math.min(n, (r + 1) * cols));
                if (rowIds.length <= 1) {
                    if (rowIds.length === 1) state.colWeights.delete(rowIds[0]);
                } else {
                    normalizeSubgroupWeights(rowIds, state.colWeights);
                }
            }
        }
    }
}

/**
 * Master dispatcher that computes window rectangles given workspace state and workarea
 */
function computeLayoutRects(layoutId, windowIds, rawWorkarea, state, settings, minSizes = null) {
    let n = windowIds.length;
    if (n === 0 || layoutId === 'floating') {
        return new Map();
    }

    let { area, innerGap, outerGap } = computeEffectiveWorkarea(rawWorkarea, n, settings, layoutId);

    let effectiveMinSizes = (settings.dwindleRespectMinSize !== false)
        ? (minSizes || state.minSizes || null)
        : null;

    // Collapse Manual Tab Groups into their leader window IDs for layout geometry calculation
    let activeTabGroups = (layoutId !== 'monocle') ? sanitizeTabGroups(state, windowIds) : [];
    let memberToLeader = new Map();
    let leaderToGroup = new Map();
    for (let grp of activeTabGroups) {
        let leaderId = grp[0];
        leaderToGroup.set(leaderId, grp);
        for (let i = 1; i < grp.length; i++) {
            memberToLeader.set(grp[i], leaderId);
        }
    }
    let effectiveWindowIds = memberToLeader.size > 0
        ? windowIds.filter(id => !memberToLeader.has(id))
        : windowIds;

    if (effectiveMinSizes && leaderToGroup.size > 0) {
        let mergedMins = new Map(effectiveMinSizes);
        for (let [leaderId, grp] of leaderToGroup.entries()) {
            let maxW = 0;
            let maxH = 0;
            for (let mId of grp) {
                let m = effectiveMinSizes.get(mId);
                if (m) {
                    if (Number.isFinite(m.minW) && m.minW > maxW) maxW = m.minW;
                    if (Number.isFinite(m.minH) && m.minH > maxH) maxH = m.minH;
                }
            }
            if (maxW > 0 || maxH > 0) {
                mergedMins.set(leaderId, { minW: maxW || 60, minH: maxH || 60 });
            }
        }
        effectiveMinSizes = mergedMins;
    }

    let effectiveFocusedId = (state.focusedId !== null && state.focusedId !== undefined && memberToLeader.has(state.focusedId))
        ? memberToLeader.get(state.focusedId)
        : state.focusedId;
    let effectiveLastFocusedId = (state.lastFocusedId !== null && state.lastFocusedId !== undefined && memberToLeader.has(state.lastFocusedId))
        ? memberToLeader.get(state.lastFocusedId)
        : state.lastFocusedId;

    let options = {
        innerGap,
        outerGap,
        masterCount: state.masterCount,
        masterRatio: state.masterRatio,
        masterOrientation: state.masterOrientation,
        masterSingleWindowWidthPct: settings.masterSingleWindowWidthPct || 100,
        centeredMasterRatio: Number.isFinite(state.centeredMasterRatio)
            ? state.centeredMasterRatio
            : ((settings.centeredMasterRatioPct || settings.masterRatioPct || 50) / 100.0),
        centeredLeftRatio: state.centeredLeftRatio,
        centeredRightRatio: state.centeredRightRatio,
        centeredMasterCount: settings.centeredMasterCount || state.masterCount || 1,
        centeredMasterSideBalance: settings.centeredMasterSideBalance || 'alternate',
        centeredMasterSingleWidthPct: settings.centeredMasterSingleWidthPct || 100,
        weights: state.weights,
        colWeights: state.colWeights,
        gridRowWeights: state.gridRowWeights,
        minSizes: effectiveMinSizes,
        scrollingColumnRatio: (settings.scrollingColumnWidthPct || 60) / 100.0,
        scrollingSingleColumnWidthPct: settings.scrollingSingleColumnWidthPct || 100,
        scrollingFocusAlignment: settings.scrollingFocusAlignment || 'edge',
        scrollingMinVisibleWidthPx: settings.scrollingMinVisibleWidthPx || 140,
        monocleZenWidthPct: settings.monocleZenWidthPct || 100,
        monocleZenHeightPct: settings.monocleZenHeightPct || 100,
        monocleOuterMarginPx: settings.monocleOuterMarginPx || 0,
        gridMaxCols: settings.gridMaxCols || 0,
        gridLastRowBehavior: settings.gridLastRowBehavior || 'stretch',
        overflowMinWidthPx: clamp(Number.isFinite(settings.overflowMinWidthPx) ? settings.overflowMinWidthPx : 220, 120, 600),
        overflowMinHeightPx: clamp(Number.isFinite(settings.overflowMinHeightPx) ? settings.overflowMinHeightPx : 150, 80, 400),
        focusedId: effectiveFocusedId,
        scrollOffset: state.scrollOffset || 0
    };

    let rects;
    switch (layoutId) {
        case 'dwindle': {
            state.bspTree.sync(effectiveWindowIds, effectiveLastFocusedId, {
                defaultSplitRatio: (settings.dwindleDefaultSplitRatioPct || 50) / 100.0,
                newWindowPlacement: settings.dwindleNewWindowPlacement || 'focused'
            });
            rects = state.bspTree.computeRects(
                area,
                innerGap,
                effectiveMinSizes,
                settings.dwindleSplitDirection || 'auto',
                options.overflowMinWidthPx,
                options.overflowMinHeightPx
            );
            break;
        }
        case 'master-stack':
            rects = computeMasterStack(effectiveWindowIds, area, options);
            break;
        case 'centered-master':
            rects = computeCenteredMaster(effectiveWindowIds, area, options);
            break;
        case 'scrolling': {
            let res = computeScrolling(effectiveWindowIds, area, options);
            state.scrollOffset = res.scrollOffset;
            rects = res.rects;
            break;
        }
        case 'monocle':
            rects = computeMonocle(windowIds, area, options);
            break;
        case 'grid':
            rects = computeGrid(effectiveWindowIds, area, options);
            break;
        default:
            rects = computeMasterStack(effectiveWindowIds, area, options);
            break;
    }

    if (leaderToGroup.size > 0 && rects) {
        let expandedRects = new Map();
        for (let id of windowIds) {
            if (leaderToGroup.has(id)) {
                let grp = leaderToGroup.get(id);
                let lRect = rects.get(id);
                if (lRect) {
                    expandedRects.set(id, {
                        ...lRect,
                        stacked: true,
                        manualTabGroup: true,
                        tabGroupLeaderId: id,
                        tabGroupIds: grp.slice()
                    });
                }
            } else if (memberToLeader.has(id)) {
                let leaderId = memberToLeader.get(id);
                let grp = leaderToGroup.get(leaderId);
                let lRect = rects.get(leaderId);
                if (lRect) {
                    expandedRects.set(id, {
                        ...lRect,
                        stacked: true,
                        manualTabGroup: true,
                        tabGroupLeaderId: leaderId,
                        tabGroupIds: grp ? grp.slice() : [leaderId, id]
                    });
                }
            } else if (rects.has(id)) {
                expandedRects.set(id, rects.get(id));
            }
        }
        rects = expandedRects;
    }

    if (!state._hadMinimizedWindows) {
        if (state.bspTree && state.bspTree.root) {
            state.savedBspSnapshot = {
                root: state.bspTree.snapshot(),
                windowOrder: effectiveWindowIds.slice()
            };
        }
        if (state.focusedId !== null && state.focusedId !== undefined) {
            state.savedFocusedId = state.focusedId;
        }
        state.savedScrollOffset = state.scrollOffset || 0;
    }

    return rects;
}

/**
 * Geometric Directional Navigation (Left / Right / Up / Down)
 */
function findDirectionalTarget(sourceId, sourceRect, candidates, direction) {
    let scx = sourceRect.x + sourceRect.width / 2;
    let scy = sourceRect.y + sourceRect.height / 2;

    let bestId = null;
    let bestScore = Infinity;

    for (let item of candidates) {
        if (item.id === sourceId) continue;
        let r = item.rect;
        let cx = r.x + r.width / 2;
        let cy = r.y + r.height / 2;

        let dx = cx - scx;
        let dy = cy - scy;

        if (direction === 'left' && dx >= -4) continue;
        if (direction === 'right' && dx <= 4) continue;
        if (direction === 'up' && dy >= -4) continue;
        if (direction === 'down' && dy <= 4) continue;

        let overlap = 0;
        let primaryDist = 0;
        let secondaryDist = 0;

        if (direction === 'left' || direction === 'right') {
            let top = Math.max(sourceRect.y, r.y);
            let bottom = Math.min(sourceRect.y + sourceRect.height, r.y + r.height);
            overlap = Math.max(0, bottom - top);
            primaryDist = (direction === 'left')
                ? Math.max(0, sourceRect.x - (r.x + r.width))
                : Math.max(0, r.x - (sourceRect.x + sourceRect.width));
            if (primaryDist === 0) primaryDist = Math.abs(dx) * 0.5;
            secondaryDist = Math.abs(dy);
        } else {
            let left = Math.max(sourceRect.x, r.x);
            let right = Math.min(sourceRect.x + sourceRect.width, r.x + r.width);
            overlap = Math.max(0, right - left);
            primaryDist = (direction === 'up')
                ? Math.max(0, sourceRect.y - (r.y + r.height))
                : Math.max(0, r.y - (sourceRect.y + sourceRect.height));
            if (primaryDist === 0) primaryDist = Math.abs(dy) * 0.5;
            secondaryDist = Math.abs(dx);
        }

        let overlapPenalty = (overlap > 0) ? 0 : 1200;
        let score = primaryDist + secondaryDist * 1.8 + overlapPenalty;

        if (score < bestScore) {
            bestScore = score;
            bestId = item.id;
        }
    }

    return bestId;
}

module.exports = {
    LAYOUTS,
    BspTree,
    clamp,
    snapRatioValue,
    getLayoutMeta,
    getNextLayoutId,
    computeEffectiveWorkarea,
    computeGridDimensions,
    computeMasterStack,
    computeCenteredMaster,
    computeScrolling,
    computeMonocle,
    computeGrid,
    computeLayoutRects,
    sanitizeTabGroups,
    findTabGroupForWindow,
    getTabGroupLeaderId,
    groupWindowsAsTabs,
    ungroupWindowFromTabs,
    dissolveTabGroup,
    detachWindowFromState,
    swapWindowIdsInState,
    insertWindowRelativeInState,
    syncWindowOrderWithMinimized,
    onWindowClosedStateCleanup,
    findDirectionalTarget
};
