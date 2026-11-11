import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { describe, test } from 'node:test'

import type { TrackValue } from '@comapeo/core/schema.js'

import { createDevManager } from '../src/dev/manager.ts'
import { addAudio, addPhoto, missingAttachment } from '../src/dev/seed.ts'
import { createLocalApiServer } from '../src/index.ts'
import { RpcError, TestClient, type Wire } from './helpers/client.ts'
import {
	observationValue,
	presetByName,
	trackValue,
} from './helpers/fixtures.ts'
import { APP, setup, tempDir } from './helpers/server.ts'

const OBSERVATION_BUILTINS = [
	'id',
	'category',
	'notes',
	'created_at',
	'updated_at',
	'created_by',
	'updated_by',
	'accuracy',
	'altitude',
	'photo_count',
	'audio_count',
]
const TRACK_BUILTINS = [
	'id',
	'category',
	'created_at',
	'updated_at',
	'created_by',
	'updated_by',
	'start_time',
	'end_time',
]

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
	const err = await promise.then(
		() => assert.fail('expected an error'),
		(e: unknown) => e,
	)
	assert.ok(err instanceof RpcError, String(err))
	return err
}

/** Adds a category using a text field per tag key and returns each key's column name. */
async function fieldColumnNames(
	c: TestClient,
	project: Awaited<ReturnType<typeof setup>>['project'],
	projectId: string,
	tagKeys: string[],
): Promise<Map<string, string>> {
	const fields = []
	for (const tagKey of tagKeys) {
		fields.push(
			await project.field.create({
				schemaName: 'field',
				tagKey,
				type: 'text',
				label: tagKey,
			}),
		)
	}
	await project.preset.create({
		schemaName: 'preset',
		name: 'Keys',
		geometry: ['point'],
		tags: { keys: 'yes' },
		addTags: {},
		removeTags: {},
		fieldRefs: fields.map((f) => ({ docId: f.docId, versionId: f.versionId })),
		terms: [],
	})
	const [observations] = (await c.request('layers.list', { projectId })).layers
	const names = new Map<string, string>()
	for (const col of observations.columns) {
		assert.match(col.name, /^[a-z_][a-z0-9_]*$/)
		if (col.role === 'field' && tagKeys.includes(col.label)) {
			names.set(col.label, col.name)
		}
	}
	assert.equal(
		new Set(observations.columns.map((col: Wire) => col.name)).size,
		observations.columns.length,
	)
	assert.equal(names.size, tagKeys.length)
	return names
}

async function allFeatures(
	client: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['client']>>,
	params: Record<string, unknown>,
) {
	const features = []
	let cursor: string | null = null
	let pages = 0
	do {
		const page: { features: Array<{ id: string }>; nextCursor: string | null } =
			await client.request('layers.getFeatures', { ...params, cursor })
		features.push(...page.features)
		cursor = page.nextCursor
		pages++
	} while (cursor)
	return { features, pages }
}

describe('projects.list', () => {
	test('lists joined projects with name, colour and description', async (t) => {
		const { client, manager, projectId } = await setup(t)
		const otherId = await manager.createProject({
			name: 'Second',
			projectColor: '#ff0000',
			projectDescription: 'About the second project',
		})
		const c = await client()
		const { projects } = await c.request('projects.list')
		const byId = new Map(
			projects.map((p: { projectId: string }) => [p.projectId, p]),
		)
		assert.deepEqual(byId.get(projectId), { projectId, name: 'Test project' })
		assert.deepEqual(byId.get(otherId), {
			projectId: otherId,
			name: 'Second',
			color: '#ff0000',
			description: 'About the second project',
		})
	})
})

describe('errors', () => {
	test('unknown method, missing params, unknown project and layer', async (t) => {
		const { client, projectId } = await setup(t)
		const c = await client()
		assert.equal(
			(await rpcError(c.request('features.create', {}))).code,
			'METHOD_NOT_FOUND',
		)
		assert.equal(
			(await rpcError(c.request('layers.list', {}))).code,
			'INVALID_PARAMS',
		)
		assert.equal(
			(await rpcError(c.request('layers.list'))).code,
			'INVALID_PARAMS',
		)
		assert.equal(
			(await rpcError(c.request('layers.list', { projectId: 'nope' }))).code,
			'PROJECT_NOT_FOUND',
		)
		assert.equal(
			(
				await rpcError(
					c.request('layers.getFeatures', { projectId, layerId: 'nope' }),
				)
			).code,
			'LAYER_NOT_FOUND',
		)
		for (const limit of [0, 5001, 1.5, '10']) {
			const err = await rpcError(
				c.request('layers.getFeatures', {
					projectId,
					layerId: 'observations',
					limit,
				}),
			)
			assert.equal(err.code, 'INVALID_PARAMS')
		}
		// The connection stays usable after errors
		assert.ok((await c.request('projects.list')).projects.length > 0)
	})

	test('unknown params are ignored', async (t) => {
		const { client, projectId } = await setup(t)
		const c = await client()
		const { layers } = await c.request('layers.list', {
			projectId,
			future: { x: 1 },
		})
		assert.equal(layers.length, 2)
	})

	test('a joined project that core fails to open gives INTERNAL_ERROR, not PROJECT_NOT_FOUND', async (t) => {
		const dev = await createDevManager()
		t.after(() => dev.close())
		const projectId = await dev.manager.createProject({ name: 'p' })
		const failing = new Proxy(dev.manager, {
			get(target, key) {
				if (key === 'getProject') {
					return async () => {
						throw new Error('core could not open the project')
					}
				}
				const value = Reflect.get(target, key, target)
				return typeof value === 'function' ? value.bind(target) : value
			},
		})
		const server = createLocalApiServer({
			manager: failing,
			discoveryDir: await tempDir(t),
			app: APP,
		})
		t.after(() => server.close())
		const { discoveryFilePath } = await server.listen()
		const c = await TestClient.fromDiscoveryFile(discoveryFilePath)
		t.after(() => c.close())
		const err = await rpcError(c.request('layers.list', { projectId }))
		assert.equal(err.code, 'INTERNAL_ERROR')
		assert.match(err.message, /core could not open the project/)
		const unknown = await rpcError(
			c.request('layers.list', { projectId: 'unknown' }),
		)
		assert.equal(unknown.code, 'PROJECT_NOT_FOUND')
	})
})

