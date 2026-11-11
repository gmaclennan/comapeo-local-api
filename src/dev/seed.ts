import { randomBytes } from 'node:crypto'

import type { MapeoProject } from '@comapeo/core'
import type {
	Field,
	Observation,
	ObservationValue,
	Preset,
	Track,
	TrackValue,
} from '@comapeo/core/schema.js'

import { writeAudioFile, writePhotoFiles } from './media.ts'

type Attachment = Observation['attachments'][number]
type TagValue = Observation['tags'][string]
type PresetDoc = Preset & { docId: string; versionId: string }
type FieldDoc = Field & { docId: string }

export type Random = () => number

/** Deterministic PRNG (mulberry32) so a seed reproduces the same data. */
export function createRandom(seed: number): Random {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function pick<T>(random: Random, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)] as T
}

function gaussian(random: Random): number {
	return (
		Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
	)
}

// Communities along the lower Tapajós river, Pará, Brazil
const SETTLEMENTS: ReadonlyArray<{ name: string; lon: number; lat: number }> = [
	{ name: 'Alter do Chão', lon: -54.95, lat: -2.5 },
	{ name: 'Belterra', lon: -54.94, lat: -2.64 },
	{ name: 'Pindobal', lon: -55.02, lat: -2.75 },
	{ name: 'Maguari', lon: -55.07, lat: -2.82 },
	{ name: 'Jamaraquá', lon: -55.04, lat: -2.89 },
	{ name: 'Suruacá', lon: -55.12, lat: -2.97 },
]

const WORDS = [
	'açaí',
	'babaçu',
	'cedar',
	'brazil nut',
	'wild cacao',
	'andiroba',
	'copaíba',
	'tucumã',
	'rubber',
	'mahogany',
]

const NOTES = [
	'Seen on the morning walk.',
	'Needs a follow-up visit in the dry season.',
	'Reported by a community member.',
	'Recent tracks nearby.',
	'Water level high.',
	'Area recently burned.',
	'',
]

function fieldValue(random: Random, field: Field): TagValue | undefined {
	switch (field.type) {
		case 'number':
			return Math.round(random() * 100)
		case 'selectOne':
			return field.options?.length
				? pick(random, field.options).value
				: undefined
		case 'selectMultiple': {
			const values = (field.options ?? [])
				.filter(() => random() < 0.4)
				.map((o) => o.value)
			return values.length ? values : undefined
		}
		case 'date':
			return new Date(Date.now() - random() * 365 * 864e5)
				.toISOString()
				.slice(0, 10)
		default:
			return field.tagKey === 'name'
				? `${pick(random, SETTLEMENTS).name} ${Math.ceil(random() * 20)}`
				: pick(random, WORDS)
	}
}

function categoryTags(
	random: Random,
	preset: PresetDoc,
	fields: Map<string, FieldDoc>,
): Observation['tags'] {
	const tags: Observation['tags'] = { ...preset.tags }
	for (const ref of preset.fieldRefs) {
		const field = fields.get(ref.docId)
		if (!field || random() < 0.2) continue
		const value = fieldValue(random, field)
		if (value !== undefined) tags[field.tagKey] = value
	}
	const note = pick(random, NOTES)
	if (note) tags.notes = note
	return tags
}

function position(lon: number, lat: number, random: Random, timestamp: string) {
	return {
		timestamp,
		mocked: false,
		coords: {
			latitude: lat,
			longitude: lon,
			altitude: Math.round(20 + random() * 80),
			accuracy: Math.round(3 + random() * 25),
		},
	}
}

export async function addPhoto(
	project: MapeoProject,
	mediaDir: string,
	seed: number,
): Promise<Attachment> {
	const files = await writePhotoFiles(mediaDir, seed)
	const blob = await project.$blobs.create(files, { mimeType: 'image/jpeg' })
	return {
		driveDiscoveryId: blob.driveId,
		name: blob.name,
		type: 'photo',
		hash: blob.hash,
		external: false,
	}
}

export async function addAudio(
	project: MapeoProject,
	mediaDir: string,
	seed: number,
): Promise<Attachment> {
	const original = await writeAudioFile(mediaDir, seed)
	const blob = await project.$blobs.create(
		{ original },
		{ mimeType: 'audio/wav' },
	)
	return {
		driveDiscoveryId: blob.driveId,
		name: blob.name,
		type: 'audio',
		hash: blob.hash,
		external: false,
	}
}

/** An attachment in a real drive whose blob does not exist, as before sync. */
export function missingAttachment(
	driveDiscoveryId: string,
	type: 'photo' | 'audio',
): Attachment {
	return {
		driveDiscoveryId,
		name: randomBytes(8).toString('hex'),
		type,
		hash: randomBytes(32).toString('hex'),
		external: false,
	}
}

export interface SeedOptions {
	observations: number
	tracks: number
	photos: number
	audio: number
	seed: number
	mediaDir: string
}

