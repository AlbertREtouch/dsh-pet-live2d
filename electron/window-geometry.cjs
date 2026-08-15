"use strict";

function clampBoundsToWorkArea(bounds, workArea) {
	const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
	const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);
	const x = Math.min(Math.max(bounds.x, workArea.x), maxX);
	const y = Math.min(Math.max(bounds.y, workArea.y), maxY);
	return {
		x: Math.round(x),
		y: Math.round(y),
		width: Math.round(bounds.width),
		height: Math.round(bounds.height),
	};
}

function defaultPositionForSize(size, workArea, margin = 16) {
	return {
		x: Math.round(workArea.x + workArea.width - size.width - margin),
		y: Math.round(workArea.y + workArea.height - size.height - margin),
	};
}

/**
 * Keep a small part of the pet itself recoverable without requiring the
 * complete transparent BrowserWindow rectangle to stay on-screen.
 */
function clampBoundsToVisiblePet(bounds, workArea, petBounds, pad, minimumVisible = 24) {
	if (
		petBounds === null ||
		!Number.isFinite(petBounds.width) ||
		!Number.isFinite(petBounds.height) ||
		petBounds.width <= 0 ||
		petBounds.height <= 0
	) {
		return clampBoundsToWorkArea(bounds, workArea);
	}

	const visibleX = Math.min(Math.max(1, minimumVisible), petBounds.width);
	const visibleY = Math.min(Math.max(1, minimumVisible), petBounds.height);
	const minX = workArea.x - pad.left - petBounds.width + visibleX;
	const maxX = workArea.x + workArea.width - pad.left - visibleX;
	const minY = workArea.y - pad.top - petBounds.height + visibleY;
	const maxY = workArea.y + workArea.height - pad.top - visibleY;

	return {
		x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
		y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
		width: Math.round(bounds.width),
		height: Math.round(bounds.height),
	};
}

/**
 * Resolve one drag move against the pet's recoverable area, not the complete
 * transparent shell rectangle.
 *
 * The window may extend beyond the work area while the grabbed part of the
 * pet follows the cursor. Only an extreme edge grab can hit the small
 * minimum-visible guard; that axis is then rebased so overshoot cannot build.
 */
function resolveDragMove({ cursor, dragOffset, size, workArea, petBounds, pad, minimumVisible = 24 }) {
	const requested = {
		x: cursor.x - dragOffset.x,
		y: cursor.y - dragOffset.y,
		width: size.width,
		height: size.height,
	};
	const bounds = clampBoundsToVisiblePet(requested, workArea, petBounds, pad, minimumVisible);
	const clampedX = bounds.x !== Math.round(requested.x);
	const clampedY = bounds.y !== Math.round(requested.y);

	return {
		bounds,
		dragOffset: {
			x: clampedX ? cursor.x - bounds.x : dragOffset.x,
			y: clampedY ? cursor.y - bounds.y : dragOffset.y,
		},
		clamped: { x: clampedX, y: clampedY },
	};
}

function clipRect(rect, windowSize) {
	const left = Math.max(0, Math.round(rect.x));
	const top = Math.max(0, Math.round(rect.y));
	const right = Math.min(windowSize.width, Math.round(rect.x + rect.width));
	const bottom = Math.min(windowSize.height, Math.round(rect.y + rect.height));
	if (right <= left || bottom <= top) return null;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Build the native Windows interaction/drawing shape for the transparent
 * shell. The bubble band and pet (plus its drop-shadow) stay live; transparent
 * side/bottom padding falls through to the application underneath. The
 * optional Live2D cockpit gets its own region when open.
 */
function buildWindowShape({
	windowSize,
	petBounds,
	debugPanel,
	pad,
	shadowMargin = 10,
	debugPanelWidth = 300,
	debugPanelInset = 16,
	debugPanelShadow = 8,
}) {
	const fullWindow = [{ x: 0, y: 0, width: windowSize.width, height: windowSize.height }];
	if (
		petBounds === null ||
		!Number.isFinite(petBounds.width) ||
		!Number.isFinite(petBounds.height) ||
		petBounds.width <= 0 ||
		petBounds.height <= 0
	) {
		return fullWindow;
	}

	const compactWidth = Math.min(windowSize.width, petBounds.width + pad.left + pad.right);
	const rects = [
		// The speech bubble is centered above the pet and may use the complete
		// compact width, so preserve that narrow top band.
		clipRect({ x: 0, y: 0, width: compactWidth, height: pad.top }, windowSize),
		clipRect(
			{
				x: pad.left - shadowMargin,
				y: pad.top - shadowMargin,
				width: petBounds.width + shadowMargin * 2,
				height: petBounds.height + shadowMargin * 2,
			},
			windowSize,
		),
	];

	if (debugPanel) {
		const panelX = windowSize.width - debugPanelInset - debugPanelWidth - debugPanelShadow;
		const panelHeight = Math.min(
			windowSize.height - Math.max(0, debugPanelInset - debugPanelShadow),
			Math.ceil(windowSize.height * 0.7) + debugPanelShadow * 2,
		);
		rects.push(
			clipRect(
				{
					x: panelX,
					y: debugPanelInset - debugPanelShadow,
					width: debugPanelWidth + debugPanelShadow * 2,
					height: panelHeight,
				},
				windowSize,
			),
		);
	}

	return rects.filter(Boolean);
}

module.exports = {
	buildWindowShape,
	clampBoundsToVisiblePet,
	clampBoundsToWorkArea,
	defaultPositionForSize,
	resolveDragMove,
};