describe('layers.list', () => {
	test('returns an observations and a tracks layer with built-in, field and tags columns', async (t) => {
		const { client, projectId } = await setup(t)
		const c = await client()
		const { layers } = await c.request('layers.list', { projectId })
		assert.deepEqual(
			layers.map((l: Record<string, string>) => [
				l.layerId,
				l.docType,
				l.geometryType,
			]),
			[
				['observations', 'observation', 'Point'],
				['tracks', 'track', 'LineString'],
			],
		)
		const [observations, tracks] = layers
		const names = (layer: { columns: Array<{ name: string }> }) =>
			layer.columns.map((c) => c.name)

		assert.deepEqual(
			names(observations).slice(0, OBSERVATION_BUILTINS.length),
			OBSERVATION_BUILTINS,
		)
		assert.deepEqual(
			names(tracks).slice(0, TRACK_BUILTINS.length),
			TRACK_BUILTINS,
		)
		for (const layer of layers) {
			const last = layer.columns.at(-1)
			assert.deepEqual(last, {
				name: 'tags',
				type: 'json',
				label: 'All tags',
				role: 'tags',
			})
			const all = names(layer)
			assert.equal(new Set(all).size, all.length, 'names are unique')
			for (const name of all) assert.match(name, /^[a-z_][a-z0-9_]*$/)
			assert.equal(typeof layer.schemaVersion, 'string')
		}

		const buildingType = observations.columns.find(
			(c: { name: string }) => c.name === 'building_type',
		)
		assert.equal(buildingType.role, 'field')
		assert.equal(buildingType.type, 'string')
		assert.equal(buildingType.label, 'Building type')
		assert.deepEqual(buildingType.options[0], {
			value: 'School',
			label: 'School',
		})

		assert.equal(
			observations.columns.find(
				(c: { name: string }) => c.name === 'created_at',
			).type,
			'datetime',
		)
		assert.equal(
			observations.columns.find(
				(c: { name: string }) => c.name === 'photo_count',
			).type,
			'integer',
		)
		// Fields of line categories (River uses "name") appear on tracks
		assert.ok(names(tracks).includes('name'))
		assert.ok(!names(tracks).includes('building_type'))
	})

	test('typed field columns, sanitised names and collisions with built-ins', async (t) => {
		const { client, projectId, project } = await setup(t)
		const before = (
			await (await client()).request('layers.list', { projectId })
		).layers[0]

		const fields = await Promise.all([
			project.field.create({
				schemaName: 'field',
				tagKey: 'category',
				type: 'text',
				label: 'Category tag',
			}),
			project.field.create({
				schemaName: 'field',
				tagKey: 'Tags',
				type: 'text',
				label: 'Tags tag',
			}),
			project.field.create({
				schemaName: 'field',
				tagKey: 'count',
				type: 'number',
				label: 'Count',
			}),
			project.field.create({
				schemaName: 'field',
				tagKey: 'species',
				type: 'selectMultiple',
				label: 'Species',
				options: [
					{ value: 'a', label: 'A' },
					{ value: 'b', label: 'B' },
				],
			}),
			project.field.create({
				schemaName: 'field',
				tagKey: 'level',
				type: 'selectOne',
				label: 'Level',
				options: [
					{ value: 1, label: 'Low' },
					{ value: 2, label: 'High' },
				],
			}),
			project.field.create({
				schemaName: 'field',
				tagKey: '2nd-visit',
				type: 'date',
				label: 'Second visit',
			}),
		])
		await project.preset.create({
			schemaName: 'preset',
			name: 'Survey',
			geometry: ['point'],
			tags: { survey: 'yes' },
			addTags: {},
			removeTags: {},
			fieldRefs: fields.map((f) => ({
				docId: f.docId,
				versionId: f.versionId,
			})),
			terms: [],
		})

		const c = await client()
		const [observations] = (await c.request('layers.list', { projectId }))
			.layers
		assert.notEqual(observations.schemaVersion, before.schemaVersion)
		const byName = new Map<string, Wire>(
			observations.columns.map((col: Wire) => [col.name, col]),
		)
		assert.equal(byName.get('comapeo_category').role, 'builtin')
		assert.equal(byName.get('category').role, 'field')
		assert.equal(byName.get('category').label, 'Category tag')
		assert.equal(byName.get('comapeo_tags').role, 'tags')
		assert.equal(byName.get('tags').role, 'field')
		assert.equal(byName.get('count').type, 'number')
		assert.equal(byName.get('species').type, 'string_list')
		assert.equal(byName.get('level').type, 'number')
		assert.deepEqual(byName.get('level').options, [
			{ value: 1, label: 'Low' },
			{ value: 2, label: 'High' },
		])
		assert.equal(byName.get('_2nd_visit').type, 'datetime')

		const survey = await presetByName(project, 'Survey')
		const obs = await project.observation.create(
			observationValue({
				lat: 1,
				lon: 2,
				tags: {
					survey: 'yes',
					category: 'from a tag',
					Tags: 'tag column',
					count: '12',
					species: 'a',
					level: 'not a number',
					'2nd-visit': '2026-03-04',
				},
				presetRef: { docId: survey.docId, versionId: survey.versionId },
			}),
		)
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		const p = features[0].properties
		assert.equal(p.comapeo_category, 'Survey')
		assert.equal(p.category, 'from a tag')
		assert.equal(p.tags, 'tag column')
		assert.equal(p.count, 12)
		assert.deepEqual(p.species, ['a'])
		assert.equal(p.level, null, 'uncoercible values are null')
		assert.equal(p._2nd_visit, '2026-03-04')
		assert.equal(
			p.comapeo_tags.level,
			'not a number',
			'raw values stay in the tags column',
		)
		assert.equal(p.comapeo_tags.Tags, 'tag column')
	})
})

