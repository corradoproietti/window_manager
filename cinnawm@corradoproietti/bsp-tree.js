// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Binary Space Partitioning (BSP / Dwindle) Tree Engine
 *
 * Implements the dynamic binary tree used by the Dwindle / BSP layout:
 *  - Aspect-ratio smart splits & spiral/vertical/horizontal split modes
 *  - Interactive 1px-exact border resizing (`resizeEdge`) with sub-split compensation
 *  - Magnetic snap guides (`snapRatioValue` at 25%, 33%, 50%, 67%, 75%)
 *  - Relative edge insertion (`insertRelativeTo`) for drag-to-split
 *  - Persistent tree topology serialization across sessions (`serializeShape` / `restoreShape`)
 */

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function snapRatioValue(ratio, availSpan, snapTolerancePx = 10, targets = [0.25, 1 / 3, 0.50, 2 / 3, 0.75]) {
    if (!Number.isFinite(ratio) || !Number.isFinite(availSpan) || availSpan <= 0 || snapTolerancePx <= 0) {
        return { snapped: false, ratio, snappedPx: Math.round((availSpan || 0) * (ratio || 0)), snappedPct: null };
    }
    let currentPx = availSpan * ratio;
    let bestTarget = null;
    let bestDist = Infinity;
    for (let t of targets) {
        let targetPx = Math.round(availSpan * t);
        let dist = Math.abs(currentPx - targetPx);
        if (dist <= snapTolerancePx && dist < bestDist) {
            bestDist = dist;
            bestTarget = { snapped: true, ratio: targetPx / availSpan, snappedPx: targetPx, snappedPct: Math.round(t * 100) };
        }
    }
    return bestTarget || { snapped: false, ratio, snappedPx: Math.round(currentPx), snappedPct: null };
}

/**
 * Binary Space Partitioning (BSP / Dwindle) Tree
 * Each internal node: {
 *   type: 'split',
 *   dir: 'vertical' | 'horizontal',
 *   userRotated: boolean,
 *   ratio: 0.5,
 *   first: Node,
 *   second: Node
 * }
 *   - 'vertical' means a vertical split line (left / right children)
 *   - 'horizontal' means a horizontal split line (top / bottom children)
 * Each leaf node: { type: 'leaf', windowId: string|number }
 */
class BspTree {
    constructor() {
        this.root = null;
    }

    clear() {
        this.root = null;
    }

    resetRatios(ratio = 0.5) {
        const reset = node => {
            if (!node || node.type === 'leaf') return;
            node.ratio = clamp(ratio, 0.2, 0.8);
            node._effectiveDir = null;
            node._plannedDir = null;
            node._lastRect = null;
            node._availSpan = null;
            node._firstSpan = null;
            node._secondSpan = null;
            node._compensated = false;
            reset(node.first);
            reset(node.second);
        };
        reset(this.root);
    }

    serializeShape(windowOrder = []) {
        const serialize = node => {
            if (!node) return null;
            if (node.type === 'leaf') {
                let index = windowOrder.indexOf(node.windowId);
                return index < 0 ? null : { type: 'leaf', index };
            }
            return {
                type: 'split', dir: node.dir, userRotated: Boolean(node.userRotated),
                ratio: Number.isFinite(node.ratio) ? node.ratio : 0.5,
                first: serialize(node.first), second: serialize(node.second)
            };
        };
        return serialize(this.root);
    }

    restoreShape(shape, windowIds = []) {
        let used = new Set();
        const restore = node => {
            if (!node || typeof node !== 'object') return null;
            if (node.type === 'leaf') {
                if (!Number.isInteger(node.index) || node.index < 0 || node.index >= windowIds.length || used.has(node.index)) return null;
                used.add(node.index);
                return { type: 'leaf', windowId: windowIds[node.index] };
            }
            if (node.type !== 'split' || !['vertical', 'horizontal'].includes(node.dir)) return null;
            let first = restore(node.first);
            let second = restore(node.second);
            if (!first) return second;
            if (!second) return first;
            return {
                type: 'split', dir: node.dir, userRotated: Boolean(node.userRotated),
                ratio: clamp(Number.isFinite(node.ratio) ? node.ratio : 0.5, 0.05, 0.95),
                first, second
            };
        };
        this.root = restore(shape);
    }

