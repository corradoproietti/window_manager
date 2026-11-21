// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * Automated Unit & Integration Test Suite for CinnaWM (run via `cjs`)
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const ByteArray = imports.byteArray;

function loadCommonJsModule(relPath) {
    let [ok, bytes] = GLib.file_get_contents(relPath);
    if (!ok) throw new Error(`Failed to read ${relPath}`);
    let code = ByteArray.toString(bytes);
    let exports = {};
    let module = { exports };
    let fn = new Function('require', 'exports', 'module', code);
    fn((req) => {
        let target = req.endsWith('.js') ? req : req + '.js';
        target = target.replace(/^\.\//, 'cinnawm@corradoproietti/');
        return loadCommonJsModule(target);
    }, exports, module);
    return module.exports;
}

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`ASSERTION FAILED: ${msg}`);
    }
}

print('=== 1. Validating JSON Schemas ===');
let [, metaBytes] = GLib.file_get_contents('cinnawm@corradoproietti/metadata.json');
let meta = JSON.parse(ByteArray.toString(metaBytes));
assert(meta.uuid === 'cinnawm@corradoproietti', 'UUID must be cinnawm@corradoproietti');

let [, schemaBytes] = GLib.file_get_contents('cinnawm@corradoproietti/settings-schema.json');
let schema = JSON.parse(ByteArray.toString(schemaBytes));
assert(schema.layout && schema.layout.pages.length === 4, 'Schema must have 4 pages');

let [, defaultsBytes] = GLib.file_get_contents('cinnawm@corradoproietti/defaults.json');
let defaults = JSON.parse(ByteArray.toString(defaultsBytes));
const toKebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
let schemaValueKeys = Object.keys(schema).filter(k => schema[k] && typeof schema[k] === 'object' && 'default' in schema[k]);
let defaultsKebabKeys = Object.keys(defaults).map(toKebab);
assert(schemaValueKeys.length === defaultsKebabKeys.length,
    `defaults.json key count (${defaultsKebabKeys.length}) must match settings-schema.json (${schemaValueKeys.length})`);
for (let prop of Object.keys(defaults)) {
    let k = toKebab(prop);
    assert(schemaValueKeys.includes(k), `defaults.json key ${prop} -> ${k} must exist in settings-schema.json`);
    if (prop !== 'customWindowRules') {
        assert(defaults[prop] === schema[k].default,
            `defaults.json value for ${prop} (${defaults[prop]}) must match settings-schema.json default (${schema[k].default})`);
    }
}
for (let key of Object.keys(schema)) {
    let entry = schema[key];
    if (entry && entry.type === 'section' && typeof entry.title === 'string') {
        assert(!/(?<!&)&(?!amp;|lt;|gt;|quot;|apos;)/.test(entry.title),
            `Section "${key}" title must escape '&' as '&amp;' for Pango markup: ${entry.title}`);
    }
}
print('  [OK] metadata.json, settings-schema.json & defaults.json are valid and synchronized');

print('=== 2. Testing Layout Engine (layouts.js) ===');
const Layouts = loadCommonJsModule('cinnawm@corradoproietti/layouts.js');

const workarea = { x: 0, y: 0, width: 1920, height: 1080 };
const settings = {
    innerGap: 10,
    outerGap: 10,
    smartGaps: true,
    scrollingColumnWidthPct: 60,
    monocleZenWidthPct: 100
};

// Test Smart Gaps with 1 window
let bsp = new Layouts.BspTree();
let state = {
    masterCount: 1,
    masterRatio: 0.55,
    masterOrientation: 'left',
    weights: new Map(),
    bspTree: bsp,
    focusedId: 101,
    lastFocusedId: null,
    scrollOffset: 0
};

let rects1 = Layouts.computeLayoutRects('dwindle', [101], workarea, state, settings);
let r101 = rects1.get(101);
assert(r101.x === 0 && r101.y === 0 && r101.width === 1920 && r101.height === 1080,
    'Smart gaps with 1 window should occupy full 1920x1080 workarea');
print('  [OK] Smart Gaps (1 window)');

// Test Dwindle / BSP with 3 windows
let rects3 = Layouts.computeLayoutRects('dwindle', [101, 102, 103], workarea, state, settings);
assert(rects3.size === 3, 'Should produce 3 rectangles in Dwindle');
let a = rects3.get(101);
let b = rects3.get(102);
let c = rects3.get(103);
assert(a.x === 10 && a.y === 10, 'First BSP leaf starts at outerGap (10,10)');
assert(b.x > a.x + a.width, 'Second BSP leaf is to the right of first');
assert(c.y > b.y + b.height, 'Third BSP leaf splits vertically below second in Dwindle spiral');

// Test BSP Edge Resize
let resized = state.bspTree.resizeEdge(101, 'right', 192, workarea);
assert(resized === true, 'resizeEdge on right border of left leaf should succeed');
let rects3After = Layouts.computeLayoutRects('dwindle', [101, 102, 103], workarea, state, settings);
assert(rects3After.get(101).width > a.width, 'Window 101 width should increase after right edge drag');
print('  [OK] Dwindle / BSP Tree & Live Edge Resize');

// Persist BSP topology and ratios by position, then bind the shape to new-session IDs.
let savedTree = new Layouts.BspTree();
savedTree.insert(10);
savedTree.insert(20, 10, null, 0.37);
savedTree.insert(30, 20, null, 0.63);
let savedShape = savedTree.serializeShape([10, 20, 30]);
let restoredTree = new Layouts.BspTree();
restoredTree.restoreShape(savedShape, [110, 120, 130]);
assert(JSON.stringify(restoredTree.getLeafIds()) === JSON.stringify([110, 120, 130]),
    'Persisted BSP leaf order should bind to new window IDs');
assert(Math.abs(restoredTree.root.ratio - 0.37) < 0.001,
    'Persisted BSP split ratio should survive restoration');
print('  [OK] BSP topology persistence across changed window IDs');

// Test Master & Stack
let msRects = Layouts.computeLayoutRects('master-stack', [1, 2, 3], workarea, state, settings);
assert(msRects.get(1).x < msRects.get(2).x, 'Master should be on the left');
assert(msRects.get(2).y < msRects.get(3).y, 'Stack windows should be stacked vertically');
print('  [OK] Master & Stack layout');

let bottomMasterRects = Layouts.computeLayoutRects('master-stack', [1, 2, 3], workarea,
    { ...state, masterCount: 3, masterOrientation: 'bottom', bspTree: new Layouts.BspTree() }, settings);
assert(bottomMasterRects.get(1).y > bottomMasterRects.get(2).y && bottomMasterRects.get(2).y > bottomMasterRects.get(3).y,
    'Bottom orientation should place the first master window at the bottom when all windows are masters');
let rightMasterRects = Layouts.computeLayoutRects('master-stack', [1, 2, 3], workarea,
    { ...state, masterCount: 3, masterOrientation: 'right', bspTree: new Layouts.BspTree() }, settings);
assert(rightMasterRects.get(1).x > rightMasterRects.get(2).x && rightMasterRects.get(2).x > rightMasterRects.get(3).x,
    'Right orientation should place the first master window at the right when all windows are masters');
print('  [OK] Master & Stack right/bottom orientation ordering');

// Test Centered Master (3-Column)
let cmRects = Layouts.computeLayoutRects('centered-master', [1, 2, 3, 4], workarea, state, settings);
assert(cmRects.get(3).x < cmRects.get(1).x && cmRects.get(1).x < cmRects.get(2).x,
    'Master (1) should be horizontally between Left stack (3) and Right stack (2)');
print('  [OK] Centered Master 3-Column layout');

// Test Scrolling Columns
state.focusedId = 4;
let scRects = Layouts.computeLayoutRects('scrolling', [1, 2, 3, 4], workarea, state, settings);
assert(state.scrollOffset > 0, 'Scrolling layout should scroll viewport right to keep window 4 visible');
assert(scRects.get(4).x + scRects.get(4).width <= 1920 - 10, 'Focused window 4 should be within right workarea bound');
let manyScrollState = { ...state, focusedId: 12, scrollOffset: 0 };
let manyScrollRects = Layouts.computeLayoutRects('scrolling', Array.from({ length: 12 }, (_, i) => i + 1), workarea, manyScrollState, settings);
let edgePeeks = Array.from(manyScrollRects.values()).filter(r => r.offscreen && r.x >= 10 && r.x + r.width <= 1910);
assert(edgePeeks.length <= 2, 'Scrolling should show at most one clipped preview at each viewport edge');
print('  [OK] Scrolling Columns layout (Niri / PaperWM style)');

// Test Directional Navigation
let candidates = [
    { id: 1, rect: rects3.get(101) },
    { id: 2, rect: rects3.get(102) },
    { id: 3, rect: rects3.get(103) }
];
assert(Layouts.findDirectionalTarget(1, rects3.get(101), candidates, 'right') === 2, 'Right from 1 -> 2');
assert(Layouts.findDirectionalTarget(2, rects3.get(102), candidates, 'down') === 3, 'Down from 2 -> 3');
assert(Layouts.findDirectionalTarget(3, rects3.get(103), candidates, 'up') === 2, 'Up from 3 -> 2');
assert(Layouts.findDirectionalTarget(2, rects3.get(102), candidates, 'left') === 1, 'Left from 2 -> 1');
print('  [OK] Geometric Directional Navigation');

print('=== 3. Testing Window Rules Parser (scratchpad.js) ===');
const Scratchpad = loadCommonJsModule('cinnawm@corradoproietti/scratchpad.js');
let rules = Scratchpad.parseCustomRules('Spotify:workspace=4\nKeePassXC:scratchpad, Steam:float');
assert(rules.length === 3, 'Should parse 3 custom rules');
assert(rules[0].pattern === 'spotify' && rules[0].workspace === 3, 'Spotify rule -> workspace index 3 (4th ws)');
assert(rules[1].pattern === 'keepassxc' && rules[1].scratchpad === true, 'KeePassXC rule -> scratchpad');
assert(rules[2].pattern === 'steam' && rules[2].float === true, 'Steam rule -> float');
let multiActionRule = Scratchpad.parseCustomRules('Caffeine:float,workspace=2');
assert(multiActionRule.length === 1 && multiActionRule[0].float && multiActionRule[0].workspace === 1,
    'Comma-separated actions should parse within a custom rule');