describe('layers.getFeatures', () => {
	test('observations with and without location, built-in values and every column present', async (t) => {
		const { client, projectId, project } = await setup(t)
		const building = await presetByName(project, 'Building')
		const located = await project.observation.create(
			observationValue({
				lat: -3.2,
				lon: -58.1,
				tags: { type: 'building', 'building-type': 'School', notes: 'hello' },
				presetRef: { docId: building.docId, versionId: building.versionId },
				metadata: {
					position: {
						timestamp: '2026-01-01T00:00:00.000Z',
						coords: {
							latitude: -3.2,
							longitude: -58.1,
							accuracy: 7.5,
							altitude: 42,
						},
					},
				},
			}),
		)
		const unlocated = await project.observation.create(
			observationValue({ tags: { animal: 'jaguar' } }),
		)
		const deleted = await project.observation.create(
			observationValue({ lat: 0, lon: 0 }),
		)
		await project.observation.delete(deleted.docId)

		const c = await client()
		const { layers } = await c.request('layers.list', { projectId })
		const columns = layers[0].columns.map((col: { name: string }) => col.name)
		const result = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
		})
		assert.equal(result.nextCursor, null)
		assert.ok(
			!('removed' in result),
			'removed is only present when ids are given',
		)
		const byId = new Map<string, Wire>(
			result.features.map((f: Wire) => [f.id, f]),
		)
		assert.equal(byId.size, 2, 'deleted observations are left out')

		const a = byId.get(located.docId)
		assert.equal(a.version, located.versionId)
		assert.deepEqual(a.geometry, { type: 'Point', coordinates: [-58.1, -3.2] })
		assert.equal(a.categoryId, building.docId)
		assert.deepEqual(a.attachments, [])
		assert.ok(!('times' in a))
		assert.deepEqual(Object.keys(a.properties).sort(), [...columns].sort())
		assert.equal(a.properties.id, located.docId)
		assert.equal(a.properties.category, 'Building')
		assert.equal(a.properties.building_type, 'School')
		assert.equal(a.properties.created_at, located.createdAt)
		assert.equal(a.properties.updated_at, located.updatedAt)
		assert.equal(a.properties.created_by, 'Test device')
		assert.equal(a.properties.updated_by, 'Test device')
		assert.equal(a.properties.accuracy, 7.5)
		assert.equal(a.properties.altitude, 42)
		assert.equal(a.properties.photo_count, 0)
		assert.equal(a.properties.audio_count, 0)
		assert.deepEqual(a.properties.tags, {
			type: 'building',
			'building-type': 'School',
			notes: 'hello',
		})

		const b = byId.get(unlocated.docId)
		assert.equal(b.geometry, null)
		assert.equal(b.categoryId, null)
		assert.equal(b.properties.category, null)
		assert.equal(b.properties.accuracy, null)
		assert.equal(b.properties.building_type, null)
		assert.deepEqual(Object.keys(b.properties).sort(), [...columns].sort())
	})

	test('pages with a cursor until nextCursor is null', async (t) => {
		const { client, projectId, project } = await setup(t)
		const created = []
		for (let i = 0; i < 7; i++) {
			created.push(
				(await project.observation.create(observationValue({ lat: i, lon: i })))
					.docId,
			)
		}
		const c = await client()
		const { features, pages } = await allFeatures(c, {
			projectId,
			layerId: 'observations',
			limit: 3,
		})
		assert.equal(pages, 3)
		assert.deepEqual(features.map((f) => f.id).sort(), created.sort())

		const exact = await allFeatures(c, {
			projectId,
			layerId: 'observations',
			limit: 7,
		})
		assert.equal(exact.pages, 1)
	})

	test('a cursor survives documents being added between pages', async (t) => {
		const { client, projectId, project } = await setup(t)
		for (let i = 0; i < 4; i++)
			await project.observation.create(observationValue())
		const c = await client()
		const first = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			limit: 2,
		})
		await project.observation.create(observationValue())
		const second = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			limit: 10,
			cursor: first.nextCursor,
		})
		const ids = [...first.features, ...second.features].map(
			(f: { id: string }) => f.id,
		)
		assert.equal(new Set(ids).size, ids.length, 'no feature is returned twice')
		assert.ok(ids.length >= 4)
	})

	test('a malformed or foreign cursor gives INVALID_CURSOR', async (t) => {
		const { client, projectId, project } = await setup(t)
		for (let i = 0; i < 3; i++) {
			await project.track.create(trackValue())
			await project.observation.create(observationValue())
		}
		const c = await client()
		const tracksPage = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'tracks',
			limit: 1,
		})
		for (const cursor of ['garbage', '', tracksPage.nextCursor]) {
			const err = await rpcError(
				c.request('layers.getFeatures', {
					projectId,
					layerId: 'observations',
					cursor,
				}),
			)
			assert.equal(err.code, 'INVALID_CURSOR', cursor)
		}
	})

	test('ids restricts results and lists deleted, unknown and other-layer ids as removed', async (t) => {
		const { client, projectId, project } = await setup(t)
		const kept = await project.observation.create(
			observationValue({ lat: 1, lon: 1 }),
		)
		const gone = await project.observation.create(observationValue())
		await project.observation.delete(gone.docId)
		const track = await project.track.create(trackValue())
		const other = await project.observation.create(observationValue())

		const c = await client()
		const result = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [kept.docId, gone.docId, 'does-not-exist', track.docId, kept.docId],
		})
		assert.deepEqual(
			result.features.map((f: { id: string }) => f.id),
			[kept.docId],
		)
		assert.ok(
			!result.features.some((f: { id: string }) => f.id === other.docId),
		)
		assert.deepEqual(
			[...result.removed].sort(),
			[gone.docId, 'does-not-exist', track.docId].sort(),
		)
		assert.equal(result.nextCursor, null)
	})

	test('ids are paged too, and every requested id is reported exactly once', async (t) => {
		const { client, projectId, project } = await setup(t)
		const ids = []
		for (let i = 0; i < 5; i++)
			ids.push((await project.observation.create(observationValue())).docId)
		const deleted = ids.slice(0, 2)
		for (const id of deleted) await project.observation.delete(id)
		const requested = [...ids, 'missing-1', 'missing-2']

		const c = await client()
		const seenFeatures: string[] = []
		const seenRemoved: string[] = []
		let cursor: string | null = null
		do {
			const page: {
				features: Array<{ id: string }>
				removed: string[]
				nextCursor: string | null
			} = await c.request('layers.getFeatures', {
				projectId,
				layerId: 'observations',
				ids: requested,
				limit: 1,
				cursor,
			})
			assert.ok(page.features.length <= 1)
			assert.ok(Array.isArray(page.removed))
			seenFeatures.push(...page.features.map((f) => f.id))
			seenRemoved.push(...page.removed)
			cursor = page.nextCursor
		} while (cursor)
		assert.deepEqual(seenFeatures.sort(), ids.slice(2).sort())
		assert.deepEqual(
			seenRemoved.sort(),
			[...deleted, 'missing-1', 'missing-2'].sort(),
		)
	})

	test('tracks are LineStrings with times, start and end time and no attachments', async (t) => {
		const { client, projectId, project } = await setup(t)
		const river = await presetByName(project, 'River')
		const track = await project.track.create(
			trackValue({
				tags: { waterway: 'river', type: 'waterway', name: 'Tapajós' },
				presetRef: { docId: river.docId, versionId: river.versionId },
			}),
		)
		const c = await client()
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'tracks',
		})
		assert.equal(features.length, 1)
		const [f] = features
		assert.equal(f.id, track.docId)
		assert.deepEqual(f.geometry, {
			type: 'LineString',
			coordinates: [
				[-55.1, -3.1],
				[-55.2, -3.2],
				[-55.3, -3.3],
			],
		})
		assert.deepEqual(f.times, [
			'2026-01-01T10:00:00.000Z',
			'2026-01-01T10:00:10.000Z',
			'2026-01-01T10:00:20.000Z',
		])
		assert.equal(f.properties.start_time, '2026-01-01T10:00:00.000Z')
		assert.equal(f.properties.end_time, '2026-01-01T10:00:20.000Z')
		assert.equal(f.properties.category, 'River')
		assert.equal(f.properties.name, 'Tapajós')
		assert.equal(f.categoryId, river.docId)
		assert.deepEqual(f.attachments, [])
	})

	test('attachments carry media URLs that serve the bytes, and 404 for a blob not synced', async (t) => {
		const { client, projectId, project } = await setup(t)
		const mediaDir = await tempDir(t)
		const photo = await addPhoto(project, mediaDir, 1)
		const audio = await addAudio(project, mediaDir, 1)
		const missing = missingAttachment(photo.driveDiscoveryId, 'photo')
		const obs = await project.observation.create(
			observationValue({
				lat: 1,
				lon: 1,
				attachments: [photo, audio, missing],
			}),
		)
		const c = await client()
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
		})
		const [f] = features
		assert.equal(f.id, obs.docId)
		assert.equal(f.properties.photo_count, 2)
		assert.equal(f.properties.audio_count, 1)
		const [p, a, m] = f.attachments
		assert.equal(p.type, 'photo')
		assert.equal(p.name, photo.name)
		assert.deepEqual(Object.keys(p.urls).sort(), [
			'original',
			'preview',
			'thumbnail',
		])
		assert.equal(a.type, 'audio')
		assert.deepEqual(Object.keys(a.urls), ['original'])

		const original = await fetch(p.urls.original)
		assert.equal(original.status, 200)
		assert.equal(original.headers.get('content-type'), 'image/jpeg')
		assert.deepEqual(
			Buffer.from(await original.arrayBuffer()),
			await fs.readFile(`${mediaDir}/photo-1-original.jpg`),
		)
		for (const variant of ['thumbnail', 'preview']) {
			const res = await fetch(p.urls[variant])
			assert.equal(res.status, 200, variant)
			assert.deepEqual(
				Buffer.from(await res.arrayBuffer()),
				await fs.readFile(`${mediaDir}/photo-1-${variant}.jpg`),
			)
		}
		const audioRes = await fetch(a.urls.original)
		assert.equal(audioRes.status, 200)
		assert.equal(
			Buffer.from(await audioRes.arrayBuffer())
				.subarray(0, 4)
				.toString(),
			'RIFF',
		)

		const missingRes = await fetch(m.urls.original, {
			signal: AbortSignal.timeout(5000),
		})
		assert.equal(missingRes.status, 404)
		await missingRes.body?.cancel()

		const keys = f.attachments.map((x: { key: string }) => x.key)
		assert.equal(new Set(keys).size, 3)
		for (const key of keys) assert.ok(!key.startsWith('http'))
	})
})