    getLeafIds(node = this.root, out = []) {
        if (!node) return out;
        if (node.type === 'leaf') {
            out.push(node.windowId);
        } else {
            this.getLeafIds(node.first, out);
            this.getLeafIds(node.second, out);
        }
        return out;
    }

    hasWindow(windowId) {
        return this.getLeafIds().indexOf(windowId) !== -1;
    }

    /**
     * Synchronizes the tree with an ordered array of active tileable windowIds.
     * Preserves existing splits and custom ratios while inserting new windows and pruning closed ones.
     */
    sync(windowIds, targetFocusId = null, options = null) {
        if (this._pendingShape) {
            this.restoreShape(this._pendingShape, windowIds);
            this._pendingShape = null;
        }
        let desiredSet = new Set(windowIds);
        let existingIds = this.getLeafIds();

        // 1. Remove leaves no longer in windowIds
        for (let id of existingIds) {
            if (!desiredSet.has(id)) {
                this.remove(id);
            }
        }

        // 2. Find missing windows to insert
        let currentSet = new Set(this.getLeafIds());
        let missing = windowIds.filter(id => !currentSet.has(id));
        let defaultRatio = options && Number.isFinite(options.defaultSplitRatio)
            ? clamp(options.defaultSplitRatio, 0.2, 0.8)
            : 0.5;
        let placement = (options && options.newWindowPlacement) || 'focused';

        if (missing.length === 1) {
            let target = targetFocusId;
            if (placement === 'end') {
                target = null;
            } else if (placement === 'start') {
                let leaves = this.getLeafIds();
                target = leaves.length > 0 ? leaves[0] : null;
            }
            this.insert(missing[0], target, null, defaultRatio);
        } else if (missing.length > 1) {
            for (let id of missing) {
                this.insert(id, null, null, defaultRatio);
            }
        }
    }

    insert(windowId, targetWindowId = null, preferredDir = null, initialRatio = 0.5) {
        if (!this.root) {
            this.root = { type: 'leaf', windowId };
            return;
        }

        if (this.hasWindow(windowId)) {
            return;
        }

        let ratioVal = clamp(Number.isFinite(initialRatio) ? initialRatio : 0.5, 0.2, 0.8);
        let inserted = false;
        const splitTarget = (node, depth) => {
            if (!node) return null;
            if (node.type === 'leaf') {
                if (node.windowId === targetWindowId) {
                    let dir = preferredDir || (depth % 2 === 0 ? 'vertical' : 'horizontal');
                    inserted = true;
                    return {
                        type: 'split',
                        dir,
                        userRotated: Boolean(preferredDir),
                        ratio: ratioVal,
                        first: { type: 'leaf', windowId: node.windowId },
                        second: { type: 'leaf', windowId }
                    };
                }
                return node;
            }
            node.first = splitTarget(node.first, depth + 1);
            if (!inserted) {
                node.second = splitTarget(node.second, depth + 1);
            }
            return node;
        };

        if (targetWindowId !== null) {
            this.root = splitTarget(this.root, 0);
        }

        if (!inserted) {
            // Split the rightmost (last) leaf following Dwindle spiral
            const splitLast = (node, depth) => {
                if (node.type === 'leaf') {
                    let dir = preferredDir || (depth % 2 === 0 ? 'vertical' : 'horizontal');
                    return {
                        type: 'split',
                        dir,
                        userRotated: Boolean(preferredDir),
                        ratio: ratioVal,
                        first: { type: 'leaf', windowId: node.windowId },
                        second: { type: 'leaf', windowId }
                    };
                }
                node.second = splitLast(node.second, depth + 1);
                return node;
            };
            this.root = splitLast(this.root, 0);
        }
    }

