import type { Preset } from '@comapeo/core/schema.js'

type Tags = Preset['tags']

interface Categorisable {
	tags: Tags
	presetRef?: { docId: string } | undefined
}

type PresetDoc = Preset & { docId: string }

/**
 * Matches CoMapeo Desktop: the preset whose tags best match the document's
 * tags (ties go to the earliest preset), otherwise the document's presetRef.
 */
export function matchCategory<T extends PresetDoc>(
	doc: Categorisable,
	presets: T[],
): T | undefined {
	let best: T | undefined
	let bestScore = 0
	for (const preset of presets) {
		const keys = Object.keys(preset.tags)
		let score = 0
		for (const key of keys) {
			const presetValue = preset.tags[key]
			const docValue = Object.hasOwn(doc.tags, key) ? doc.tags[key] : undefined
			if (presetValue === docValue) {
				score++
			} else if (
				Array.isArray(presetValue) &&
				!Array.isArray(docValue) &&
				docValue !== undefined &&
				presetValue.includes(docValue)
			) {
				score++
			}
		}
		const percent = (score / keys.length) * 100
		if (percent > bestScore) {
			bestScore = percent
			best = preset
		}
	}
	if (!best && doc.presetRef?.docId) {
		best = presets.find((p) => p.docId === doc.presetRef?.docId)
	}
	return best
}

export interface InlineIcon {
	mimeType: 'image/svg+xml' | 'image/png'
	data: string
}

const ICON_FETCH_TIMEOUT_MS = 5000

export interface IconSource {
	getIconUrl(
		iconId: string,
		opts:
			| { mimeType: 'image/svg+xml'; size: 'medium' }
			| { mimeType: 'image/png'; size: 'medium'; pixelDensity: 2 },
	): Promise<string>
}

export function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const onAbort = () => reject(signal.reason)
		signal.addEventListener('abort', onAbort, { once: true })
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', onAbort))
	})
}

/**
 * Fetches an icon from the media server, preferring SVG over PNG. Gives up
 * after a few seconds in all, or when `cancel` aborts.
 */
export async function fetchIcon(
	icons: IconSource,
	iconId: string,
	cancel: AbortSignal,
): Promise<InlineIcon | undefined> {
	const signal = AbortSignal.any([
		AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
		cancel,
	])
	const attempts = [
		{ mimeType: 'image/svg+xml', size: 'medium' },
		{ mimeType: 'image/png', size: 'medium', pixelDensity: 2 },
	] as const
	for (const opts of attempts) {
		try {
			const url = await untilAborted(icons.getIconUrl(iconId, opts), signal)
			const res = await fetch(url, { signal })
			if (!res.ok) {
				await res.body?.cancel()
				continue
			}
			const data = Buffer.from(await res.arrayBuffer()).toString('base64')
			return { mimeType: opts.mimeType, data }
		} catch {
			if (signal.aborted) return undefined
		}
	}
	return undefined
}
