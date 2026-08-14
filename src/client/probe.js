/** Best-effort self-report to the host plugin's diagnostics endpoint. */
export function probe(event, data) {
	try {
		fetch("/api/pets/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				event,
				href: location.href,
				ua: navigator.userAgent,
				time: Date.now(),
				...data,
			}),
		}).catch(() => {});
	} catch {
		/* diagnostics must never break the pet */
	}
}