    remove(windowId) {
        if (!this.root) return;
        const removeRec = (node) => {
            if (!node) return null;
            if (node.type === 'leaf') {
                return node.windowId === windowId ? null : node;
            }
            let first = removeRec(node.first);
            let second = removeRec(node.second);
            if (!first && !second) return null;
            if (!first || !second) {
                let survivor = first || second;
                let removedFirst = !first;
                if (survivor.type === 'split' && survivor._compensated) {
                    let parentDir = node._effectiveDir || node._autoDir || node.dir;
                    let survDir = survivor._effectiveDir || survivor._autoDir || survivor.dir;
                    if (parentDir === survDir &&
                        Number.isFinite(node._availSpan) &&
                        Number.isFinite(survivor._firstSpan) &&
                        Number.isFinite(survivor._secondSpan)) {
                        let newAvail = node._availSpan;
                        if (removedFirst) {
                            let fixedSecond = survivor._secondSpan;
                            let nextFirst = clamp(newAvail - fixedSecond, 60, Math.max(60, newAvail - 60));
                            survivor.ratio = clamp(nextFirst / newAvail, 0.05, 0.95);
                        } else {
                            let fixedFirst = survivor._firstSpan;
                            let nextFirst = clamp(fixedFirst, 60, Math.max(60, newAvail - 60));
                            survivor.ratio = clamp(nextFirst / newAvail, 0.05, 0.95);
                        }
                        survivor._availSpan = newAvail;
                        survivor._firstSpan = Math.round(newAvail * survivor.ratio);
                        survivor._secondSpan = newAvail - survivor._firstSpan;
                    }
                }
                if (node._lastRect && survivor.type === 'split') {
                    survivor._lastRect = { ...node._lastRect };
                }
                return survivor;
            }
            node.first = first;
            node.second = second;
            return node;
        };
        this.root = removeRec(this.root);
    }

    replaceWindowId(oldId, newId) {
        if (!this.root || oldId === newId) return false;
        const replaceRec = (node) => {
            if (!node) return false;
            if (node.type === 'leaf') {
                if (node.windowId === oldId) {
                    node.windowId = newId;
                    return true;
                }
                return false;
            }
            return replaceRec(node.first) || replaceRec(node.second);
        };
        return replaceRec(this.root);
    }

    swap(winIdA, winIdB) {
        if (winIdA === winIdB || !this.root) return false;
        let leafA = null;
        let leafB = null;
        const findLeaves = (node) => {
            if (!node) return;
            if (node.type === 'leaf') {
                if (node.windowId === winIdA) leafA = node;
                if (node.windowId === winIdB) leafB = node;
                return;
            }
            findLeaves(node.first);
            findLeaves(node.second);
        };
        findLeaves(this.root);
        if (leafA && leafB) {
            let tmp = leafA.windowId;
            leafA.windowId = leafB.windowId;
            leafB.windowId = tmp;
            return true;
        }
        return false;
    }

    /**
     * Moves or inserts `windowId` so it splits the leaf of `targetWindowId` on `side`
     * ('left', 'right', 'top', 'bottom') with `initialRatio`.
     */
    insertRelativeTo(windowId, targetWindowId, side = 'right', initialRatio = 0.5) {
        if (windowId === targetWindowId) return false;
        if (this.hasWindow(windowId)) {
            this.remove(windowId);
        }
        if (!this.root) {
            this.root = { type: 'leaf', windowId };
            return true;
        }
        let dir = (side === 'left' || side === 'right') ? 'vertical' : 'horizontal';
        let placeFirst = (side === 'left' || side === 'top');
        let ratioVal = clamp(Number.isFinite(initialRatio) ? initialRatio : 0.5, 0.2, 0.8);
        let inserted = false;

        const splitTarget = (node) => {
            if (!node) return null;
            if (node.type === 'leaf') {
                if (node.windowId === targetWindowId) {
                    inserted = true;
                    return {
                        type: 'split',
                        dir,
                        userRotated: true,
                        _autoDir: dir,
                        ratio: ratioVal,
                        first: placeFirst ? { type: 'leaf', windowId } : { type: 'leaf', windowId: node.windowId },
                        second: placeFirst ? { type: 'leaf', windowId: node.windowId } : { type: 'leaf', windowId }
                    };
                }
                return node;
            }
            node.first = splitTarget(node.first);
            if (!inserted) {
                node.second = splitTarget(node.second);
            }
            return node;
        };

        this.root = splitTarget(this.root);
        if (!inserted) {
            this.insert(windowId, null, dir, ratioVal);
        }
        return true;
    }