describe('category matching', () => {
	test('tags take precedence over the category reference, which is the fallback', async (t) => {
		const { client, projectId, project } = await setup(t)
		const building = await presetByName(project, 'Building')
		const tree = await presetByName(project, 'Tree')
		const palm = await presetByName(project, 'Palm')
		const treeRef = { docId: tree.docId, versionId: tree.versionId }
		const byTags = await project.observation.create(
			observationValue({ tags: { type: 'building' }, presetRef: treeRef }),
		)
		const byRef = await project.observation.create(
			observationValue({ tags: { unrelated: true }, presetRef: treeRef }),
		)
		// Palm and Tree both match all their tags; the earlier category wins
		const best = await project.observation.create(
			observationValue({
				tags: { type: 'natural', natural: 'tree', tree: 'palm' },
			}),
		)
		const none = await project.observation.create(
			observationValue({ tags: { x: 1 } }),
		)

		const c = await client()
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [byTags.docId, byRef.docId, best.docId, none.docId],
		})
		const category = new Map(
			features.map((f: { id: string; categoryId: string }) => [
				f.id,
				f.categoryId,
			]),
		)
		assert.equal(category.get(byTags.docId), building.docId)
		assert.equal(category.get(byRef.docId), tree.docId)
		const firstFullMatch = (await project.preset.getMany()).find((p) =>
			[tree.docId, palm.docId].includes(p.docId),
		)
		assert.equal(category.get(best.docId), firstFullMatch?.docId)
		assert.equal(category.get(none.docId), null)
	})
})