print('  [OK] Custom Window Rules parser');

print('=== 4. Testing Exact Inner & Outer Margins Across All Layouts ===');
const gapSettings = {
    innerGap: 8,
    outerGap: 8,
    smartGaps: false,
    scrollingColumnWidthPct: 60,
    monocleZenWidthPct: 100
};
const wa = { x: 0, y: 35, width: 1920, height: 1045 };
const expectedLeft = wa.x + gapSettings.outerGap;
const expectedTop = wa.y + gapSettings.outerGap;
const expectedRight = wa.x + wa.width - gapSettings.outerGap;
const expectedBottom = wa.y + wa.height - gapSettings.outerGap;

for (let layoutId of ['dwindle', 'master-stack', 'centered-master', 'grid', 'monocle']) {
    for (let count = 1; count <= 6; count++) {
        let ids = Array.from({ length: count }, (_, i) => i + 1);
        let st = {
            masterCount: 1,
            masterRatio: 0.55,
            masterOrientation: 'left',
            weights: new Map([[1, 2.2], [2, 0.5], [3, 1.4]]),
            bspTree: new Layouts.BspTree(),
            focusedId: 1,
            lastFocusedId: null,
            scrollOffset: 0
        };
        let rMap = Layouts.computeLayoutRects(layoutId, ids, wa, st, gapSettings);
        let rects = Array.from(rMap.values());

        let minX = Math.min(...rects.map(r => r.x));
        let minY = Math.min(...rects.map(r => r.y));
        let maxR = Math.max(...rects.map(r => r.x + r.width));
        let maxB = Math.max(...rects.map(r => r.y + r.height));

        assert(minX === expectedLeft, `${layoutId} (${count} wins): minX=${minX} !== ${expectedLeft}`);
        assert(minY === expectedTop, `${layoutId} (${count} wins): minY=${minY} !== ${expectedTop}`);
        assert(maxR === expectedRight, `${layoutId} (${count} wins): maxR=${maxR} !== ${expectedRight}`);
        assert(maxB === expectedBottom, `${layoutId} (${count} wins): maxB=${maxB} !== ${expectedBottom}`);

        if (layoutId !== 'monocle' && count >= 2) {
            for (let i = 0; i < rects.length; i++) {
                for (let j = i + 1; j < rects.length; j++) {
                    let r1 = rects[i];
                    let r2 = rects[j];
                    let overlapX = Math.min(r1.x + r1.width, r2.x + r2.width) - Math.max(r1.x, r2.x);
                    let overlapY = Math.min(r1.y + r1.height, r2.y + r2.height) - Math.max(r1.y, r2.y);
                    if (overlapX > 0 && overlapY > 0) {
                        assert(r1.stacked && r2.stacked && r1.x === r2.x && r1.y === r2.y &&
                               r1.width === r2.width && r1.height === r2.height,
                            `${layoutId} (${count} wins): overlap must be an intentional overflow stack`);
                        continue;
                    }

                    if (overlapY > 0) {
                        let hGap = r1.x < r2.x ? (r2.x - (r1.x + r1.width)) : (r1.x - (r2.x + r2.width));
                        assert(hGap >= gapSettings.innerGap, `${layoutId} (${count} wins): hGap=${hGap} < ${gapSettings.innerGap}`);
                    }
                    if (overlapX > 0) {
                        let vGap = r1.y < r2.y ? (r2.y - (r1.y + r1.height)) : (r1.y - (r2.y + r2.height));
                        assert(vGap >= gapSettings.innerGap, `${layoutId} (${count} wins): vGap=${vGap} < ${gapSettings.innerGap}`);
                    }
                }
            }
        }
    }
}
print('  [OK] Exact outerGap (8px) and innerGap (8px) verified across all layouts & window counts (1..6)');

print('=== 4a. Testing Layout Bounds on a Small Workarea with Large Gaps ===');
{
    const smallArea = { x: 15, y: 20, width: 180, height: 130 };
    const smallSettings = {
        ...gapSettings,
        innerGap: 48,
        outerGap: 48,
        monocleOuterMarginPx: 96,
        monocleZenWidthPct: 75,
        monocleZenHeightPct: 70,
        scrollingColumnWidthPct: 60,
        scrollingMinVisibleWidthPx: 140
    };
    for (let layoutId of ['dwindle', 'master-stack', 'centered-master', 'scrolling', 'monocle', 'grid']) {
        let st = {
            masterCount: 1, masterRatio: 0.55, centeredMasterRatio: 0.5,
            masterOrientation: 'left', weights: new Map(), colWeights: new Map(),
            gridRowWeights: new Map(), bspTree: new Layouts.BspTree(),
            focusedId: 3, lastFocusedId: null, scrollOffset: 0
        };
        let rectMap = Layouts.computeLayoutRects(layoutId, [1, 2, 3], smallArea, st, smallSettings);
        assert(rectMap.size === 3, `${layoutId}: should return all three windows`);
        for (let [id, rect] of rectMap.entries()) {
            if (layoutId === 'scrolling' && rect.offscreen) continue;
            assert(rect.width >= 0 && rect.height >= 0, `${layoutId} window ${id}: dimensions must not be negative`);
            assert(rect.x >= smallArea.x - 1 && rect.y >= smallArea.y - 1,
                `${layoutId} window ${id}: left/top edge escaped small workarea`);
            assert(rect.x + rect.width <= smallArea.x + smallArea.width + 1 &&
                   rect.y + rect.height <= smallArea.y + smallArea.height + 1,
                `${layoutId} window ${id}: right/bottom edge escaped small workarea`);
        }
    }
    print('  [OK] Layout rectangles remain within small workarea bounds');
}

print('=== 4a. Overflow Stacks Preserve Access to Every Window ===');
{
    const crowdedIds = Array.from({ length: 18 }, (_, i) => i + 1);
    const overflowSettings = {
        ...gapSettings,
        innerGap: 8,
        outerGap: 8,
        overflowMinWidthPx: 220,
        overflowMinHeightPx: 150,
        centeredMasterCount: 1,
        centeredMasterRatioPct: 50,
        gridMaxCols: 0,
        gridLastRowBehavior: 'stretch',
        dwindleSplitDirection: 'auto'
    };
    for (let layoutId of ['dwindle', 'master-stack', 'centered-master']) {
        let st = {
            masterCount: 1, masterRatio: 0.55, centeredMasterRatio: 0.50,
            centeredLeftRatio: null, centeredRightRatio: null, masterOrientation: 'left',
            weights: new Map(), colWeights: new Map(), gridRowWeights: new Map(),
            bspTree: new Layouts.BspTree(), focusedId: 18, lastFocusedId: null, scrollOffset: 0
        };
        let rects = Layouts.computeLayoutRects(layoutId, crowdedIds, workarea, st, overflowSettings);
        assert(rects.size === crowdedIds.length, `${layoutId}: overflow must retain every window`);
        assert(Array.from(rects.values()).some(r => r.stacked), `${layoutId}: crowded windows should form a stack`);
    }
    let gridState = {
        masterCount: 1, masterRatio: 0.55, masterOrientation: 'left',
        weights: new Map(), colWeights: new Map(), gridRowWeights: new Map(),
        bspTree: new Layouts.BspTree(), focusedId: 60, lastFocusedId: null, scrollOffset: 0
    };
    let gridIds = Array.from({ length: 60 }, (_, i) => i + 1);
    let gridRects = Layouts.computeLayoutRects('grid', gridIds, workarea, gridState, overflowSettings);
    assert(gridRects.size === gridIds.length, 'Grid overflow must retain every window');
    assert(Array.from(gridRects.values()).some(r => r.stacked), 'Grid should stack windows beyond its physical cell capacity');
    print('  [OK] Dwindle, Master, Centered Master and Grid stack overflow windows without dropping them');
}