    /**
     * Rotates the split direction of the parent of windowId
     */
    rotateParent(windowId) {
        const rotateRec = (node) => {
            if (!node || node.type === 'leaf') return false;
            if ((node.first.type === 'leaf' && node.first.windowId === windowId) ||
                (node.second.type === 'leaf' && node.second.windowId === windowId)) {
                let currentDir = node._effectiveDir || node._autoDir || node.dir || 'vertical';
                node.dir = currentDir === 'vertical' ? 'horizontal' : 'vertical';
                node._autoDir = node.dir;
                node._effectiveDir = node.dir;
                node.userRotated = true;
                return true;
            }
            return rotateRec(node.first) || rotateRec(node.second);
        };
        return rotateRec(this.root);
    }

    /**
     * Adjusts the nearest ancestor split matching `splitDir` ('vertical' for width, 'horizontal' for height).
     */
    adjustSplit(windowId, splitDir, screenDeltaRatio) {
        if (!this.root || Math.abs(screenDeltaRatio) < 0.001) return false;

        let path = [];
        const findPath = (node) => {
            if (!node) return false;
            if (node.type === 'leaf') {
                return node.windowId === windowId;
            }
            path.push({ node, branch: 'first' });
            if (findPath(node.first)) return true;
            path.pop();

            path.push({ node, branch: 'second' });
            if (findPath(node.second)) return true;
            path.pop();
            return false;
        };

        if (!findPath(this.root)) return false;

        for (let i = path.length - 1; i >= 0; i--) {
            let step = path[i];
            let effectiveDir = step.node._effectiveDir || step.node.dir;
            if (effectiveDir === splitDir) {
                let signedDelta = (step.branch === 'second') ? -screenDeltaRatio : screenDeltaRatio;
                step.node.ratio = clamp(step.node.ratio + signedDelta, 0.15, 0.85);
                return true;
            }
        }
        return false;
    }

    snapshot() {
        const cloneRec = (node) => {
            if (!node) return null;
            if (node.type === 'leaf') {
                return { type: 'leaf', windowId: node.windowId };
            }
            return {
                type: 'split',
                dir: node.dir,
                userRotated: Boolean(node.userRotated),
                ratio: node.ratio,
                _autoDir: node._autoDir,
                _compensated: Boolean(node._compensated),
                _effectiveDir: node._effectiveDir,
                _plannedDir: node._plannedDir,
                _lastRect: node._lastRect ? { ...node._lastRect } : null,
                _availSpan: node._availSpan,
                _firstSpan: node._firstSpan,
                _secondSpan: node._secondSpan,
                first: cloneRec(node.first),
                second: cloneRec(node.second)
            };
        };
        return cloneRec(this.root);
    }

    restore(snapshotRoot) {
        this.root = snapshotRoot;
        this.root = this.snapshot();
    }

    _getSubtreeMinSpan(sub, dir, minSizesMap) {
        if (!sub) return 0;
        let cached = dir === 'vertical' ? (sub._minW || 0) : (sub._minH || 0);
        if (!(minSizesMap instanceof Map) || minSizesMap.size === 0) return cached;
        if (sub.type === 'leaf') {
            let entry = minSizesMap.get(sub.windowId);
            let explicit = entry ? (dir === 'vertical' ? (entry.minW || 0) : (entry.minH || 0)) : 0;
            return Math.max(cached, explicit);
        }
        let firstMin = this._getSubtreeMinSpan(sub.first, dir, minSizesMap);
        let secondMin = this._getSubtreeMinSpan(sub.second, dir, minSizesMap);
        let effDir = sub._effectiveDir || sub.dir;
        let combined = (effDir === dir) ? (firstMin + secondMin) : Math.max(firstMin, secondMin);
        return Math.max(cached, combined);
    }

