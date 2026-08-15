/**
 * dsh-pet client plugin — thin DSH glue.
 *
 * Wires the DSH plugin protocol (sessions + slots) into the shared pet
 * kernel: a DSH state-source adapter feeds PetStateBus/PetOverlay, pets are
 * fetched from `/api/pets`, and diagnostics go through `src/client/probe.js`.
 *
 * Rendering, interaction, and state consumption live in `src/core/`; this
 * file only knows how to connect them to DSH.
 */
import { createDshStateSource } from "../adapters/dsh-state.js";
import { PetOverlay, PET_CSS } from "../core/PetOverlay.jsx";
import { probe } from "./probe.js";

export const inject = ["slots", "sessions"];

const ASSET_BASE = "/api";

function createFetchPets(assetBase) {
	return async () => {
		const response = await fetch(`${assetBase}/pets`, { cache: "no-store" });
		if (!response.ok) throw new Error(`status ${response.status}`);
		return response.json();
	};
}

export function apply(ctx) {
	const stateSource = createDshStateSource(ctx.sessions);
	// Create the catalog loader ONCE. The slot host may re-render the overlay
	// component frequently; a fresh function identity per render would restart
	// the 30s poll effect every time and can spin the shell.
	const fetchPets = createFetchPets(ASSET_BASE);
	// NOTE: name this differently from the imported PetOverlay — JSX resolves
	// lexical names, and shadowing would make <PetOverlay> recurse into this
	// wrapper forever.
	const DshPetOverlay = () => (
		<PetOverlay stateSource={stateSource} fetchPets={fetchPets} probe={probe} assetBase={ASSET_BASE} />
	);

	ctx.effect(() => {
		try {
			const dispose = ctx.slots.register({ name: "shell.overlay", id: "dsh-pet" }, DshPetOverlay);
			probe("mounted", { hasSlots: ctx.slots !== undefined, hasSessions: ctx.sessions !== undefined });
			return () => dispose();
		} catch (error) {
			probe("apply-error", { message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
			ctx.logger?.warn?.(error);
			return () => {};
		}
	}, "dsh-pet: shell.overlay registration");
	ctx.effect(() => {
		const tagId = "dsh-pet/pet.css";
		if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-pet";
			tag.dataset.pluginCss = tagId;
			tag.textContent = PET_CSS;
			document.head.appendChild(tag);
		}
		return () => {
			document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)?.remove();
		};
	}, "dsh-pet: style tag");
}
