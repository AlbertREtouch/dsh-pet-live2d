/**
 * Standalone pet entry — framework-free host surface.
 *
 * Bundled as lib/standalone.js (IIFE, React included). The DSH plugin
 * bundle externalizes React; this target must not.
 *
 * `mount()` injects the shared pet kernel CSS, creates a mock state source
 * and renders the overlay. Electron (Phase 1) loads this bundle inside its
 * shell window; `pet.html` can use it in a plain browser for development.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMockStateSource } from "../adapters/mock.js";
import { PetOverlay, PET_CSS } from "../core/PetOverlay.jsx";

function consoleProbe(event, data) {
	try {
		console.info("[dsh-pet]", event, data ?? {});
	} catch {
		/* diagnostics must never break the pet */
	}
}

function createFetchPets(assetBase, fetchPets) {
	if (typeof fetchPets === "function") return fetchPets;
	return async () => {
		const response = await fetch(`${assetBase}/pets`, { cache: "no-store" });
		if (!response.ok) throw new Error(`status ${response.status}`);
		return response.json();
	};
}

function injectCss() {
	const tagId = "dsh-pet/pet.css";
	if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return () => {};
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-pet";
	tag.dataset.pluginCss = tagId;
	tag.textContent = PET_CSS;
	document.head.appendChild(tag);
	return () => tag.remove();
}

export function mount(options = {}) {
	const {
		target = document.body,
		assetBase = "http://127.0.0.1:3410/api",
		fetchPets = null,
		probe = consoleProbe,
		personality = undefined,
		stateSource = null,
	} = options;
	const source = stateSource ?? createMockStateSource();
	const disposeCss = injectCss();
	const root = createRoot(target);
	root.render(createElement(PetOverlay, {
		stateSource: source,
		fetchPets: createFetchPets(assetBase, fetchPets),
		probe,
		assetBase,
		personality,
	}));
	return () => {
		root.unmount();
		source.dispose?.();
		disposeCss();
	};
}

export const standalone = { mount };