    _getBranchBounds(node, dir, availSpan, constraints = null) {
        let minSizesMap = (constraints instanceof Map)
            ? constraints
            : (constraints && constraints.minSizes instanceof Map ? constraints.minSizes : null);
        let overflowMin = dir === 'vertical'
            ? (constraints && Number.isFinite(constraints.overflowMinWidth) ? constraints.overflowMinWidth : 60)
            : (constraints && Number.isFinite(constraints.overflowMinHeight) ? constraints.overflowMinHeight : 60);
        let baseMin = Math.max(60, Math.min(overflowMin, Math.floor(availSpan / 2)));
        let firstSubMin = this._getSubtreeMinSpan(node.first, dir, minSizesMap);
        let secondSubMin = this._getSubtreeMinSpan(node.second, dir, minSizesMap);
        let firstMin = Math.max(baseMin, firstSubMin);
        let secondMin = Math.max(baseMin, secondSubMin);
        if (firstMin + secondMin > availSpan) {
            firstMin = baseMin;
            secondMin = baseMin;
        }
        let minFirst = Math.min(firstMin, Math.max(60, availSpan - secondMin));
        let maxFirst = Math.max(minFirst, availSpan - secondMin);
        return { minFirst, maxFirst };
    }

    _compensateSplitNode(sub, targetDir, branchDelta, keepSide, constraints = null) {
        let subDir = sub._effectiveDir || sub.dir;
        if (subDir !== targetDir || !Number.isFinite(sub._availSpan)) return false;
        let newAvail = Math.max(120, sub._availSpan + branchDelta);
        let { minFirst, maxFirst } = this._getBranchBounds(sub, targetDir, newAvail, constraints);
        sub._compensated = true;
        if (keepSide === 'second') {
            let fixedSecond = Number.isFinite(sub._secondSpan) ? sub._secondSpan : Math.round(sub._availSpan * (1 - sub.ratio));
            let nextFirst = clamp(newAvail - fixedSecond, minFirst, maxFirst);
            sub.ratio = clamp(nextFirst / newAvail, 0.05, 0.95);
        } else {
            let fixedFirst = Number.isFinite(sub._firstSpan) ? sub._firstSpan : Math.round(sub._availSpan * sub.ratio);
            let nextFirst = clamp(fixedFirst, minFirst, maxFirst);
            sub.ratio = clamp(nextFirst / newAvail, 0.05, 0.95);
        }
        return true;
    }