describe('lang', () => {
	test('category names and column labels follow lang', async (t) => {
		const { client, projectId, project } = await setup(t)
		const building = await presetByName(project, 'Building')
		const field = (await project.field.getMany()).find(
			(f) => f.tagKey === 'building-type',
		)
		assert.ok(field)
		const put = (
			doc: { docId: string; versionId: string },
			docRefType: 'preset' | 'field',
			propertyRef: string,
			message: string,
		) =>
			project.$translation.put({
				schemaName: 'translation',
				docRef: { docId: doc.docId, versionId: doc.versionId },
				docRefType,
				propertyRef,
				languageCode: 'spa',
				message,
			})
		await put(building, 'preset', 'name', 'Edificio')
		await put(field, 'field', 'label', 'Tipo de edificio')
		const obs = await project.observation.create(
			observationValue({ tags: { type: 'building' } }),
		)

		const c = await client()
		const es = await c.request('categories.list', { projectId, lang: 'es' })
		const en = await c.request('categories.list', { projectId })
		const nameOf = (list: Wire) =>
			list.categories.find((x: Wire) => x.categoryId === building.docId).name
		assert.equal(nameOf(es), 'Edificio')
		assert.equal(nameOf(en), 'Building')

		const { layers } = await c.request('layers.list', { projectId, lang: 'es' })
		const column = layers[0].columns.find(
			(col: Wire) => col.name === 'building_type',
		)
		assert.equal(column.label, 'Tipo de edificio')

		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			lang: 'es',
			ids: [obs.docId],
		})
		assert.equal(features[0].properties.category, 'Edificio')
	})
})

