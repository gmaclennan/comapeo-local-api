import type { MapeoProject } from '@comapeo/core'
import type { ObservationValue, TrackValue } from '@comapeo/core/schema.js'

export function observationValue(
	overrides: Partial<ObservationValue> = {},
): ObservationValue {
	return {
		schemaName: 'observation',
		tags: {},
		attachments: [],
		...overrides,
	}
}

export function trackValue(overrides: Partial<TrackValue> = {}): TrackValue {
	return {
		schemaName: 'track',
		locations: [
			{
				timestamp: '2026-01-01T10:00:00.000Z',
				mocked: false,
				coords: { latitude: -3.1, longitude: -55.1 },
			},
			{
				timestamp: '2026-01-01T10:00:10.000Z',
				mocked: false,
				coords: { latitude: -3.2, longitude: -55.2 },
			},
			{
				timestamp: '2026-01-01T10:00:20.000Z',
				mocked: false,
				coords: { latitude: -3.3, longitude: -55.3 },
			},
		],
		observationRefs: [],
		tags: {},
		...overrides,
	}
}

export async function presetByName(project: MapeoProject, name: string) {
	const presets = await project.preset.getMany()
	const preset = presets.find((p) => p.name === name)
	if (!preset) throw new Error(`No preset named ${name}`)
	return preset
}