export interface SeedSummary {
	observations: number
	withoutLocation: number
	tracks: number
	photos: number
	audio: number
	missing: number
}

async function loadCategories(project: MapeoProject) {
	const presets = (await project.preset.getMany()) as PresetDoc[]
	const fields = new Map(
		((await project.field.getMany()) as FieldDoc[]).map((f) => [f.docId, f]),
	)
	return {
		pointPresets: presets.filter((p) => p.geometry.includes('point')),
		linePresets: presets.filter((p) => p.geometry.includes('line')),
		fields,
	}
}

export async function randomObservation(
	project: MapeoProject,
	random: Random,
	{ withLocation = true }: { withLocation?: boolean } = {},
) {
	const { pointPresets, fields } = await loadCategories(project)
	const preset = pick(random, pointPresets)
	const settlement = pick(random, SETTLEMENTS)
	const lon = settlement.lon + gaussian(random) * 0.02
	const lat = settlement.lat + gaussian(random) * 0.02
	const timestamp = new Date(Date.now() - random() * 180 * 864e5).toISOString()
	const value: ObservationValue = {
		schemaName: 'observation',
		tags: categoryTags(random, preset, fields),
		attachments: [],
		presetRef: { docId: preset.docId, versionId: preset.versionId },
		metadata: {
			manualLocation: false,
			position: position(lon, lat, random, timestamp),
		},
	}
	if (withLocation) {
		value.lat = Number(lat.toFixed(6))
		value.lon = Number(lon.toFixed(6))
	} else {
		delete value.metadata
	}
	return value
}

function randomTrack(
	random: Random,
	preset: PresetDoc | undefined,
	fields: Map<string, FieldDoc>,
): TrackValue {
	const settlement = pick(random, SETTLEMENTS)
	let lon = settlement.lon + gaussian(random) * 0.01
	let lat = settlement.lat + gaussian(random) * 0.01
	let heading = random() * 2 * Math.PI
	let time = Date.now() - random() * 120 * 864e5
	const count = 80 + Math.floor(random() * 200)
	const locations = []
	for (let i = 0; i < count; i++) {
		locations.push(position(lon, lat, random, new Date(time).toISOString()))
		heading += gaussian(random) * 0.3
		const step = (5 + random() * 15) / 111_000
		lon += Math.cos(heading) * step
		lat += Math.sin(heading) * step
		time += 10_000
	}
	return {
		schemaName: 'track',
		locations: locations as Track['locations'],
		observationRefs: [],
		tags: preset ? categoryTags(random, preset, fields) : {},
		...(preset && {
			presetRef: { docId: preset.docId, versionId: preset.versionId },
		}),
	}
}

/** Fills a project with plausible observations, tracks and media. */
export async function seedProject(
	project: MapeoProject,
	opts: SeedOptions,
): Promise<SeedSummary> {
	const random = createRandom(opts.seed)
	const { linePresets, fields } = await loadCategories(project)
	const summary: SeedSummary = {
		observations: 0,
		withoutLocation: 0,
		tracks: 0,
		photos: 0,
		audio: 0,
		missing: 0,
	}
	let driveId: string | undefined
	for (let i = 0; i < opts.observations; i++) {
		const withLocation = i % 25 !== 3
		const value = await randomObservation(project, random, { withLocation })
		if (summary.photos < opts.photos && random() < 0.25) {
			const n = 1 + Math.floor(random() * 3)
			for (let j = 0; j < n && summary.photos < opts.photos; j++) {
				const photo = await addPhoto(
					project,
					opts.mediaDir,
					opts.seed * 1000 + summary.photos,
				)
				driveId = photo.driveDiscoveryId
				value.attachments.push(photo)
				summary.photos++
			}
		}
		if (summary.audio < opts.audio && random() < 0.1) {
			value.attachments.push(
				await addAudio(project, opts.mediaDir, summary.audio),
			)
			summary.audio++
		}
		if (driveId && summary.missing < 2 && i % 50 === 7) {
			value.attachments.push(
				missingAttachment(driveId, summary.missing === 0 ? 'photo' : 'audio'),
			)
			summary.missing++
		}
		await project.observation.create(value)
		summary.observations++
		if (!withLocation) summary.withoutLocation++
	}
	if (summary.audio === 0 && opts.audio > 0 && opts.observations > 0) {
		const value = await randomObservation(project, random)
		value.attachments.push(await addAudio(project, opts.mediaDir, 0))
		await project.observation.create(value)
		summary.audio++
		summary.observations++
	}
	if (summary.missing === 0 && driveId) {
		const value = await randomObservation(project, random)
		value.attachments.push(missingAttachment(driveId, 'photo'))
		await project.observation.create(value)
		summary.missing++
		summary.observations++
	}
	for (let i = 0; i < opts.tracks; i++) {
		const preset = linePresets.length ? pick(random, linePresets) : undefined
		await project.track.create(randomTrack(random, preset, fields))
		summary.tracks++
	}
	return summary
}