describe('categories.list', () => {
	test('lists every category with colour and an inline SVG icon', async (t) => {
		const { client, projectId, project } = await setup(t)
		const presets = await project.preset.getMany()
		const c = await client()
		const { categories } = await c.request('categories.list', { projectId })
		assert.equal(categories.length, presets.length)
		const building = categories.find(
			(x: { name: string }) => x.name === 'Building',
		)
		assert.equal(
			building.categoryId,
			(await presetByName(project, 'Building')).docId,
		)
		assert.equal(building.color, '#B209B2')
		assert.equal(building.icon.mimeType, 'image/svg+xml')
		assert.match(Buffer.from(building.icon.data, 'base64').toString(), /<svg/)
		for (const category of categories) assert.ok(category.icon, category.name)
	})
})

describe('edge cases', () => {
	test('a regional, unknown or malformed lang falls back instead of failing', async (t) => {
		const { client, projectId, project } = await setup(t)
		const building = await presetByName(project, 'Building')
		await project.$translation.put({
			schemaName: 'translation',
			docRef: { docId: building.docId, versionId: building.versionId },
			docRefType: 'preset',
			propertyRef: 'name',
			languageCode: 'por',
			message: 'Edifício',
		})
		const obs = await project.observation.create(
			observationValue({ tags: { type: 'building' } }),
		)
		const c = await client()
		const nameFor = async (lang: string) => {
			const { categories } = await c.request('categories.list', {
				projectId,
				lang,
			})
			return categories.find((x: Wire) => x.categoryId === building.docId).name
		}
		assert.equal(await nameFor('pt-BR'), 'Edifício')
		assert.equal(await nameFor('pt_BR'), 'Edifício')
		for (const lang of ['xx', '!!!', 'zz-ZZ-zz-zz', 'x'.repeat(3000), '']) {
			assert.equal(await nameFor(lang), 'Building', JSON.stringify(lang))
		}
		const { layers } = await c.request('layers.list', {
			projectId,
			lang: '!!!',
		})
		assert.equal(layers.length, 2)
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			lang: 'pt_BR',
			ids: [obs.docId],
		})
		assert.equal(features[0].properties.category, 'Edifício')
	})

	test('an empty project has no features, and ids: [] returns nothing', async (t) => {
		const { client, projectId } = await setup(t)
		const c = await client()
		for (const layerId of ['observations', 'tracks']) {
			assert.deepEqual(
				await c.request('layers.getFeatures', { projectId, layerId }),
				{ features: [], nextCursor: null },
			)
			assert.deepEqual(
				await c.request('layers.getFeatures', { projectId, layerId, ids: [] }),
				{ features: [], removed: [], nextCursor: null },
			)
		}
	})

	test('datetime columns hold only ISO 8601 values and number columns only decimals', async (t) => {
		const { client, projectId, project } = await setup(t)
		const dates = [
			'2026-03-04',
			'2026-03-04T10:20:30.000Z',
			'March 4, 2026',
			'04/03/2026',
			'1',
			'2026',
		]
		const numbers = ['0x10', '1e3', ' 12.5 ', 'Infinity', '-3']
		const fields = await Promise.all([
			...dates.map((_, i) =>
				project.field.create({
					schemaName: 'field',
					tagKey: `d${i}`,
					type: 'date',
					label: `Date ${i}`,
				}),
			),
			...numbers.map((_, i) =>
				project.field.create({
					schemaName: 'field',
					tagKey: `n${i}`,
					type: 'number',
					label: `Number ${i}`,
				}),
			),
		])
		await project.preset.create({
			schemaName: 'preset',
			name: 'Typed',
			geometry: ['point'],
			tags: { typed: 'yes' },
			addTags: {},
			removeTags: {},
			fieldRefs: fields.map((f) => ({
				docId: f.docId,
				versionId: f.versionId,
			})),
			terms: [],
		})
		const tags: Record<string, string> = { typed: 'yes' }
		dates.forEach((v, i) => (tags[`d${i}`] = v))
		numbers.forEach((v, i) => (tags[`n${i}`] = v))
		const obs = await project.observation.create(observationValue({ tags }))
		const c = await client()
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		const p = features[0].properties
		assert.deepEqual(
			dates.map((_, i) => p[`d${i}`]),
			['2026-03-04', '2026-03-04T10:20:30.000Z', null, null, null, null],
		)
		assert.deepEqual(
			numbers.map((_, i) => p[`n${i}`]),
			[null, 1000, 12.5, null, -3],
		)
	})

	test('column names avoid QGIS expression keywords and stay distinct and stable for non-Latin keys', async (t) => {
		const { client, manager, projectId, project } = await setup(t)
		const keys = ['end', 'null', 'Like', '名前', '日付']
		const c = await client()
		const first = await fieldColumnNames(c, project, projectId, keys)
		assert.equal(first.get('end'), 'end_')
		assert.equal(first.get('null'), 'null_')
		assert.equal(first.get('Like'), 'like_')
		assert.notEqual(first.get('名前'), first.get('日付'))

		const otherId = await manager.createProject({ name: 'Reversed' })
		const other = await manager.getProject(otherId)
		const second = await fieldColumnNames(
			c,
			other,
			otherId,
			[...keys].reverse(),
		)
		assert.deepEqual(Object.fromEntries(second), Object.fromEntries(first))
	})

	test('tag keys that sanitise to the same name are named the same whatever the field order', async (t) => {
		const { client, manager, projectId, project } = await setup(t)
		const long = 'A very long tag key '.repeat(15)
		const keys = [
			'Foo Bar',
			'foo-bar',
			'foo_bar',
			'end',
			'end_',
			'1st',
			'_1st',
			long,
			`${long}!`,
		]
		const c = await client()
		const first = await fieldColumnNames(c, project, projectId, keys)
		assert.equal(first.get('foo_bar'), 'foo_bar')
		assert.match(first.get('Foo Bar') ?? '', /^foo_bar_[0-9a-f]{6}$/)
		assert.match(first.get('foo-bar') ?? '', /^foo_bar_[0-9a-f]{6}$/)
		assert.equal(first.get('end_'), 'end_')
		assert.match(first.get('end') ?? '', /^end__[0-9a-f]{6}$/)
		assert.equal(first.get('_1st'), '_1st')
		assert.match(first.get('1st') ?? '', /^_1st_[0-9a-f]{6}$/)
		for (const key of [long, `${long}!`]) {
			const name = first.get(key) ?? ''
			assert.ok(name.length <= 63, name)
			assert.ok(name.startsWith('a_very_long_tag_key_'), name)
		}
		assert.notEqual(first.get(long), first.get(`${long}!`))

		for (const order of [
			[...keys].reverse(),
			[
				'end_',
				'foo-bar',
				'end',
				'_1st',
				'foo_bar',
				long,
				'1st',
				'Foo Bar',
				`${long}!`,
			],
		]) {
			const otherId = await manager.createProject({ name: 'Other order' })
			const other = await manager.getProject(otherId)
			const names = await fieldColumnNames(c, other, otherId, order)
			assert.deepEqual(Object.fromEntries(names), Object.fromEntries(first))
		}
	})

	test('tag keys named like Object.prototype members read only the document tags', async (t) => {
		const { client, projectId, project } = await setup(t)
		const keys = ['constructor', 'toString', 'hasOwnProperty', '__proto__']
		const c = await client()
		const names = await fieldColumnNames(c, project, projectId, keys)
		const [observations] = (await c.request('layers.list', { projectId }))
			.layers
		const without = await project.observation.create(
			observationValue({ tags: { keys: 'yes' } }),
		)
		const withTags = await project.observation.create(
			observationValue({
				tags: { keys: 'yes', constructor: 'built', toString: 'text' },
			}),
		)
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [without.docId, withTags.docId],
		})
		const byId = new Map<string, Wire>(features.map((f: Wire) => [f.id, f]))
		for (const id of [without.docId, withTags.docId]) {
			const props = byId.get(id).properties
			assert.equal(Object.keys(props).length, observations.columns.length)
			for (const key of keys) {
				const name = names.get(key) as string
				assert.ok(Object.hasOwn(props, name), `${name} is present`)
			}
		}
		const lacking = byId.get(without.docId).properties
		for (const key of keys) {
			assert.equal(
				Object.getOwnPropertyDescriptor(lacking, names.get(key) as string)
					?.value,
				null,
				key,
			)
		}
		const having = byId.get(withTags.docId).properties
		const valueOf = (key: string) =>
			Object.getOwnPropertyDescriptor(having, names.get(key) as string)?.value
		assert.equal(valueOf('constructor'), 'built')
		assert.equal(valueOf('toString'), 'text')
		assert.equal(valueOf('hasOwnProperty'), null)
		assert.equal(
			byId.get(withTags.docId).categoryId,
			byId.get(without.docId).categoryId,
		)
	})

	test('pages of long tracks stay well under the frame limit, with every track once', async (t) => {
		const { client, projectId, project } = await setup(t)
		const points = 5000
		const created = []
		for (let i = 0; i < 20; i++) {
			const locations = Array.from({ length: points }, (_, j) => ({
				timestamp: new Date(Date.UTC(2026, 0, 1) + j * 1000).toISOString(),
				mocked: false,
				coords: {
					latitude: -3 - j / 100_000 - i / 1000,
					longitude: -55 - j / 100_000,
				},
			}))
			created.push(
				(
					await project.track.create(
						trackValue({ locations: locations as TrackValue['locations'] }),
					)
				).docId,
			)
		}
		const c = await client()
		const sizes: number[] = []
		const ids: string[] = []
		let cursor: string | null = null
		do {
			const page: Wire = await c.request('layers.getFeatures', {
				projectId,
				layerId: 'tracks',
				cursor,
			})
			sizes.push(Buffer.byteLength(JSON.stringify(page)))
			ids.push(...page.features.map((f: Wire) => f.id))
			assert.ok(page.features.every((f: Wire) => f.times.length === points))
			cursor = page.nextCursor
		} while (cursor)
		assert.ok(sizes.length > 1, 'split although under the default limit')
		assert.ok(
			sizes.every((n) => n < 8 * 1024 * 1024),
			`page sizes ${sizes.join(', ')}`,
		)
		assert.deepEqual(ids, [...created].sort())
	})

	test('a large ids request of unknown ids is paged by size too', async (t) => {
		const { client, projectId, project } = await setup(t)
		const real = await project.observation.create(observationValue())
		const unknown = Array.from({ length: 100_000 }, (_, i) =>
			i.toString(16).padStart(64, '0'),
		)
		const c = await client()
		const sizes: number[] = []
		const removed: string[] = []
		const features: string[] = []
		let cursor: string | null = null
		do {
			const page: Wire = await c.request('layers.getFeatures', {
				projectId,
				layerId: 'observations',
				ids: [real.docId, ...unknown],
				limit: 5000,
				cursor,
			})
			sizes.push(Buffer.byteLength(JSON.stringify(page)))
			removed.push(...page.removed)
			features.push(...page.features.map((f: Wire) => f.id))
			cursor = page.nextCursor
		} while (cursor)
		assert.ok(sizes.length > 1)
		assert.ok(
			sizes.every((n) => n < 8 * 1024 * 1024),
			`page sizes ${sizes.join(', ')}`,
		)
		assert.deepEqual(features, [real.docId])
		assert.deepEqual(removed, [...unknown].sort())
	})

	test('categories without an icon, with a broken icon reference, or with only a PNG icon', async (t) => {
		const { client, projectId, project } = await setup(t)
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
			'base64',
		)
		const icon = await project.$icons.create({
			name: 'png only',
			variants: [
				{ mimeType: 'image/png', size: 'medium', pixelDensity: 2, blob: png },
			],
		})
		const preset = (
			name: string,
			iconRef?: { docId: string; versionId: string },
		) =>
			project.preset.create({
				schemaName: 'preset',
				name,
				geometry: ['point'],
				tags: { [name]: 'yes' },
				addTags: {},
				removeTags: {},
				fieldRefs: [],
				terms: [],
				...(iconRef ? { iconRef } : {}),
			})
		await preset('No icon')
		await preset('Broken icon', {
			docId: 'a'.repeat(64),
			versionId: `${'b'.repeat(64)}/0`,
		})
		await preset('PNG icon', { docId: icon.docId, versionId: icon.versionId })
		const c = await client()
		const { categories } = await c.request('categories.list', { projectId })
		const byName = new Map<string, Wire>(
			categories.map((x: Wire) => [x.name, x]),
		)
		assert.equal(byName.get('No icon').icon, undefined)
		assert.equal(byName.get('Broken icon').icon, undefined)
		assert.deepEqual(byName.get('PNG icon').icon, {
			mimeType: 'image/png',
			data: png.toString('base64'),
		})
	})

	test(
		'with the media server stopped, categories.list replies without icons and a layer with attachments fails',
		{ timeout: 15_000 },
		async (t) => {
			const dev = await createDevManager({ startMediaServer: false })
			const projectId = await dev.manager.createProject({ name: 'No media' })
			const project = await dev.manager.getProject(projectId)
			await project.observation.create(
				observationValue({
					attachments: [missingAttachment('a'.repeat(52), 'photo')],
				}),
			)
			const discoveryDir = await tempDir(t)
			const server = createLocalApiServer({
				manager: dev.manager,
				discoveryDir,
				app: APP,
			})
			t.after(async () => {
				await server.close()
				await dev.close()
			})
			const { discoveryFilePath } = await server.listen()
			const c = await TestClient.fromDiscoveryFile(discoveryFilePath)
			t.after(() => c.close())
			const other = await TestClient.fromDiscoveryFile(discoveryFilePath)
			t.after(() => other.close())
			const [{ categories }, err] = await Promise.all([
				c.request('categories.list', { projectId }),
				rpcError(
					other.request('layers.getFeatures', {
						projectId,
						layerId: 'observations',
					}),
				),
			])
			assert.ok(categories.length > 0)
			assert.ok(categories.every((x: Wire) => x.icon === undefined))
			assert.equal(err.code, 'INTERNAL_ERROR')
		},
	)
})