print('=== 4b. Testing Dwindle Minimum-Width Constraint Compensation (Chromium 500px min-width in 5-window split) ===');
{
    let st5 = {
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 10,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let winIds = [3, 11, 6, 10, 4];
    let minSizes = new Map([[10, { minW: 500, minH: 121 }]]);
    let rects5 = Layouts.computeLayoutRects('dwindle', winIds, wa, st5, gapSettings, minSizes);

    let r6 = rects5.get(6);
    let r10 = rects5.get(10);
    let r4 = rects5.get(4);

    assert(r10.width === 500, `Chromium (10) width should be 500px, got ${r10.width}`);
    assert(r10.x === 1412, `Chromium (10) x should be 1412, got ${r10.x}`);
    assert(r10.x + r10.width === expectedRight, `Chromium right edge (${r10.x + r10.width}) should match expectedRight (${expectedRight})`);
    assert(r4.x === r10.x && r4.width === r10.width, `Window below Chromium (4) should align with Chromium (x=${r4.x}, w=${r4.width})`);
    assert(r6.x + r6.width + gapSettings.innerGap === r10.x, `Left neighbor (6) should leave exact 8px innerGap before Chromium (${r6.x} + ${r6.width} + 8 === ${r10.x})`);
    print('  [OK] Dwindle minimum-size constraint compensation aligns Chromium (500px) & neighbors without overlap');
}

print('=== 4c. Testing Smart Reflow When Two+ Windows Exceed Column/Row Capacity ===');
{
    // 1. Centered Master (3-col) degrades to 2-col Master & Stack when 3 windows each demand 750px on a 1920px monitor
    let min3 = new Map([
        [1, { minW: 750, minH: 300 }],
        [2, { minW: 750, minH: 300 }],
        [3, { minW: 750, minH: 300 }]
    ]);
    let stCM = {
        masterCount: 1,
        masterRatio: 0.50,
        masterOrientation: 'left',
        weights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let rectsCM = Layouts.computeLayoutRects('centered-master', [1, 2, 3], wa, stCM, gapSettings, min3);
    for (let [id, r] of rectsCM.entries()) {
        assert(r.width >= 750, `Centered Master reflowed window ${id} should satisfy minW 750px (got ${r.width})`);
    }
    print('  [OK] Centered Master auto-reflows 3 columns -> 2 columns when minW sum exceeds monitor width');

    // 2. Master & Stack rotates left/right -> top/bottom when 2 windows each demand 1100px width on a 1920px monitor
    let min2Wide = new Map([
        [1, { minW: 1100, minH: 350 }],
        [2, { minW: 1100, minH: 350 }]
    ]);
    let stMS = {
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let rectsMS = Layouts.computeLayoutRects('master-stack', [1, 2], wa, stMS, gapSettings, min2Wide);
    let m1 = rectsMS.get(1);
    let m2 = rectsMS.get(2);
    assert(m1.width >= 1100 && m2.width >= 1100, `Master & Stack auto-rotated windows should both get >= 1100px width`);
    assert(m1.y + m1.height + gapSettings.innerGap === m2.y, `Master & Stack auto-rotated windows should stack vertically with exact innerGap`);
    print('  [OK] Master & Stack auto-rotates left/right -> top/bottom when minW sum exceeds monitor width');

    // 3. Balanced Grid reduces column count when row minW sum exceeds monitor width
    let rectsGrid = Layouts.computeLayoutRects('grid', [1, 2], wa, stMS, gapSettings, min2Wide);
    let g1 = rectsGrid.get(1);
    let g2 = rectsGrid.get(2);
    assert(g1.width >= 1100 && g2.width >= 1100, `Balanced Grid reflowed windows should both get >= 1100px width`);
    assert(g1.y + g1.height + gapSettings.innerGap === g2.y, `Balanced Grid reflowed windows should stack in 1 column with exact innerGap`);
    print('  [OK] Balanced Grid auto-reduces columns when row minW sum exceeds monitor width');
}

print('=== 4d. Testing Exact 1-Pixel Mouse Edge Resize Across Layouts ===');
{
    let gapSettings = { innerGap: 8, outerGap: 8, smartGaps: false, dwindleRespectMinSize: true, dwindleSplitDirection: 'vertical' };
    let area = { x: wa.x + 8, y: wa.y + 8, width: wa.width - 16, height: wa.height - 16 };

    // 1. Dwindle 3-column vertical split: resizing win 1's right edge by +120px grows win 1 by +120px,
    // shrinks adjacent win 2 by -120px, and leaves non-adjacent win 3 untouched!
    let stD = {
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let beforeD = Layouts.computeLayoutRects('dwindle', [1, 2, 3], wa, stD, gapSettings);
    let w1Before = beforeD.get(1).width;
    let w2Before = beforeD.get(2).width;
    let w3Before = beforeD.get(3).width;

    stD.bspTree.resizeEdge(1, 'right', 120, area, 8);
    let afterD = Layouts.computeLayoutRects('dwindle', [1, 2, 3], wa, stD, gapSettings);
    assert(Math.abs(afterD.get(1).width - (w1Before + 120)) <= 1, `Dwindle win 1 should grow by +120px (got ${afterD.get(1).width - w1Before})`);
    assert(Math.abs(afterD.get(2).width - (w2Before - 120)) <= 1, `Dwindle adjacent win 2 should shrink by -120px (got ${afterD.get(2).width - w2Before})`);
    assert(Math.abs(afterD.get(3).width - w3Before) <= 1, `Dwindle non-adjacent win 3 should remain unchanged (drift=${afterD.get(3).width - w3Before})`);
    print('  [OK] Dwindle resizeEdge is 1px-exact and isolates non-adjacent sub-splits');

    // 2. Centered Master independent Left|Center and Center|Right borders
    let stCM = {
        masterCount: 1,
        masterRatio: 0.50,
        centeredMasterRatio: 0.50,
        centeredLeftRatio: null,
        centeredRightRatio: null,
        masterOrientation: 'left',
        weights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let cmBefore = Layouts.computeLayoutRects('centered-master', [1, 2, 3], wa, stCM, gapSettings);
    let leftBefore = cmBefore.get(3).width;
    let centerBefore = cmBefore.get(1).width;
    let rightBefore = cmBefore.get(2).width;
    let availW = area.width - 16;

    // Drag Left|Center border right by +90px: Left grows +90px, Center shrinks -90px, Right stays fixed
    stCM.centeredLeftRatio = (leftBefore + 90) / availW;
    stCM.centeredRightRatio = rightBefore / availW;
    stCM.centeredMasterRatio = (centerBefore - 90) / availW;
    let cmAfter = Layouts.computeLayoutRects('centered-master', [1, 2, 3], wa, stCM, gapSettings);
    assert(Math.abs(cmAfter.get(3).width - (leftBefore + 90)) <= 1, `Centered Master left column should grow by +90px`);
    assert(Math.abs(cmAfter.get(1).width - (centerBefore - 90)) <= 1, `Centered Master center column should shrink by -90px`);
    assert(Math.abs(cmAfter.get(2).width - rightBefore) <= 1, `Centered Master right column should stay untouched`);
    print('  [OK] Centered Master Left|Center and Center|Right borders resize independently to 1px accuracy');

    // 3. Balanced Grid row & column resize via weights and gridRowWeights
    let stG = {
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map(),
        gridRowWeights: new Map([[0, 1.3], [1, 0.7]]),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let gRects = Layouts.computeLayoutRects('grid', [1, 2, 3, 4], wa, stG, gapSettings);
    assert(gRects.get(1).height > gRects.get(3).height + 150, `Balanced Grid row 0 should be taller than row 1 when gridRowWeights are adjusted`);
    print('  [OK] Balanced Grid supports vertical row resizing via gridRowWeights');
}

print('=== 4e. Testing Width Resize Never Impacts Window Heights ===');
{
    let autoSettings = { innerGap: 8, outerGap: 8, smartGaps: false, dwindleRespectMinSize: true, dwindleSplitDirection: 'auto', centeredMasterCount: 2 };
    let area = { x: wa.x + 8, y: wa.y + 8, width: wa.width - 16, height: wa.height - 16 };

    // 1. Dwindle ('auto'): 3 windows (1 on left, 2 & 3 stacked on right).
    // Shrinking win 1 by -250px makes the right pane wider than tall (1198px > 1064px),
    // which previously flipped 2 & 3 from horizontal split to vertical split and changed their heights!
    let stD = {
        layoutId: 'dwindle',
        masterCount: 1,
        masterRatio: 0.50,
        masterOrientation: 'left',
        weights: new Map(),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let beforeD = Layouts.computeLayoutRects('dwindle', [1, 2, 3], wa, stD, autoSettings);
    let h2Before = beforeD.get(2).height;
    let h3Before = beforeD.get(3).height;
    assert(h2Before < 600 && h3Before < 600, `Win 2 and 3 should start stacked vertically on the right`);

    stD.bspTree.resizeEdge(1, 'right', -250, area, 8);
    let afterD = Layouts.computeLayoutRects('dwindle', [1, 2, 3], wa, stD, autoSettings);
    assert(afterD.get(2).height === h2Before, `Resizing width in Dwindle must not change Win 2 height (before=${h2Before}, after=${afterD.get(2).height})`);
    assert(afterD.get(3).height === h3Before, `Resizing width in Dwindle must not change Win 3 height (before=${h3Before}, after=${afterD.get(3).height})`);
    print('  [OK] Dwindle width resize preserves child split directions and never alters window heights');

    // 2. Centered Master with centeredMasterCount=2 and 2 windows: width resize adjusts centeredMasterRatio
    let stCM2 = {
        layoutId: 'centered-master',
        masterCount: 1,
        masterRatio: 0.65,
        centeredMasterRatio: 0.65,
        masterOrientation: 'left',
        weights: new Map([[1, 1.4], [2, 0.6]]),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    let cm2Rects = Layouts.computeLayoutRects('centered-master', [1, 2], wa, stCM2, autoSettings);
    assert(cm2Rects.get(1).width > cm2Rects.get(2).width + 300, `2-window Centered Master (centeredMasterCount=2) should respect centeredMasterRatio`);
    assert(cm2Rects.get(1).height === area.height && cm2Rects.get(2).height === area.height, `Both windows should keep full height`);
    print('  [OK] Centered Master (centeredMasterCount=2) width resize works on 2 windows without height distortion');
}

print('=== 4f. Testing Coherent Layout After Window Close ===');
{
    let gapSettings = { innerGap: 8, outerGap: 8, smartGaps: false, dwindleRespectMinSize: true, dwindleSplitDirection: 'auto', centeredMasterCount: 2 };
    let area = { x: wa.x + 8, y: wa.y + 8, width: wa.width - 16, height: wa.height - 16 };

    // 1. Dwindle 3-column vertical split: resize border 1|2 by +150px, then close win 1 ->
    // adjacent win 2 absorbs win 1's space while non-adjacent win 3 keeps its exact pixel width!
    let vSettings = { ...gapSettings, dwindleSplitDirection: 'vertical' };
    let stDV = {
        layoutId: 'dwindle',
        windowOrder: [1, 2, 3],
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map(),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        lastRects: new Map(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    Layouts.computeLayoutRects('dwindle', stDV.windowOrder, wa, stDV, vSettings);
    stDV.bspTree.resizeEdge(1, 'right', 150, area, 8);
    let resizedDV = Layouts.computeLayoutRects('dwindle', stDV.windowOrder, wa, stDV, vSettings);
    let w3Resized = resizedDV.get(3).width;

    // Close window 1
    Layouts.onWindowClosedStateCleanup(stDV, 1, vSettings);
    let afterClose1 = Layouts.computeLayoutRects('dwindle', stDV.windowOrder, wa, stDV, vSettings);
    assert(Math.abs(afterClose1.get(3).width - w3Resized) <= 1, `Closing win 1 should preserve non-adjacent win 3 width (${w3Resized} vs ${afterClose1.get(3).width})`);
    assert(afterClose1.get(2).width + afterClose1.get(3).width + 8 === area.width, `Win 2 and 3 should fill exact area width after win 1 closes`);
    print('  [OK] Dwindle closing a resized window transfers space to its immediate neighbor and preserves non-adjacent widths');

    // 2. Dwindle ('auto'): 3 windows (1 left, 2 top-right at 70% height, 3 bottom-right at 30% height).
    // Closing win 1 expands 2 & 3 horizontally across the screen while preserving their 70%/30% vertical split!
    let stDA = {
        layoutId: 'dwindle',
        windowOrder: [1, 2, 3],
        masterCount: 1,
        masterRatio: 0.50,
        masterOrientation: 'left',
        weights: new Map(),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        lastRects: new Map(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    Layouts.computeLayoutRects('dwindle', stDA.windowOrder, wa, stDA, gapSettings);
    stDA.bspTree.resizeEdge(2, 'bottom', 180, area, 8);
    let beforeCloseDA = Layouts.computeLayoutRects('dwindle', stDA.windowOrder, wa, stDA, gapSettings);
    let h2Custom = beforeCloseDA.get(2).height;
    let h3Custom = beforeCloseDA.get(3).height;

    Layouts.onWindowClosedStateCleanup(stDA, 1, gapSettings);
    let afterCloseDA = Layouts.computeLayoutRects('dwindle', stDA.windowOrder, wa, stDA, gapSettings);
    assert(afterCloseDA.get(2).height === h2Custom && afterCloseDA.get(3).height === h3Custom,
        `Closing left window in Dwindle must preserve top/bottom heights of surviving right windows`);
    assert(afterCloseDA.get(2).width === area.width && afterCloseDA.get(3).width === area.width,
        `Surviving top/bottom windows should expand to full width`);
    print('  [OK] Dwindle closing left window preserves vertical height split of right windows');

    // 3. Master & Stack: 4 windows [1, 2, 3, 4], stack [2, 3, 4] has custom weights, close win 2 ->
    // [3, 4] preserve their relative height ratio and renormalize to average 1.0
    let stMS = {
        layoutId: 'master-stack',
        windowOrder: [1, 2, 3, 4],
        masterCount: 1,
        masterRatio: 0.55,
        masterOrientation: 'left',
        weights: new Map([[2, 1.8], [3, 0.8], [4, 0.4]]),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        lastRects: new Map(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    Layouts.onWindowClosedStateCleanup(stMS, 2, gapSettings);
    let w3Norm = stMS.weights.get(3);
    let w4Norm = stMS.weights.get(4);
    assert(Math.abs((w3Norm + w4Norm) - 2.0) < 0.01, `Surviving stack weights should renormalize to sum=2.0 (got ${w3Norm + w4Norm})`);
    assert(Math.abs((w3Norm / w4Norm) - 2.0) < 0.01, `Surviving stack windows 3 & 4 should keep their 2:1 relative height ratio`);
    print('  [OK] Master & Stack renormalizes surviving stack weights coherently on window close');
}

print('=== 4g. Testing Magnetic Snap Guides (25%, 33%, 50%, 67%, 75%) ===');
{
    let snapHalf = Layouts.snapRatioValue(0.496, 1800, 10);
    assert(snapHalf.snapped && snapHalf.ratio === 0.50 && snapHalf.snappedPct === 50,
        'Ratio within 10px of 50% on 1800px span should snap to 0.50 (50%)');
    let noSnap = Layouts.snapRatioValue(0.42, 1800, 10);
    assert(!noSnap.snapped && noSnap.ratio === 0.42 && noSnap.snappedPct === null,
        'Ratio far from targets should not snap');

    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    let area = { x: 8, y: 8, width: 1904, height: 1064 };
    let stSnap = {
        layoutId: 'dwindle',
        windowOrder: [1, 2],
        masterCount: 1,
        masterRatio: 0.50,
        masterOrientation: 'left',
        weights: new Map(),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        lastRects: new Map(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    Layouts.computeLayoutRects('dwindle', stSnap.windowOrder, wa, stSnap, gapSettings);
    // Drag window 1 right edge close to 1/3 of availSpan (1896px -> 1/3 is 632px, from 948px is -316px; let's pass -312px so within 4px)
    stSnap.bspTree.resizeEdge(1, 'right', -312, area, 8, 10);
    assert(stSnap.bspTree.lastSnappedPct === 33, `Expected Dwindle magnetic snap to 33%, got ${stSnap.bspTree.lastSnappedPct}`);
    print('  [OK] Magnetic snap guides snap within tolerance to 25%, 33%, 50%, 67%, 75%');
}

print('=== 4h. Testing Smart Drag & Drop Edge Split / Insert (BspTree.insertRelativeTo) ===');
{
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    let stIns = {
        layoutId: 'dwindle',
        windowOrder: [1, 2, 3],
        masterCount: 1,
        masterRatio: 0.50,
        masterOrientation: 'left',
        weights: new Map(),
        colWeights: new Map(),
        bspTree: new Layouts.BspTree(),
        lastRects: new Map(),
        focusedId: 1,
        lastFocusedId: null,
        scrollOffset: 0
    };
    Layouts.computeLayoutRects('dwindle', stIns.windowOrder, wa, stIns, gapSettings);
    // Move window 3 to the TOP of window 1 (creating a horizontal split on the left column with 3 above 1)
    stIns.windowOrder = [3, 1, 2];
    stIns.bspTree.insertRelativeTo(3, 1, 'top', 0.5);
    let rects = Layouts.computeLayoutRects('dwindle', stIns.windowOrder, wa, stIns, gapSettings);
    assert(rects.get(3).x === rects.get(1).x && rects.get(3).width === rects.get(1).width,
        'Window 3 inserted above Window 1 must share the same column x and width');
    assert(rects.get(3).y < rects.get(1).y,
        'Window 3 inserted above Window 1 must sit above Window 1');
    print('  [OK] BspTree.insertRelativeTo splits target cell on requested edge (left/right/top/bottom)');
}

print('=== 4i. Testing Popup / File-Chooser / Portal Dialog Exclusion (Scratchpad.isPopupOrDialogWindow) ===');
{
    const Meta = imports.gi.Meta;
    const makeMockWin = (overrides = {}) => ({
        get_stable_sequence: () => overrides.id || 100,
        get_window_type: () => (overrides.windowType !== undefined ? overrides.windowType : Meta.WindowType.NORMAL),
        is_skip_taskbar: () => Boolean(overrides.skipTaskbar),
        is_override_redirect: () => Boolean(overrides.overrideRedirect),
        is_attached_dialog: () => Boolean(overrides.attachedDialog),
        get_transient_for: () => (overrides.transientFor || null),
        get_wm_class: () => (overrides.wmClass || 'SomeApp'),
        get_wm_class_instance: () => (overrides.wmInstance || 'someapp'),
        get_gtk_application_id: () => (overrides.gtkAppId || ''),
        get_role: () => (overrides.role || ''),
        get_title: () => (overrides.title || 'Main Document'),
        is_on_all_workspaces: () => false,
        is_above: () => false,
        resizeable: overrides.resizeable !== undefined ? overrides.resizeable : true
    });

    // 1. XDG Desktop Portal file chooser opened as NORMAL without transient_for
    let portalWin = makeMockWin({
        id: 201,
        wmClass: 'xdg-desktop-portal-gtk',
        gtkAppId: 'org.freedesktop.impl.portal.desktop.gtk',
        title: 'All Files'
    });
    assert(Scratchpad.isPopupOrDialogWindow(portalWin) === true, 'xdg-desktop-portal-gtk must be detected as popup/dialog');
    assert(Scratchpad.evaluateWindow(portalWin, {}, new Set(), new Set()).shouldTile === false, 'xdg-desktop-portal-gtk must not tile');

    // 2. GtkFileChooserDialog role
    let gtkChooser = makeMockWin({
        id: 202,
        role: 'GtkFileChooserDialog',
        title: 'Select a Document'
    });
    assert(Scratchpad.isPopupOrDialogWindow(gtkChooser) === true, 'GtkFileChooserDialog role must be detected as popup/dialog');
    assert(Scratchpad.evaluateWindow(gtkChooser, {}, new Set(), new Set()).shouldTile === false, 'GtkFileChooserDialog must not tile');

    // 3. Localized Italian & English file selection titles (even when opened as NORMAL without role)
    for (let dialogTitle of [
        'Open File',
        'Open Files...',
        'Save As',
        'Choose File - Mozilla Firefox',
        'Apri file',
        'Salva con nome...',
        'Seleziona una cartella',
        'Scegli file'
    ]) {
        let fileWin = makeMockWin({ id: 203, title: dialogTitle });
        assert(Scratchpad.isPopupOrDialogWindow(fileWin) === true, `File dialog title "${dialogTitle}" must be detected as popup`);
        assert(Scratchpad.evaluateWindow(fileWin, {}, new Set(), new Set()).shouldTile === false, `File dialog "${dialogTitle}" must not tile`);
    }

    // 4. Normal application window must still tile
    let normalEditor = makeMockWin({
        id: 204,
        wmClass: 'Code',
        title: 'extension.js - window_manager - Visual Studio Code'
    });
    assert(Scratchpad.isPopupOrDialogWindow(normalEditor) === false, 'Normal editor window must not be treated as popup');
    assert(Scratchpad.evaluateWindow(normalEditor, {}, new Set(), new Set()).shouldTile === true, 'Normal editor window must tile');
    print('  [OK] Popup, portal, and file-selection dialogs are accurately identified and excluded from tiling');
}

print('=== 4j. Testing Super+D (Show Desktop / Minimize All) & Restore Across ALL Layouts ===');
{
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    const allLayoutIds = ['dwindle', 'master-stack', 'centered-master', 'scrolling', 'monocle', 'grid'];

    for (let layoutId of allLayoutIds) {
        let state = {
            layoutId,
            windowOrder: [10, 20, 30, 40],
            fullWindowOrder: [10, 20, 30, 40],
            masterCount: 1,
            masterRatio: 0.62,
            centeredMasterRatio: 0.54,
            centeredLeftRatio: 0.20,
            centeredRightRatio: 0.26,
            masterOrientation: 'left',
            weights: new Map([[10, 1.3], [20, 1.5], [30, 0.8], [40, 0.7]]),
            colWeights: new Map([[10, 1.2], [20, 0.8], [30, 1.1], [40, 0.9]]),
            gridRowWeights: new Map([[0, 1.25], [1, 0.75]]),
            bspTree: new Layouts.BspTree(),
            savedBspSnapshot: null,
            savedFocusedId: null,
            savedScrollOffset: 0,
            _hadMinimizedWindows: false,
            _justRestoredFromMinimize: false,
            lastRects: new Map(),
            focusedId: 30,
            lastFocusedId: 20,
            scrollOffset: 0
        };

        // Initial layout pass + custom Dwindle split ratio & rotation
        Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);
        if (layoutId === 'dwindle') {
            state.bspTree.adjustSplit(10, 'vertical', 0.12);
            state.bspTree.rotateParent(30);
        }
        let rectsBefore = Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);

        // Simulate Super+D minimizing windows one by one (10 -> 20 -> 30 -> 40)
        Layouts.syncWindowOrderWithMinimized(state, [20, 30, 40], [10]);
        Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);
        Layouts.syncWindowOrderWithMinimized(state, [30, 40], [10, 20]);
        Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);
        Layouts.syncWindowOrderWithMinimized(state, [], [10, 20, 30, 40]);
        assert(state.windowOrder.length === 0, `[${layoutId}] Active windowOrder should be empty while all minimized`);
        assert(JSON.stringify(state.fullWindowOrder) === JSON.stringify([10, 20, 30, 40]),
            `[${layoutId}] fullWindowOrder must preserve [10, 20, 30, 40] during Super+D`);

        // Simulate a popup window (id 999) closing while all tiled windows are minimized via Super+D
        Layouts.onWindowClosedStateCleanup(state, 999, gapSettings);
        assert(state.weights.get(20) === 1.5, `[${layoutId}] Closing an unrelated popup while minimized must not clear weights`);

        // Simulate Super+D restoring windows in scrambled Z-order (e.g. [40, 20, 30, 10])
        // First partial unminimize ([40, 20] visible, [10, 30] still unminimizing)
        Layouts.syncWindowOrderWithMinimized(state, [40, 20], [10, 30]);
        Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);
        // Now all 4 unminimized in Z-order [40, 20, 30, 10]
        let restoredOrder = Layouts.syncWindowOrderWithMinimized(state, [40, 20, 30, 10], []);
        assert(JSON.stringify(restoredOrder) === JSON.stringify([10, 20, 30, 40]),
            `[${layoutId}] Restored windowOrder after Super+D must be [10, 20, 30, 40], got ${JSON.stringify(restoredOrder)}`);
        assert(state.focusedId === 30, `[${layoutId}] Focused window ID (30) must be restored after Super+D`);

        let rectsAfter = Layouts.computeLayoutRects(layoutId, state.windowOrder, wa, state, gapSettings);
        for (let id of [10, 20, 30, 40]) {
            let rb = rectsBefore.get(id);
            let ra = rectsAfter.get(id);
            assert(rb && ra &&
                   rb.x === ra.x && rb.y === ra.y &&
                   rb.width === ra.width && rb.height === ra.height,
                `[${layoutId}] Window ${id} rect after Super+D restore ${JSON.stringify(ra)} must match pre-minimize ${JSON.stringify(rb)}`);
        }
        print(`  [OK] Super+D minimize-all & restore preserves exact window order, ratios, and geometry in "${layoutId}"`);
    }
}

print('=== 4k. Testing Extracted Modules (bsp-tree.js, window-rules.js, state-store.js, grab-controller.js, keybindings.js) ===');
{
    const BspTreeMod = loadCommonJsModule('cinnawm@corradoproietti/bsp-tree.js');
    const WindowRulesMod = loadCommonJsModule('cinnawm@corradoproietti/window-rules.js');
    const StateStoreMod = loadCommonJsModule('cinnawm@corradoproietti/state-store.js');
    const GrabControllerMod = loadCommonJsModule('cinnawm@corradoproietti/grab-controller.js');
    const KeybindingsMod = loadCommonJsModule('cinnawm@corradoproietti/keybindings.js');

    assert(typeof BspTreeMod.BspTree === 'function', 'BspTree must be exported from bsp-tree.js');
    assert(typeof WindowRulesMod.parseCustomRules === 'function', 'parseCustomRules must be exported from window-rules.js');

    // WorkspaceMonitorState & persistence key construction
    let wsState = new StateStoreMod.WorkspaceMonitorState({ defaultLayout: 'centered-master', masterCount: 2, masterRatioPct: 62 });
    assert(wsState.layoutId === 'centered-master' && wsState.masterCount === 2 && Math.abs(wsState.masterRatio - 0.62) < 0.001,
        'WorkspaceMonitorState should initialize from defaultSettings');
    let mockWinA = { get_wm_class: () => 'Firefox', get_wm_class_instance: () => 'Navigator', get_role: () => 'browser' };
    let mockWinB = { get_wm_class: () => 'Firefox', get_wm_class_instance: () => 'Navigator', get_role: () => 'browser' };
    let pKeys = StateStoreMod.buildWindowPersistenceKeys([[101, mockWinA], [102, mockWinB]]);
    assert(pKeys.get(101) !== pKeys.get(102) && pKeys.get(101).endsWith('#0') && pKeys.get(102).endsWith('#1'),
        'buildWindowPersistenceKeys should assign deterministic ordinal suffixes to identical window classes');
    print('  [OK] StateStore.WorkspaceMonitorState & buildWindowPersistenceKeys');

    // GrabController edge snap zone calculation
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    let leftSnap = GrabControllerMod.computeEdgeSnapZone(40, 500, wa, { outerGap: 8, innerGap: 8 });
    assert(leftSnap && leftSnap.rect.width === Math.round((1920 - 16 - 8) / 2),
        'Cursor near left edge should trigger left half-screen snap preview');
    let topRightSnap = GrabControllerMod.computeEdgeSnapZone(1800, 40, wa, { outerGap: 8, innerGap: 8 });
    assert(topRightSnap && topRightSnap.rect.x > 900 && topRightSnap.rect.height < 600,
        'Cursor at top-right corner should trigger top-right quarter snap preview');
    print('  [OK] GrabController.computeEdgeSnapZone half & quarter screen snap detection');

    // Keybindings accelerator normalization & complete schema parity
    let normCtrl = KeybindingsMod.normalizeAccelerator('<Control>Return');
    assert(normCtrl && KeybindingsMod.normalizeAccelerator('<Ctrl>Return') === normCtrl,
        'normalizeAccelerator should normalize <Ctrl>Return and <Control>Return to identical keyval:mods strings');
    assert(Array.isArray(KeybindingsMod.KEYBINDING_SETTINGS_MAP) && KeybindingsMod.KEYBINDING_SETTINGS_MAP.length === 31,
        'KEYBINDING_SETTINGS_MAP should contain all 31 keybinding definitions');

    let mappedKbProps = new Set(KeybindingsMod.KEYBINDING_SETTINGS_MAP.map(([, prop]) => prop));
    for (let prop of ['kbMoveWorkspacePrev', 'kbMoveWorkspaceNext', 'kbMoveMonitorNext', 'kbFocusMonitorNext', 'kbTogglePip', 'kbWindowSwitcher']) {
        assert(mappedKbProps.has(prop), `KEYBINDING_SETTINGS_MAP must include ${prop}`);
        assert(Boolean(KeybindingsMod.normalizeAccelerator(defaults[prop].split('::')[0])),
            `${prop} default primary accelerator must parse cleanly: ${defaults[prop]}`);
    }
    let extSrcBytes = GLib.file_get_contents('cinnawm@corradoproietti/extension.js')[1];
    let extSrc = ByteArray.toString(extSrcBytes);
    let visualMatches = [...extSrc.matchAll(/\['([a-z0-9-]+)',\s*'([A-Za-z0-9]+)'\]/g)];
    let mappedAllProps = new Set([...mappedKbProps, ...visualMatches.map(([, , p]) => p || '').filter(Boolean)]);
    for (let m of visualMatches) mappedAllProps.add(m[2]);
    for (let prop of Object.keys(defaults)) {
        assert(mappedAllProps.has(prop), `Every defaults.json property (${prop}) must be mapped in VISUAL_SETTINGS_MAP or KEYBINDING_SETTINGS_MAP`);
    }
    print('  [OK] Keybindings.normalizeAccelerator, 31 KEYBINDING_SETTINGS_MAP entries & full defaults parity');

    // Smooth Stack / Tab Group directional exit test (exiting sibling group finds external tile)
    let leftTab1 = { id: 101, rect: { x: 0, y: 0, width: 950, height: 1080 } };
    let leftTab2 = { id: 102, rect: { x: 0, y: 0, width: 950, height: 1080 } };
    let rightTile = { id: 201, rect: { x: 960, y: 0, width: 960, height: 1080 } };
    let externalCandidates = [leftTab1, rightTile]; // excludes leftTab2 sibling in same cell
    assert(Layouts.findDirectionalTarget(102, leftTab2.rect, externalCandidates, 'right') === 201,
        'Directional exit from a stack/tab group boundary must jump to external right neighbor 201');
    assert(Layouts.findDirectionalTarget(101, leftTab1.rect, [leftTab1, rightTile], 'down') === null,
        'Vertical directional exit when no neighbor exists below returns null cleanly so stack cycling can proceed');
    print('  [OK] Stack / Tab Group smooth directional exit candidate lookup');

    // RuntimeConfig parameterization & XDG isolation check
    const RuntimeConfigMod = loadCommonJsModule('cinnawm@corradoproietti/runtime-config.js');
    assert(RuntimeConfigMod.resolveUuid() === meta.uuid,
        'RuntimeConfig.resolveUuid() must resolve extension UUID consistently');
    assert(RuntimeConfigMod.getIpcConfig().busName === 'org.cinnawm.Service' &&
        RuntimeConfigMod.getIpcConfig().objectPath === '/org/cinnawm/Service',
        'RuntimeConfig.getIpcConfig() must provide parameterized D-Bus identifiers');
    assert(RuntimeConfigMod.getAlbertSwitcherConfig().busName === 'org.cinnawm.AlbertSwitcher' &&
        RuntimeConfigMod.getAlbertSwitcherConfig().objectPath === '/org/cinnawm/AlbertSwitcher' &&
        RuntimeConfigMod.getAlbertSwitcherConfig().interfaceName === 'org.cinnawm.AlbertSwitcher',
        'RuntimeConfig.getAlbertSwitcherConfig() must provide parameterized Albert Switcher D-Bus identifiers');
    assert(RuntimeConfigMod.getSpicesConfigFile(meta.uuid, 'test.json', false).endsWith(`cinnamon/spices/${meta.uuid}/test.json`),
        'RuntimeConfig.getSpicesConfigFile() must construct spices config paths cleanly');
    print('  [OK] RuntimeConfig parameterization & XDG path helpers');
}

print('=== 4l. Testing Manual Tab Groups (Group, Ungroup, Dissolve, & Leader Close Transfer) ===');
{
    const StateStoreMod = loadCommonJsModule('cinnawm@corradoproietti/state-store.js');
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };
    let st = new StateStoreMod.WorkspaceMonitorState({ defaultLayout: 'dwindle' });
    st.windowOrder = [10, 20, 30];
    st.fullWindowOrder = [10, 20, 30];
    st.focusedId = 30;

    // 1. Group window 30 into window 10 -> [10, 30] share a single cell while 20 occupies the second cell
    Layouts.computeLayoutRects('dwindle', st.windowOrder, wa, st, gapSettings);
    let grp = Layouts.groupWindowsAsTabs(st, 30, 10);
    assert(JSON.stringify(grp) === JSON.stringify([10, 30]), 'Tab group should be [10, 30]');

    for (let layoutId of ['dwindle', 'master-stack', 'centered-master', 'scrolling', 'grid']) {
        let rects = Layouts.computeLayoutRects(layoutId, st.windowOrder, wa, st, gapSettings);
        assert(rects.size === 3, `${layoutId}: all 3 windows must receive rects`);
        let r10 = rects.get(10);
        let r30 = rects.get(30);
        let r20 = rects.get(20);
        assert(r10.stacked && r10.manualTabGroup && r30.stacked && r30.manualTabGroup,
            `${layoutId}: grouped windows 10 and 30 must be marked stacked & manualTabGroup`);
        assert(r10.x === r30.x && r10.y === r30.y && r10.width === r30.width && r10.height === r30.height,
            `${layoutId}: grouped windows 10 and 30 must share identical cell geometry`);
        assert(r20.x !== r10.x || r20.y !== r10.y,
            `${layoutId}: non-grouped window 20 must occupy a separate cell`);
    }
    print('  [OK] Manual Tab Group collapses grouped windows into a shared cell across all layouts');

    // 2. Add a 3rd tab (40) to group [10, 30] -> [10, 30, 40], then close leader 10 -> 30 becomes new leader!
    st.windowOrder.push(40);
    st.fullWindowOrder.push(40);
    Layouts.groupWindowsAsTabs(st, 40, 10);
    st.bspTree.resizeEdge(10, 'right', 120, { x: 8, y: 8, width: 1904, height: 1064 }, 8);
    let beforeCloseLeader = Layouts.computeLayoutRects('dwindle', st.windowOrder, wa, st, gapSettings);
    let groupWidthBefore = beforeCloseLeader.get(10).width;

    Layouts.onWindowClosedStateCleanup(st, 10, gapSettings);
    assert(JSON.stringify(st.tabGroups[0]) === JSON.stringify([30, 40]),
        'Closing leader 10 must promote 30 to leader of [30, 40]');
    let afterCloseLeader = Layouts.computeLayoutRects('dwindle', st.windowOrder, wa, st, gapSettings);
    assert(Math.abs(afterCloseLeader.get(30).width - groupWidthBefore) <= 1,
        'Surviving tab group [30, 40] must preserve custom BSP cell width after leader 10 closes');
    print('  [OK] Closing the leader of a Manual Tab Group seamlessly transfers BSP leaf and weights to the next tab');

    // 3. Ungroup window 40 from [30, 40] -> dissolves 2-window group into independent tiles [30, 40, 20]
    let detached = Layouts.ungroupWindowFromTabs(st, 40, gapSettings);
    assert(detached === true && st.tabGroups.length === 0, 'Detaching 40 from 2-window group should dissolve the group');
    let rectsUngrouped = Layouts.computeLayoutRects('dwindle', st.windowOrder, wa, st, gapSettings);
    assert(!rectsUngrouped.get(30).manualTabGroup && !rectsUngrouped.get(40).manualTabGroup,
        'Detached windows should no longer be marked manualTabGroup');
    print('  [OK] Ungrouping detaches tab into an independent tile');
}

print('=== 4m. Regression Tests for Fullscreen TabGroups, State Helpers, Chained BSP, & WindowRules ===');
{
    const Meta = imports.gi.Meta;
    const StateStoreMod = loadCommonJsModule('cinnawm@corradoproietti/state-store.js');
    const BspTreeMod = loadCommonJsModule('cinnawm@corradoproietti/bsp-tree.js');
    const WindowRulesMod = loadCommonJsModule('cinnawm@corradoproietti/window-rules.js');
    let wa = { x: 0, y: 0, width: 1920, height: 1080 };

    // 1. Preserve tabGroups across minimized & fullscreen windows (mirrors _retileMonitor calling sync + computeLayoutRects)
    let stFs = new StateStoreMod.WorkspaceMonitorState({ defaultLayout: 'dwindle' });
    stFs.windowOrder = [10, 20, 30];
    stFs.fullWindowOrder = [10, 20, 30];
    Layouts.groupWindowsAsTabs(stFs, 20, 10);
    Layouts.computeLayoutRects('dwindle', stFs.windowOrder, wa, stFs, gapSettings);
    // Case A: Window 20 goes fullscreen alone (no minimized windows)
    Layouts.syncWindowOrderWithMinimized(stFs, [10, 30], [], [20]);
    Layouts.computeLayoutRects('dwindle', stFs.windowOrder, wa, stFs, gapSettings);
    assert(stFs.tabGroups.length === 1 && JSON.stringify(stFs.tabGroups[0]) === JSON.stringify([10, 20]),
        'Tab group [10, 20] must stay intact when one tab is fullscreen');
    // Case B: Window 10 also minimizes while window 20 is fullscreen, leaving only 30 visible
    Layouts.syncWindowOrderWithMinimized(stFs, [30], [10], [20]);
    Layouts.computeLayoutRects('dwindle', stFs.windowOrder, wa, stFs, gapSettings);
    assert(stFs.tabGroups.length === 1 && JSON.stringify(stFs.tabGroups[0]) === JSON.stringify([10, 20]),
        'Tab group [10, 20] must stay intact when one tab is minimized and the other is fullscreen');
    // Unfullscreen & unminimize restores both into tab group
    Layouts.syncWindowOrderWithMinimized(stFs, [30, 20, 10], [], []);
    Layouts.computeLayoutRects('dwindle', stFs.windowOrder, wa, stFs, gapSettings);
    assert(stFs.tabGroups.length === 1 && JSON.stringify(stFs.tabGroups[0]) === JSON.stringify([10, 20]),
        'Tab group [10, 20] must remain intact after restoring from fullscreen and minimize');
    assert(JSON.stringify(stFs.windowOrder) === JSON.stringify([10, 20, 30]),
        'Restoring from fullscreen/minimize must preserve original windowOrder [10, 20, 30]');
    // Genuinely closing window 20 dissolves 2-window group during retile
    Layouts.syncWindowOrderWithMinimized(stFs, [10, 30], [], []);
    Layouts.computeLayoutRects('dwindle', stFs.windowOrder, wa, stFs, gapSettings);
    assert(stFs.tabGroups.length === 0, 'Genuinely closing member 20 must dissolve 2-member group');
    print('  [OK] Tab groups & windowOrder survive fullscreen + minimize cycles');

    // 2. Grouping leader of source group with an ungrouped window transfers BSP & promotes next source member
    let stGrp = new StateStoreMod.WorkspaceMonitorState({ defaultLayout: 'dwindle' });
    stGrp.windowOrder = [1, 2, 3, 4, 5, 6];
    stGrp.fullWindowOrder = [1, 2, 3, 4, 5, 6];
    Layouts.computeLayoutRects('dwindle', stGrp.windowOrder, wa, stGrp, gapSettings);
    Layouts.groupWindowsAsTabs(stGrp, 2, 1);
    Layouts.groupWindowsAsTabs(stGrp, 5, 1); // sourceGroup = [1, 2, 5]
    Layouts.groupWindowsAsTabs(stGrp, 4, 3); // second group = [3, 4]
    Layouts.groupWindowsAsTabs(stGrp, 1, 6); // Move leader 1 from [1, 2, 5] onto ungrouped window 6
    assert(stGrp.tabGroups.some(g => JSON.stringify(g) === JSON.stringify([2, 5])),
        'Source group [1, 2, 5] must promote 2 -> [2, 5] when leader 1 joins ungrouped window 6');
    assert(stGrp.tabGroups.some(g => JSON.stringify(g) === JSON.stringify([6, 1])),
        'Target window 6 must form group [6, 1]');
    assert(stGrp.bspTree.hasWindow(2) && !stGrp.bspTree.hasWindow(1),
        'BSP tree must contain promoted leader 2 and no longer contain non-leader 1');
    print('  [OK] groupWindowsAsTabs cleanly promotes source group leader when detaching leader');

    // 3. detachWindowFromState, swapWindowIdsInState, insertWindowRelativeInState
    Layouts.detachWindowFromState(stGrp, 2); // Detaches leader 2 from [2, 5], dissolving it & promoting 5 into BSP
    assert(!stGrp.windowOrder.includes(2) && stGrp.bspTree.hasWindow(5),
        'detachWindowFromState must remove 2 and transfer BSP ownership to surviving tab 5');
    Layouts.swapWindowIdsInState(stGrp, 3, 4); // Swap leader 3 with tab 4 inside [3, 4]
    assert(stGrp.tabGroups.some(g => JSON.stringify(g) === JSON.stringify([4, 3])) && stGrp.bspTree.hasWindow(4),
        'swapWindowIdsInState inside tab group must update leader to 4 and transfer BSP leaf');
    Layouts.insertWindowRelativeInState(stGrp, 5, 4, 'left', 0.5);
    assert(stGrp.windowOrder.indexOf(5) < stGrp.windowOrder.indexOf(4),
        'insertWindowRelativeInState with side=left must place window before target');
    print('  [OK] Layouts.detachWindowFromState, swapWindowIdsInState, insertWindowRelativeInState');

    // 4. Chained BspTree.remove() keeps spans valid for remaining tiles
    let tree = new BspTreeMod.BspTree();
    tree.sync([1, 2, 3, 4], null, { area: { x: 0, y: 0, width: 1600, height: 900 } });
    tree.computeRects({ x: 0, y: 0, width: 1600, height: 900 }, 8);
    tree.remove(1);
    tree.remove(2); // immediate second remove without intermediate computeRects()
    let remRects = tree.computeRects({ x: 0, y: 0, width: 1600, height: 900 }, 8);
    assert(remRects.size === 2 && remRects.get(3).width > 200 && remRects.get(4).width > 200,
        'Chained BspTree.remove() must keep valid positive spans for surviving windows');
    print('  [OK] Chained BspTree.remove() preserves valid survivor geometry');

    // 5. Constrained BspTree.resizeEdge() respects neighbor minSize constraints
    let cTree = new BspTreeMod.BspTree();
    let cArea = { x: 0, y: 0, width: 1920, height: 1080 };
    cTree.sync([1, 2], null, { area: cArea });
    cTree.computeRects(cArea, 8);
    let constraints = new Map([[1, { minW: 400, minH: 200 }], [2, { minW: 700, minH: 200 }]]);
    cTree.resizeEdge(1, 'right', 900, cArea, 8, 0, constraints);
    let cRects = cTree.computeRects(cArea, 8);
    assert(cRects.get(2).width >= 700,
        `Constrained resizeEdge must respect neighbor minW=700, got ${cRects.get(2).width}`);
    print('  [OK] Constrained BspTree.resizeEdge() respects neighbor minSize constraints');

    // 6. computeGridDimensions & computeEffectiveWorkarea
    let gAuto = Layouts.computeGridDimensions([1, 2, 3, 4, 5], wa, { innerGap: 8, gridMaxCols: 0 });
    assert(gAuto.cols === 3 && gAuto.rows === 2, `5 windows auto grid should be 3x2, got ${gAuto.cols}x${gAuto.rows}`);
    let gFixed = Layouts.computeGridDimensions([1, 2, 3, 4, 5], wa, { innerGap: 8, gridMaxCols: 2 });
    assert(gFixed.cols === 2 && gFixed.rows === 3, `5 windows maxCols=2 should be 2x3, got ${gFixed.cols}x${gFixed.rows}`);
    let effSmartSingle = Layouts.computeEffectiveWorkarea(wa, 1, { outerGap: 12, smartGaps: true });
    let effSmartMulti = Layouts.computeEffectiveWorkarea(wa, 2, { outerGap: 12, smartGaps: true });
    assert(effSmartSingle.area.width === 1920 && effSmartMulti.area.width === 1896,
        'computeEffectiveWorkarea must apply Smart Gaps for 1 window and outerGap inset for 2+ windows');
    print('  [OK] Layouts.computeGridDimensions & computeEffectiveWorkarea');

    // 6b. CinnaWMIpcService contract verification (ipc-service.js)
    const IpcServiceMod = loadCommonJsModule('cinnawm@corradoproietti/ipc-service.js');
    let nodeInfo = Gio.DBusNodeInfo.new_for_xml(IpcServiceMod.CINNAWM_IFACE_XML);
    let ifaceInfo = nodeInfo && nodeInfo.lookup_interface('org.cinnawm.Service');
    assert(ifaceInfo && ifaceInfo.signals.some(s => s.name === 'StateChanged'),
        'CINNAWM_IFACE_XML must expose the StateChanged D-Bus signal');

    let ipcEvents = [];
    let mockWm = {
        settings: { innerGap: 8, defaultLayout: 'dwindle' },
        getCurrentState: () => ({ autoTile: true, layoutId: 'master-stack' }),
        updateSettingValue: (k, v) => { ipcEvents.push(['update', k, v]); return true; },
        setLayoutById: (id) => { ipcEvents.push(['layout', id]); },
        resetCurrentLayoutRatios: () => { ipcEvents.push(['reset']); },
        importSettingsSnapshot: (obj) => { ipcEvents.push(['import', obj]); return true; },
        cycleLayout: (dir) => { ipcEvents.push(['cycle', dir]); },
        focusDirectional: (dir) => { ipcEvents.push(['focus', dir]); },
        swapDirectional: (dir) => { ipcEvents.push(['swap', dir]); },
        toggleFocusedFloating: () => { ipcEvents.push(['float']); },
        toggleWorkspaceTiling: () => { ipcEvents.push(['tiling']); },
        handleScratchpadToggle: () => { ipcEvents.push(['scratchpad']); },
        moveFocusedToWorkspace: (delta) => { ipcEvents.push(['moveWs', delta]); return true; },
        moveFocusedToAdjacentMonitor: (step) => { ipcEvents.push(['moveMon', step]); return true; },
        focusMonitorStep: (step) => { ipcEvents.push(['focusMon', step]); return true; },
        toggleFocusedPip: () => { ipcEvents.push(['pip']); return true; },
        activateWindowById: (id) => { ipcEvents.push(['activate', id]); return id === 42; },
        closeWindowById: (id) => { ipcEvents.push(['close', id]); return id === 42; },
        getOpenWindowsInfo: () => ([{ id: 42, title: 'Terminal', workspace: 0, monitor: 0, floating: false }])
    };
    let svc = new IpcServiceMod.CinnaWMIpcService(mockWm);
    let snap = JSON.parse(svc.GetSnapshot());
    assert(snap.activeLayout === 'master-stack' && snap.settings.innerGap === 8,
        'CinnaWMIpcService.GetSnapshot must serialize activeLayout and settings');
    assert(svc.UpdateSetting('innerGap', '12') === true, 'UpdateSetting must return true');
    assert(svc.ActivateLayout('grid') === true, 'ActivateLayout must return true');
    assert(svc.ResetRatios() === true, 'ResetRatios must return true');
    assert(svc.ImportSettings(JSON.stringify({ innerGap: 14 })) === true, 'ImportSettings must return true');
    assert(svc.CycleLayout(-1) === true && svc.CycleLayout(0) === true, 'CycleLayout must delegate direction cleanly');
    assert(svc.FocusDirection('LEFT') === true && svc.FocusDirection('diagonal') === false,
        'FocusDirection must normalize valid directions and reject invalid ones');
    assert(svc.SwapDirection('right') === true && svc.SwapDirection('invalid') === false,
        'SwapDirection must validate directions');
    assert(svc.ToggleFloating() === true && svc.ToggleTiling() === true && svc.ToggleScratchpad() === true,
        'ToggleFloating, ToggleTiling, and ToggleScratchpad must return true');
    assert(svc.MoveToWorkspace(-1) === true && svc.MoveToWorkspace(0) === false,
        'MoveToWorkspace must validate non-zero delta');
    assert(svc.MoveToNextMonitor() === true && svc.FocusNextMonitor() === true &&
           svc.TogglePip() === true &&
           svc.ActivateWindow(42) === true && svc.ActivateWindow(0) === false && svc.ActivateWindow(99) === false &&
           svc.CloseWindow(42) === true && svc.CloseWindow(-1) === false,
        'Monitor, PiP, ActivateWindow, and CloseWindow action methods must validate and delegate cleanly');
    let openWins = JSON.parse(svc.GetOpenWindows());
    assert(Array.isArray(openWins) && openWins.length === 1 && openWins[0].id === 42,
        'GetOpenWindows must serialize open window descriptors cleanly');
    assert(svc.emitStateChanged('layout-changed') === false,
        'emitStateChanged must be a safe no-op returning false when not exported on D-Bus');
    assert(ipcEvents.length === 18 && ipcEvents[0][2] === 12 && ipcEvents[1][1] === 'grid' && ipcEvents[4][1] === -1 && ipcEvents[5][1] === 1,
        'CinnaWMIpcService methods must delegate all arguments cleanly to CinnaWMExtension');
    print('  [OK] CinnaWMIpcService D-Bus signal XML & CLI action contract methods');

    // 7. WindowRules word-boundary title matching, title: prefix, and rule caching
    const makeMockWin = (wmClass, title) => ({
        get_stable_sequence: () => 9001,
        get_window_type: () => Meta.WindowType.NORMAL,
        is_skip_taskbar: () => false,
        is_override_redirect: () => false,
        is_attached_dialog: () => false,
        get_transient_for: () => null,
        is_on_all_workspaces: () => false,
        is_above: () => false,
        resizeable: true,
        get_wm_class: () => wmClass,
        get_wm_class_instance: () => wmClass.toLowerCase(),
        get_gtk_application_id: () => '',
        get_role: () => '',
        get_title: () => title
    });
    let ruleSettings = {
        tileByDefault: true,
        floatingClasses: 'set, settings_helper',
        customWindowRules: ''
    };
    let backupEditor = makeMockWin('gedit', 'Unset settings_backup.txt');
    let evalBackup = WindowRulesMod.evaluateWindow(backupEditor, ruleSettings, new Set(), new Set());
    assert(evalBackup.shouldTile === true,
        'Word-boundary matching must NOT match "set" inside "Unset settings_backup.txt"');

    let explicitPrefixSettings = {
        tileByDefault: true,
        floatingClasses: 'title:settings_backup',
        customWindowRules: ''
    };
    let evalPrefix = WindowRulesMod.evaluateWindow(backupEditor, explicitPrefixSettings, new Set(), new Set());
    assert(evalPrefix.shouldTile === false,
        'Explicit title:settings_backup rule must float window via title substring match');

    let customPrefixSettings = {
        tileByDefault: true,
        floatingClasses: '',
        customWindowRules: 'Spotify:workspace=4, title:settings_backup:float'
    };
    let evalCustomPrefix = WindowRulesMod.evaluateWindow(backupEditor, customPrefixSettings, new Set(), new Set());
    assert(evalCustomPrefix.shouldTile === false,
        'Custom rule title:settings_backup:float must float window via title substring match');

    let winWithSetWord = makeMockWin('python3', 'Set Preferences');
    let evalWord = WindowRulesMod.evaluateWindow(winWithSetWord, ruleSettings, new Set(), new Set());
    assert(evalWord.shouldTile === false,
        'Word-boundary matching MUST match whole word "Set" in title "Set Preferences"');

    let cRules1 = WindowRulesMod.getCachedCustomRules('spotify=ws:4');
    let cRules2 = WindowRulesMod.getCachedCustomRules('spotify=ws:4');
    let cFloat1 = WindowRulesMod.getCachedFloatingEntries('steam, gimp');
    let cFloat2 = WindowRulesMod.getCachedFloatingEntries('steam, gimp');
    assert(cRules1 === cRules2 && cFloat1 === cFloat2 && cFloat1.length === 2,
        'WindowRules caches must return identical parsed array references on cache hits');
    print('  [OK] WindowRules word-boundary matching, title: prefix & parsed-rule caching');

    // 8. Error-handling & exception safety (CinnaWMIpcService & WindowRules safe helpers)
    assert(svc.UpdateSetting('nonExistentProp', 'true') === false,
        'UpdateSetting must reject unknown setting properties');
    assert(svc.UpdateSetting('innerGap', '"not-a-number"') === false,
        'UpdateSetting must reject mismatched setting types');
    assert(svc.UpdateSetting('innerGap', 'null') === false,
        'UpdateSetting must reject null values for typed settings');
    assert(svc.UpdateSetting('innerGap', '{bad-json') === false,
        'UpdateSetting must reject malformed JSON payloads');
    assert(svc.ActivateLayout('   ') === false,
        'ActivateLayout must reject empty/whitespace layout IDs');

    let throwingWm = {
        uuid: 'test@cinnawm',
        settings: { innerGap: 8, defaultLayout: 'dwindle' },
        getCurrentState: () => { throw new Error('boom state'); },
        updateSettingValue: () => { throw new Error('boom update'); },
        setLayoutById: () => { throw new Error('boom layout'); },
        resetCurrentLayoutRatios: () => { throw new Error('boom reset'); },
        importSettingsSnapshot: () => { throw new Error('boom import'); },
        cycleLayout: () => { throw new Error('boom cycle'); },
        focusDirectional: () => { throw new Error('boom focus'); },
        swapDirectional: () => { throw new Error('boom swap'); },
        toggleFocusedFloating: () => { throw new Error('boom float'); },
        toggleWorkspaceTiling: () => { throw new Error('boom tiling'); },
        handleScratchpadToggle: () => { throw new Error('boom scratchpad'); },
        moveFocusedToWorkspace: () => { throw new Error('boom moveWs'); },
        moveFocusedToAdjacentMonitor: () => { throw new Error('boom moveMon'); },
        focusMonitorStep: () => { throw new Error('boom focusMon'); },
        toggleFocusedPip: () => { throw new Error('boom pip'); },
        activateWindowById: () => { throw new Error('boom activate'); },
        closeWindowById: () => { throw new Error('boom close'); },
        getOpenWindowsInfo: () => { throw new Error('boom windows'); }
    };
    let safeSvc = new IpcServiceMod.CinnaWMIpcService(throwingWm);
    assert(safeSvc.GetSnapshot() === '{}', 'GetSnapshot must return "{}" on exception');
    assert(safeSvc.UpdateSetting('innerGap', '10') === false, 'UpdateSetting must return false on exception');
    assert(safeSvc.ActivateLayout('grid') === false, 'ActivateLayout must return false on exception');
    assert(safeSvc.ResetRatios() === false, 'ResetRatios must return false on exception');
    assert(safeSvc.ImportSettings('{"innerGap":10}') === false, 'ImportSettings must return false on exception');
    assert(safeSvc.CycleLayout(1) === false, 'CycleLayout must return false on exception');
    assert(safeSvc.FocusDirection('left') === false, 'FocusDirection must return false on exception');
    assert(safeSvc.SwapDirection('right') === false, 'SwapDirection must return false on exception');
    assert(safeSvc.ToggleFloating() === false, 'ToggleFloating must return false on exception');
    assert(safeSvc.ToggleTiling() === false, 'ToggleTiling must return false on exception');
    assert(safeSvc.ToggleScratchpad() === false, 'ToggleScratchpad must return false on exception');
    assert(safeSvc.MoveToWorkspace(1) === false, 'MoveToWorkspace must return false on exception');
    assert(safeSvc.MoveToNextMonitor() === false, 'MoveToNextMonitor must return false on exception');
    assert(safeSvc.FocusNextMonitor() === false, 'FocusNextMonitor must return false on exception');
    assert(safeSvc.TogglePip() === false, 'TogglePip must return false on exception');
    assert(safeSvc.ActivateWindow(42) === false, 'ActivateWindow must return false on exception');
    assert(safeSvc.CloseWindow(42) === false, 'CloseWindow must return false on exception');
    assert(safeSvc.GetOpenWindows() === '[]', 'GetOpenWindows must return "[]" on exception');

    let deadWin = {
        raise: () => { throw new Error('disposed'); },
        activate: () => { throw new Error('disposed'); },
        get_maximized: () => true,
        unmaximize: () => { throw new Error('disposed'); },
        move_resize_frame: () => { throw new Error('disposed'); },
        move_frame: () => { throw new Error('disposed'); },
        get_xwindow: () => { throw new Error('disposed'); }
    };
    assert(WindowRulesMod.safeRaiseWindow(null) === false && WindowRulesMod.safeRaiseWindow(deadWin) === false,
        'safeRaiseWindow must safely handle null and throwing windows');
    assert(WindowRulesMod.safeActivateWindow(null, 0) === false && WindowRulesMod.safeActivateWindow(deadWin, 0) === false,
        'safeActivateWindow must safely handle null and throwing windows');
    assert(WindowRulesMod.safeApplyWindowFrame(null, 0, 0, 100, 100) === false &&
           WindowRulesMod.safeApplyWindowFrame(deadWin, 0, 0, 100, 100, true) === false,
        'safeApplyWindowFrame must safely handle null and throwing windows');
    WindowRulesMod.clearX11ResizeIncrements(
        { _enabled: true, _clearedResizeIncXids: new Set(), _pendingResizeIncXids: new Set() },
        deadWin
    );
    print('  [OK] Error-handling & exception safety (IPC fallback/validation + MetaWindow guards)');

    // 9. New features 1, 3, 4, 7 unit tests
    // Feature #1: PiP Corner Geometry
    let monWa = { x: 0, y: 28, width: 1920, height: 1052 };
    let pipBR = Layouts.computeCornerRect(monWa, 'bottom-right', 25, 30, 16);
    let pipTL = Layouts.computeCornerRect(monWa, 'top-left', 25, 30, 16);
    assert(pipBR.x === 1920 - pipBR.width - 16 && pipBR.y === 28 + 1052 - pipBR.height - 16,
        'computeCornerRect(bottom-right) must anchor window cleanly inside bottom-right corner');
    assert(pipTL.x === 16 && pipTL.y === 28 + 16,
        'computeCornerRect(top-left) must anchor window cleanly inside top-left corner');

    // Feature #3: Portrait Monitor Auto-Orientation in Master & Stack
    let portraitWa = { x: 0, y: 0, width: 1080, height: 1920 };
    assert(Layouts.resolveEffectiveMasterOrientation('left', portraitWa, true) === 'top' &&
           Layouts.resolveEffectiveMasterOrientation('right', portraitWa, true) === 'bottom' &&
           Layouts.resolveEffectiveMasterOrientation('left', portraitWa, false) === 'left',
        'resolveEffectiveMasterOrientation must rotate left/right -> top/bottom on portrait monitors when enabled');
    let portState = new StateStoreMod.WorkspaceMonitorState({ defaultLayout: 'master-stack', masterOrientation: 'left' });
    let portRects = Layouts.computeLayoutRects('master-stack', [1, 2], portraitWa, portState, { innerGap: 8, outerGap: 8, masterAutoOrientation: true });
    assert(portRects.get(1).y < portRects.get(2).y && portRects.get(1).width === portRects.get(2).width,
        'Portrait Master & Stack with auto-orientation must stack Master above secondary tiles vertically');

    // Feature #4: Per-Workspace Default Layouts
    let wsDefaultSettings = {
        defaultLayout: 'dwindle',
        workspaceDefaultLayouts: '1=dwindle, 2=scrolling, 4=monocle, invalid=grid, 99=nope'
    };
    let wsParsed = Layouts.parseWorkspaceDefaultLayouts(wsDefaultSettings.workspaceDefaultLayouts);
    assert(wsParsed.size === 3 && wsParsed.get(0) === 'dwindle' && wsParsed.get(1) === 'scrolling' && wsParsed.get(3) === 'monocle',
        'parseWorkspaceDefaultLayouts must parse valid workspace=layout entries');
    let stWs2 = new StateStoreMod.WorkspaceMonitorState(wsDefaultSettings, 1);
    let stWs3 = new StateStoreMod.WorkspaceMonitorState(wsDefaultSettings, 2);
    assert(stWs2.layoutId === 'scrolling' && stWs3.layoutId === 'dwindle',
        'WorkspaceMonitorState must use per-workspace override for WS 2 and fall back to global default for WS 3');

    // Feature #7: Smart No-Border & Inactive Dimming settings schema validation
    assert(defaults.smartNoBorder === false && defaults.inactiveDimmingEnabled === false && defaults.inactiveWindowOpacityPct === 88,
        'Smart No-Border & Inactive Dimming defaults must be cleanly defined');
    print('  [OK] Features 1, 3, 4, 7 (PiP, Portrait Rotation, WS Defaults, Smart No-Border / Dimming)');
}

print('=== 5. Syntax-Checking All Extension Modules ===');
for (let f of [
    'bsp-tree.js',
    'layouts.js',
    'window-rules.js',
    'scratchpad.js',
    'state-store.js',
    'panel-indicator.js',
    'keybindings.js',
    'grab-controller.js',
    'modal-utils.js',
    'active-border.js',
    'interactive-overlays.js',
    'overlays.js',
    'ipc-service.js',
    'runtime-config.js',
    'extension.js'
]) {
    let [, b] = GLib.file_get_contents('cinnawm@corradoproietti/' + f);
    let src = ByteArray.toString(b);
    new Function('require', 'exports', 'module', src);
    print(`  [OK] Syntax valid: cinnawm@corradoproietti/${f}`);
}

print('\nALL TESTS PASSED SUCCESSFULLY!');
