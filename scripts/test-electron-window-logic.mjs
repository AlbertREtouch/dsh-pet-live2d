import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	buildWindowShape,
	clampBoundsToVisiblePet,
	clampBoundsToWorkArea,
	defaultPositionForSize,
	resolveDragMove,
} = require("../electron/window-geometry.cjs");

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 288, height: 412 };
const maxX = workArea.width - size.width;
const maxY = workArea.height - size.height;
const pad = { left: 24, top: 64, right: 24, bottom: 8 };
const petBounds = { width: 240, height: 340 };

assert.deepEqual(
	clampBoundsToWorkArea({ x: 9999, y: -200, ...size }, workArea),
	{ x: maxX, y: 0, ...size },
	"window bounds clamp to the work area",
);

assert.deepEqual(
	defaultPositionForSize(size, workArea),
	{ x: 1616, y: 612 },
	"fresh startup uses the real pet window size for bottom-right placement",
);

let offset = { x: pad.left + petBounds.width / 2, y: pad.top + petBounds.height / 2 };
const edgeCursor = { x: workArea.x + workArea.width - 1, y: workArea.y + workArea.height - 1 };
const followed = resolveDragMove({ cursor: edgeCursor, dragOffset: offset, size, workArea, petBounds, pad });
assert.deepEqual(
	followed.bounds,
	{ x: edgeCursor.x - offset.x, y: edgeCursor.y - offset.y, ...size },
	"a normal grab follows the cursor to the work-area edge even when the transparent window extends offscreen",
);
assert.deepEqual(followed.clamped, { x: false, y: false });

const reversed = resolveDragMove({
	cursor: { x: edgeCursor.x - 1, y: edgeCursor.y - 1 },
	dragOffset: offset,
	size,
	workArea,
	petBounds,
	pad,
});
assert.equal(reversed.bounds.x, followed.bounds.x - 1, "one pixel of reverse cursor motion immediately moves the window left");
assert.equal(reversed.bounds.y, followed.bounds.y - 1, "one pixel of reverse cursor motion immediately moves the window up");

// Grabbing the extreme left/top pixel may otherwise leave only one pixel of
// the pet recoverable. Keep a small 24px strip and rebase that rare clamp.
offset = { x: pad.left + 1, y: pad.top + 1 };
const guarded = resolveDragMove({ cursor: edgeCursor, dragOffset: offset, size, workArea, petBounds, pad });
assert.deepEqual(guarded.clamped, { x: true, y: true });
assert.equal(guarded.bounds.x, workArea.width - pad.left - 24);
assert.equal(guarded.bounds.y, workArea.height - pad.top - 24);
const guardedReverse = resolveDragMove({
	cursor: { x: edgeCursor.x - 1, y: edgeCursor.y - 1 },
	dragOffset: guarded.dragOffset,
	size,
	workArea,
	petBounds,
	pad,
});
assert.equal(guardedReverse.bounds.x, guarded.bounds.x - 1, "the 24px recovery guard does not accumulate horizontal overshoot");
assert.equal(guardedReverse.bounds.y, guarded.bounds.y - 1, "the 24px recovery guard does not accumulate vertical overshoot");

assert.deepEqual(
	clampBoundsToVisiblePet({ x: 9999, y: -9999, ...size }, workArea, petBounds, pad),
	{ x: workArea.width - pad.left - 24, y: -pad.top - petBounds.height + 24, ...size },
	"saved positions recover at least 24px of the pet after display changes",
);

const shape = buildWindowShape({
	windowSize: size,
	petBounds,
	debugPanel: false,
	pad,
});
const contains = (rects, x, y) => rects.some((rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
assert.equal(contains(shape, 24 + 120, 64 + 170), true, "pet center remains interactive");
assert.equal(contains(shape, 1, 20), true, "speech-bubble band remains drawable");
assert.equal(contains(shape, size.width - 1, size.height - 1), false, "transparent bottom-right padding falls through");

const debugShape = buildWindowShape({
	windowSize: { width: 648, height: 600 },
	petBounds,
	debugPanel: true,
	pad,
});
assert.equal(contains(debugShape, 648 - 16 - 150, 100), true, "Live2D cockpit remains interactive");

console.log("ELECTRON WINDOW LOGIC PASS");