    /**
     * Adjusts split when resizing a specific edge ('left', 'right', 'top', 'bottom') of `windowId`.
     * Uses exact pixel spans from the previous layout pass and compensates same-axis sub-splits
     * so only the two windows immediately sharing the dragged border change size.
     */
    resizeEdge(windowId, edge, deltaPixels, workarea, innerGap = 0, snapTolerancePx = 0, constraints = null) {
        this.lastSnappedPct = null;
        if (!this.root || Math.abs(deltaPixels) < 1) return false;

        let path = [];
        const findPath = (node) => {
            if (!node) return false;
            if (node.type === 'leaf') return node.windowId === windowId;
            path.push({ node, branch: 'first' });
            if (findPath(node.first)) return true;
            path.pop();
            path.push({ node, branch: 'second' });
            if (findPath(node.second)) return true;
            path.pop();
            return false;
        };
        if (!findPath(this.root)) return false;

        let rect = { x: workarea.x, y: workarea.y, width: workarea.width, height: workarea.height };
        for (let i = 0; i < path.length; i++) {
            let { node, branch } = path[i];
            if (!node._lastRect) {
                node._lastRect = { ...rect };
            }
            let dir = node._effectiveDir || (node.userRotated ? node.dir : (rect.width >= rect.height ? 'vertical' : 'horizontal'));
            node._effectiveDir = dir;

            if (dir === 'vertical') {
                let availW = Math.max(120, rect.width - innerGap);
                let firstW = Math.round(availW * node.ratio);
                if (!node._availSpan) {
                    node._availSpan = availW;
                    node._firstSpan = firstW;
                    node._secondSpan = availW - firstW;
                }
                if (branch === 'first') {
                    rect = { x: rect.x, y: rect.y, width: firstW, height: rect.height };
                } else {
                    rect = { x: rect.x + firstW + innerGap, y: rect.y, width: availW - firstW, height: rect.height };
                }
            } else {
                let availH = Math.max(120, rect.height - innerGap);
                let firstH = Math.round(availH * node.ratio);
                if (!node._availSpan) {
                    node._availSpan = availH;
                    node._firstSpan = firstH;
                    node._secondSpan = availH - firstH;
                }
                if (branch === 'first') {
                    rect = { x: rect.x, y: rect.y, width: rect.width, height: firstH };
                } else {
                    rect = { x: rect.x, y: rect.y + firstH + innerGap, width: rect.width, height: availH - firstH };
                }
            }
        }

        let targetIdx = -1;
        let targetDir = null;
        for (let i = path.length - 1; i >= 0; i--) {
            let { node, branch } = path[i];
            let dir = node._effectiveDir || node.dir;
            if ((edge === 'right' && dir === 'vertical' && branch === 'first') ||
                (edge === 'left' && dir === 'vertical' && branch === 'second') ||
                (edge === 'bottom' && dir === 'horizontal' && branch === 'first') ||
                (edge === 'top' && dir === 'horizontal' && branch === 'second')) {
                targetIdx = i;
                targetDir = dir;
                break;
            }
        }

        if (targetIdx === -1) return false;

        let pivot = path[targetIdx].node;
        let pivotBranch = path[targetIdx].branch;
        let availSpan = pivot._availSpan || Math.max(120, (targetDir === 'vertical' ? pivot._lastRect.width : pivot._lastRect.height) - innerGap);
        let oldFirst = Number.isFinite(pivot._firstSpan) ? pivot._firstSpan : Math.round(availSpan * pivot.ratio);
        let { minFirst, maxFirst } = this._getBranchBounds(pivot, targetDir, availSpan, constraints);
        let newFirst = clamp(oldFirst + deltaPixels, minFirst, maxFirst);
        if (snapTolerancePx > 0) {
            let snapRes = snapRatioValue(newFirst / availSpan, availSpan, snapTolerancePx);
            if (snapRes.snappedPct !== null) {
                newFirst = clamp(snapRes.snappedPx, minFirst, maxFirst);
                this.lastSnappedPct = (pivotBranch === 'first') ? snapRes.snappedPct : (100 - snapRes.snappedPct);
            }
        }
        let actualDelta = newFirst - oldFirst;
        if (Math.abs(actualDelta) < 1) return false;

        pivot.ratio = clamp(newFirst / availSpan, 0.05, 0.95);

        let signedBranchDelta = (pivotBranch === 'first') ? actualDelta : -actualDelta;
        for (let j = targetIdx + 1; j < path.length; j++) {
            let sub = path[j].node;
            let subBranch = path[j].branch;
            this._compensateSplitNode(sub, targetDir, signedBranchDelta, subBranch === 'first' ? 'second' : 'first', constraints);
        }

        let oppDelta = (pivotBranch === 'first') ? -actualDelta : actualDelta;
        let oppNode = (pivotBranch === 'first') ? pivot.second : pivot.first;
        let nearBranchOnOpp = (pivotBranch === 'first') ? 'first' : 'second';
        while (oppNode && oppNode.type === 'split') {
            if (!this._compensateSplitNode(oppNode, targetDir, oppDelta, nearBranchOnOpp === 'first' ? 'second' : 'first', constraints)) {
                break;
            }
            oppNode = (nearBranchOnOpp === 'first') ? oppNode.first : oppNode.second;
        }

        return true;
    }

    computeRects(area, innerGap, minSizes = null, splitMode = 'auto', overflowMinWidth = 220, overflowMinHeight = 150) {
        let result = new Map();
        if (!this.root) return result;
        let hasExplicitMin = Boolean(minSizes && typeof minSizes.size === 'number' && minSizes.size > 0);

        const chooseSplitDir = (node, box, depth) => {
            if (node.userRotated) return node.dir;
            if (splitMode === 'vertical') return 'vertical';
            if (splitMode === 'horizontal') return 'horizontal';
            if (splitMode === 'spiral') return (depth % 2 === 0) ? 'vertical' : 'horizontal';
            if (!node._autoDir) {
                node._autoDir = (box.width >= box.height) ? 'vertical' : 'horizontal';
            }
            return node._autoDir;
        };

        const computeMinSizes = (node, box, depth = 0) => {
            if (!node) return { minW: 60, minH: 60 };
            if (node.type === 'leaf') {
                let ms = minSizes && minSizes.get(node.windowId);
                node._minW = ms && ms.minW ? Math.max(60, Math.round(ms.minW)) : 60;
                node._minH = ms && ms.minH ? Math.max(60, Math.round(ms.minH)) : 60;
                return { minW: node._minW, minH: node._minH };
            }

            let dir = chooseSplitDir(node, box, depth);
            let ratio = clamp(node.ratio || 0.5, 0.05, 0.95);
            let firstBox, secondBox;

            if (dir === 'vertical') {
                let gap = Math.min(innerGap, Math.max(0, box.width - 1));
                let availW = Math.max(0, box.width - gap);
                let firstW = Math.round(availW * ratio);
                firstBox = { x: box.x, y: box.y, width: firstW, height: box.height };
                secondBox = { x: box.x + firstW + gap, y: box.y, width: availW - firstW, height: box.height };
            } else {
                let gap = Math.min(innerGap, Math.max(0, box.height - 1));
                let availH = Math.max(0, box.height - gap);
                let firstH = Math.round(availH * ratio);
                firstBox = { x: box.x, y: box.y, width: box.width, height: firstH };
                secondBox = { x: box.x, y: box.y + firstH + gap, width: box.width, height: availH - firstH };
            }

            let firstMin = computeMinSizes(node.first, firstBox, depth + 1);
            let secondMin = computeMinSizes(node.second, secondBox, depth + 1);

            if (!node.userRotated && hasExplicitMin) {
                let gapW = Math.min(innerGap, Math.max(0, box.width - 1));
                let gapH = Math.min(innerGap, Math.max(0, box.height - 1));
                let reqW_V = firstMin.minW + secondMin.minW + gapW;
                let reqH_H = firstMin.minH + secondMin.minH + gapH;
                let overflowV = reqW_V / Math.max(1, box.width);
                let overflowH = reqH_H / Math.max(1, box.height);

                if (dir === 'vertical' && reqW_V > box.width &&
                    (reqH_H <= box.height || overflowH < overflowV)) {
                    dir = 'horizontal';
                    let gap = gapH;
                    let availH = Math.max(0, box.height - gap);
                    let firstH = Math.round(availH * ratio);
                    firstBox = { x: box.x, y: box.y, width: box.width, height: firstH };
                    secondBox = { x: box.x, y: box.y + firstH + gap, width: box.width, height: availH - firstH };
                    firstMin = computeMinSizes(node.first, firstBox, depth + 1);
                    secondMin = computeMinSizes(node.second, secondBox, depth + 1);
                } else if (dir === 'horizontal' && reqH_H > box.height &&
                           (reqW_V <= box.width || overflowV < overflowH)) {
                    dir = 'vertical';
                    let gap = gapW;
                    let availW = Math.max(0, box.width - gap);
                    let firstW = Math.round(availW * ratio);
                    firstBox = { x: box.x, y: box.y, width: firstW, height: box.height };
                    secondBox = { x: box.x + firstW + gap, y: box.y, width: availW - firstW, height: box.height };
                    firstMin = computeMinSizes(node.first, firstBox, depth + 1);
                    secondMin = computeMinSizes(node.second, secondBox, depth + 1);
                }
            }

            node._plannedDir = dir;
            if (dir === 'vertical') {
                node._minW = firstMin.minW + secondMin.minW + Math.min(innerGap, Math.max(0, box.width - 1));
                node._minH = Math.max(firstMin.minH, secondMin.minH);
            } else {
                node._minW = Math.max(firstMin.minW, secondMin.minW);
                node._minH = firstMin.minH + secondMin.minH + Math.min(innerGap, Math.max(0, box.height - 1));
            }
            return { minW: node._minW, minH: node._minH };
        };

        computeMinSizes(this.root, area, 0);

        const stackSubtree = (node, box) => {
            if (!node) return;
            if (node.type === 'leaf') {
                result.set(node.windowId, {
                    x: Math.round(box.x), y: Math.round(box.y),
                    width: Math.max(0, Math.round(box.width)),
                    height: Math.max(0, Math.round(box.height)), stacked: true
                });
                return;
            }
            stackSubtree(node.first, box);
            stackSubtree(node.second, box);
        };

        const visit = (node, box, depth = 0) => {
            if (!node) return;
            if (node.type === 'leaf') {
                result.set(node.windowId, {
                    x: Math.round(box.x),
                    y: Math.round(box.y),
                    width: Math.max(0, Math.round(box.width)),
                    height: Math.max(0, Math.round(box.height))
                });
                return;
            }

            if (box.width < overflowMinWidth || box.height < overflowMinHeight) {
                stackSubtree(node, box);
                return;
            }

            let dir = node._plannedDir || chooseSplitDir(node, box, depth);
            node._effectiveDir = dir;
            node._lastRect = { ...box };

            let ratio = clamp(node.ratio || 0.5, 0.05, 0.95);

            if (dir === 'vertical') {
                let gap = Math.min(innerGap, Math.max(0, box.width - 1));
                let availW = Math.max(0, box.width - gap);
                if (availW < 2 * overflowMinWidth) {
                    stackSubtree(node, box);
                    return;
                }
                let firstW = Math.round(availW * ratio);
                firstW = clamp(firstW, overflowMinWidth, availW - overflowMinWidth);
                let firstMinW = (node.first && node.first._minW) || 1;
                let secondMinW = (node.second && node.second._minW) || 1;
                if (availW >= firstMinW + secondMinW) {
                    firstW = clamp(firstW, firstMinW, availW - secondMinW);
                } else if (hasExplicitMin) {
                    stackSubtree(node, box);
                    return;
                } else if (firstMinW + secondMinW > 0) {
                    firstW = clamp(Math.round(availW * (firstMinW / (firstMinW + secondMinW))), 0, availW);
                }
                if (firstW < overflowMinWidth || availW - firstW < overflowMinWidth) {
                    stackSubtree(node, box);
                    return;
                }
                let secondW = availW - firstW;
                node._availSpan = availW;
                node._firstSpan = firstW;
                node._secondSpan = secondW;
                visit(node.first, {
                    x: box.x,
                    y: box.y,
                    width: firstW,
                    height: box.height
                }, depth + 1);
                visit(node.second, {
                    x: box.x + firstW + gap,
                    y: box.y,
                    width: secondW,
                    height: box.height
                }, depth + 1);
            } else {
                let gap = Math.min(innerGap, Math.max(0, box.height - 1));
                let availH = Math.max(0, box.height - gap);
                if (availH < 2 * overflowMinHeight) {
                    stackSubtree(node, box);
                    return;
                }
                let firstH = Math.round(availH * ratio);
                firstH = clamp(firstH, overflowMinHeight, availH - overflowMinHeight);
                let firstMinH = (node.first && node.first._minH) || 1;
                let secondMinH = (node.second && node.second._minH) || 1;
                if (availH >= firstMinH + secondMinH) {
                    firstH = clamp(firstH, firstMinH, availH - secondMinH);
                } else if (hasExplicitMin) {
                    stackSubtree(node, box);
                    return;
                } else if (firstMinH + secondMinH > 0) {
                    firstH = clamp(Math.round(availH * (firstMinH / (firstMinH + secondMinH))), 0, availH);
                }
                if (firstH < overflowMinHeight || availH - firstH < overflowMinHeight) {
                    stackSubtree(node, box);
                    return;
                }
                let secondH = availH - firstH;
                node._availSpan = availH;
                node._firstSpan = firstH;
                node._secondSpan = secondH;
                visit(node.first, {
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: firstH
                }, depth + 1);
                visit(node.second, {
                    x: box.x,
                    y: box.y + firstH + gap,
                    width: box.width,
                    height: secondH
                }, depth + 1);
            }
        };

        visit(this.root, area, 0);
        return result;
    }
}

module.exports = {
    BspTree,
    clamp,
    snapRatioValue
};
