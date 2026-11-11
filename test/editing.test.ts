import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { MapeoProject } from '@comapeo/core'
import type { FieldValue } from '@comapeo/core/schema.js'

import { RpcError, type TestClient, type Wire } from './helpers/client.ts'
import {
	observationValue,
	presetByName,
	trackValue,
} from './helpers/fixtures.ts'
import { setup } from './helpers/server.ts'

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
	const err = await promise.then(
		() => assert.fail('expected an error'),
		(e: unknown) => e,
	)
	assert.ok(err instanceof RpcError, String(err))
	return err
}

async function getFeature(c: TestClient, projectId: string, id: string) {
	const { features } = await c.request('layers.getFeatures', {
		projectId,
		layerId: 'observations',
		ids: [id],
	})
	return features[0]
}

/** Sends an update based on `feature` as the client last fetched it. */
function update(
	c: TestClient,
	projectId: string,
	feature: Wire,
	change: Record<string, unknown>,
) {
	return c.request('features.update', {
		projectId,
		layerId: 'observations',
		id: feature.id,
		version: feature.version,
		forks: feature.forks,
		...change,
	})
}

async function inCategory(
	project: MapeoProject,
	name: string,
	tags: Record<string, string | number> = {},
	{ lat = -3, lon = -58 }: { lat?: number; lon?: number } = {},
) {
	const preset = await presetByName(project, name)
	return project.observation.create(
		observationValue({
			lat,
			lon,
			tags: { ...preset.tags, ...tags },
			presetRef: { docId: preset.docId, versionId: preset.versionId },
			metadata: {
				manualLocation: false,
				position: {
					timestamp: '2026-01-01T10:00:00.000Z',
					mocked: false,
					coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: 80 },
				},
			},
		}),
	)
}

async function addCategory(
	project: MapeoProject,
	name: string,
	tags: Record<string, string>,
	fields: FieldValue[],
) {
	const created = []
	for (const field of fields) created.push(await project.field.create(field))
	return project.preset.create({
		schemaName: 'preset',
		name,
		geometry: ['point'],
		tags,
		addTags: {},
		removeTags: {},
		fieldRefs: created.map((f) => ({
			docId: f.docId,
			versionId: f.versionId,
		})),
		terms: [],
	})
}

const textField = (tagKey: string): FieldValue => ({
	schemaName: 'field',
	tagKey,
	type: 'text',
	label: tagKey,
})

describe('editing switched off', () => {
	test('layers say why, edits give EDITING_DISABLED after the params check', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		const { layers } = await c.request('layers.list', { projectId })
		const [observations, tracks] = layers
		assert.equal(observations.editable, false)
		assert.equal(observations.readOnlyReason, 'disabled')
		assert.deepEqual(observations.editOperations, [
			'properties',
			'category',
			'delete',
		])
		assert.equal(tracks.editable, false)
		assert.equal(tracks.readOnlyReason, 'unsupported')
		assert.deepEqual(tracks.editOperations, [])

		const obs = await inCategory(project, 'Tree')
		const feature = await getFeature(c, projectId, obs.docId)
		assert.equal(
			(await rpcError(update(c, projectId, feature, { properties: {} }))).code,
			'INVALID_PARAMS',
		)
		const disabled = await rpcError(
			update(c, projectId, feature, { properties: { notes: 'x' } }),
		)
		assert.equal(disabled.code, 'EDITING_DISABLED')
		assert.equal(disabled.data, undefined)
		assert.equal(
			(
				await rpcError(
					c.request('features.delete', {
						projectId,
						layerId: 'observations',
						id: obs.docId,
						version: obs.versionId,
					}),
				)
			).code,
			'EDITING_DISABLED',
		)
		assert.equal(
			(await project.observation.getByDocId(obs.docId)).versionId,
			obs.versionId,
		)
	})
})

describe('what can be edited', () => {
	test('layer, column and feature flags; schemaVersion does not depend on them', async (t) => {
		const off = await setup(t)
		const on = await setup(t, { allowEdits: true })
		const c = await on.client()
		const { layers } = await c.request('layers.list', {
			projectId: on.projectId,
		})
		const [observations, tracks] = layers
		assert.equal(observations.editable, true)
		assert.equal('readOnlyReason' in observations, false)
		assert.deepEqual(observations.editOperations, [
			'properties',
			'category',
			'delete',
		])
		assert.equal(tracks.editable, false)
		assert.equal(tracks.readOnlyReason, 'unsupported')

		const byName = new Map<string, Wire>(
			observations.columns.map((col: Wire) => [col.name, col]),
		)
		assert.deepEqual(byName.get('notes'), {
			name: 'notes',
			type: 'string',
			label: 'Notes',
			role: 'builtin',
			editable: true,
		})
		const building = await presetByName(on.project, 'Building')
		assert.equal(byName.get('building_type').editable, true)
		assert.deepEqual(byName.get('building_type').categoryIds, [building.docId])
		for (const name of ['id', 'category', 'created_at', 'accuracy', 'tags']) {
			assert.equal('editable' in byName.get(name), false, name)
		}
		for (const col of tracks.columns) {
			assert.equal('editable' in col, false, col.name)
		}

		const offLayers = (
			await (
				await off.client()
			).request('layers.list', {
				projectId: off.projectId,
			})
		).layers
		assert.equal(offLayers[0].schemaVersion, observations.schemaVersion)
		// Category ids differ between the two projects
		const flags = (columns: Wire[]) =>
			columns.map(({ categoryIds, ...rest }: Wire) => ({
				...rest,
				categories: categoryIds?.length,
			}))
		assert.deepEqual(
			flags(offLayers[0].columns),
			flags(observations.columns),
			'column flags describe the layer, not the host setting',
		)

		const obs = await inCategory(on.project, 'Tree')
		const feature = await getFeature(c, on.projectId, obs.docId)
		assert.equal(feature.editable, true)
		assert.deepEqual(feature.forks, [])
		const track = await on.project.track.create(trackValue())
		const { features } = await c.request('layers.getFeatures', {
			projectId: on.projectId,
			layerId: 'tracks',
			ids: [track.docId],
		})
		assert.equal(features[0].editable, false)
		assert.deepEqual(features[0].forks, [])

		const { categories } = await c.request('categories.list', {
			projectId: on.projectId,
		})
		const types = new Map(
			categories.map((cat: Wire) => [cat.name, cat.geometryTypes]),
		)
		assert.deepEqual(types.get('Tree'), ['Point'])
		assert.deepEqual(types.get('River'), ['Point', 'LineString'])
		assert.deepEqual(types.get('New line'), ['LineString'])
	})

	test('a client that ignores the new members sees the version 1 shapes plus a notes column', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const added = {
			layer: ['editable', 'editOperations', 'readOnlyReason'],
			column: ['editable', 'categoryIds'],
			feature: ['forks', 'editable'],
		}
		const known = {
			layer: [
				'layerId',
				'title',
				'docType',
				'geometryType',
				'schemaVersion',
				'columns',
			],
			column: ['name', 'type', 'label', 'role', 'options'],
			feature: [
				'id',
				'version',
				'geometry',
				'times',
				'properties',
				'categoryId',
				'attachments',
			],
		}
		const onlyKnownOrAdded = (kind: keyof typeof known, value: object) => {
			for (const key of Object.keys(value)) {
				assert.ok(
					known[kind].includes(key) || added[kind].includes(key),
					`${kind} member ${key}`,
				)
			}
		}
		await inCategory(project, 'Building', { 'building-type': 'School' })
		await project.track.create(trackValue())
		const { layers } = await c.request('layers.list', { projectId })
		for (const layer of layers) {
			onlyKnownOrAdded('layer', layer)
			for (const column of layer.columns) onlyKnownOrAdded('column', column)
			const { features } = await c.request('layers.getFeatures', {
				projectId,
				layerId: layer.layerId,
			})
			assert.ok(features.length > 0)
			for (const feature of features) {
				onlyKnownOrAdded('feature', feature)
				assert.deepEqual(
					Object.keys(feature.properties).sort(),
					layer.columns.map((col: Wire) => col.name).sort(),
				)
			}
		}
		assert.ok(
			layers[0].columns.some(
				(col: Wire) => col.name === 'notes' && col.role === 'builtin',
			),
		)
		assert.ok(!layers[1].columns.some((col: Wire) => col.name === 'notes'))
	})
})

describe('features.update', () => {
	test('notes: trimmed, a value equal to the stored one writes nothing, null removes', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await inCategory(project, 'Tree', { notes: 'first' })
		const before = await getFeature(c, projectId, obs.docId)
		assert.equal(before.properties.notes, 'first')

		const { feature, concurrent } = await update(c, projectId, before, {
			properties: { notes: '  second  ' },
		})
		assert.equal(concurrent, undefined)
		assert.notEqual(feature.version, before.version)
		assert.equal(feature.properties.notes, 'second')
		assert.deepEqual(feature, await getFeature(c, projectId, obs.docId))
		const stored = await project.observation.getByDocId(obs.docId)
		assert.equal(stored.tags.notes, 'second')
		assert.deepEqual(stored.links, [before.version], 'written on what was seen')
		assert.equal(stored.lat, obs.lat)
		assert.deepEqual(stored.metadata, obs.metadata)
		assert.deepEqual(stored.presetRef, obs.presetRef)
		assert.deepEqual(stored.attachments, obs.attachments)

		const same = await update(c, projectId, feature, {
			properties: { notes: 'second' },
		})
		assert.equal(same.feature.version, feature.version, 'nothing written')

		const removed = await update(c, projectId, feature, {
			properties: { notes: null },
		})
		assert.equal(removed.feature.properties.notes, null)
		const after = await project.observation.getByDocId(obs.docId)
		assert.equal(Object.hasOwn(after.tags, 'notes'), false)
	})

	test('a field of the feature’s category: options, types and not-in-category', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const building = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Building')).docId,
		)
		const set = await update(c, projectId, building, {
			properties: { building_type: 'Hospital' },
		})
		assert.equal(set.feature.properties.building_type, 'Hospital')
		const notAnOption = await rpcError(
			update(c, projectId, set.feature, {
				properties: { building_type: 'Castle' },
			}),
		)
		assert.equal(notAnOption.code, 'INVALID_VALUE')
		assert.deepEqual(notAnOption.data, {
			target: 'column',
			column: 'building_type',
			reason: 'not-an-option',
		})
		const wrongType = await rpcError(
			update(c, projectId, set.feature, { properties: { building_type: 5 } }),
		)
		assert.deepEqual(wrongType.data, {
			target: 'column',
			column: 'building_type',
			reason: 'type',
		})
		const cleared = await update(c, projectId, set.feature, {
			properties: { building_type: null },
		})
		assert.equal(cleared.feature.properties.building_type, null)
		assert.equal(
			Object.hasOwn(
				(await project.observation.getByDocId(building.id)).tags,
				'building-type',
			),
			false,
		)

		const tree = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const notInCategory = await rpcError(
			update(c, projectId, tree, {
				properties: { building_type: 'School' },
			}),
		)
		assert.equal(notInCategory.code, 'NOT_EDITABLE')
		assert.deepEqual(notInCategory.data, {
			target: 'column',
			column: 'building_type',
			reason: 'not-in-category',
		})

		const uncategorised = await getFeature(
			c,
			projectId,
			(
				await project.observation.create(
					observationValue({ lat: 1, lon: 2, tags: { x: 'y' } }),
				)
			).docId,
		)
		assert.equal(uncategorised.categoryId, null)
		assert.deepEqual(
			(
				await rpcError(
					update(c, projectId, uncategorised, {
						properties: { building_type: 'School' },
					}),
				)
			).data,
			{ target: 'column', column: 'building_type', reason: 'not-in-category' },
		)
		const noted = await update(c, projectId, uncategorised, {
			properties: { notes: 'fine' },
		})
		assert.equal(noted.feature.properties.notes, 'fine')
	})

	test('number, date, multi-choice and numeric-option fields', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		await addCategory(project, 'Survey', { survey: 'yes' }, [
			{ ...textField('count'), type: 'number' },
			{ ...textField('visited'), type: 'date' },
			{
				...textField('threats'),
				type: 'selectMultiple',
				options: [
					{ value: 'fire', label: 'Fire' },
					{ value: 'logging', label: 'Logging' },
				],
			},
			{
				...textField('quality'),
				type: 'selectOne',
				options: [
					{ value: 1, label: 'Poor' },
					{ value: 2, label: 'Good' },
				],
			},
			{
				...textField('levels'),
				type: 'selectMultiple',
				options: [
					{ value: 1, label: 'One' },
					{ value: true, label: 'Yes' },
				],
			},
		])
		const c = await client()
		const obs = await inCategory(project, 'Survey')
		let feature = await getFeature(c, projectId, obs.docId)
		;({ feature } = await update(c, projectId, feature, {
			properties: {
				count: 12.5,
				visited: '2026-03-01',
				threats: ['logging', 'fire'],
				quality: 2,
				levels: ['1', 'true'],
			},
		}))
		const tags = (await project.observation.getByDocId(obs.docId)).tags
		assert.equal(tags.count, 12.5)
		assert.equal(tags.visited, '2026-03-01')
		assert.deepEqual(tags.threats, ['logging', 'fire'])
		assert.equal(tags.quality, 2)
		assert.deepEqual(tags.levels, [1, true], 'option values, not as sent')
		assert.deepEqual(feature.properties.levels, ['1', 'true'])

		;({ feature } = await update(c, projectId, feature, {
			properties: { visited: '2026-03-01T09:30:00Z' },
		}))
		assert.equal(feature.properties.visited, '2026-03-01T09:30:00Z')

		const refusals: Array<[Record<string, unknown>, string]> = [
			[{ count: '12' }, 'type'],
			[{ visited: '01/03/2026' }, 'format'],
			[{ visited: 20260301 }, 'type'],
			[{ threats: ['flood'] }, 'not-an-option'],
			[{ threats: 'fire' }, 'type'],
			[{ quality: 3 }, 'not-an-option'],
			[{ quality: '2' }, 'type'],
		]
		for (const [properties, reason] of refusals) {
			const err = await rpcError(update(c, projectId, feature, { properties }))
			assert.equal(err.code, 'INVALID_VALUE', JSON.stringify(properties))
			assert.deepEqual(err.data, {
				target: 'column',
				column: Object.keys(properties)[0],
				reason,
			})
		}
	})

	test('columns that can never be edited, and fields sharing a tag key', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const first = await addCategory(project, 'First', { first: 'yes' }, [
			{
				...textField('kind'),
				type: 'selectOne',
				options: [{ value: 'a', label: 'A' }],
			},
			{
				...textField('clash'),
				type: 'selectOne',
				options: [
					{ value: 1, label: 'One' },
					{ value: '1', label: 'Also one' },
				],
			},
			{ ...textField('unknown'), type: 'UNRECOGNIZED' },
			{ ...textField('empty'), type: 'selectOne', options: [] },
		])
		await addCategory(project, 'Second', { second: 'yes' }, [
			{
				...textField('kind'),
				type: 'selectOne',
				options: [{ value: 'b', label: 'B' }],
			},
		])
		const c = await client()
		const [observations] = (await c.request('layers.list', { projectId }))
			.layers
		const byName = new Map<string, Wire>(
			observations.columns.map((col: Wire) => [col.name, col]),
		)
		assert.deepEqual(byName.get('kind').categoryIds, [first.docId])
		for (const name of ['clash', 'unknown', 'empty']) {
			assert.ok(byName.has(name), name)
			assert.equal('editable' in byName.get(name), false, name)
		}

		const second = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Second')).docId,
		)
		assert.deepEqual(
			(
				await rpcError(
					update(c, projectId, second, { properties: { kind: 'b' } }),
				)
			).data,
			{ target: 'column', column: 'kind', reason: 'not-in-category' },
		)
		for (const column of ['clash', 'created_at', 'tags', 'id', 'nope']) {
			const err = await rpcError(
				update(c, projectId, second, { properties: { [column]: 'x' } }),
			)
			assert.equal(err.code, 'NOT_EDITABLE')
			assert.deepEqual(err.data, { target: 'column', column })
		}
	})

	test('a field on the notes tag is the notes column, editable on every feature', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		await addCategory(project, 'Noted', { noted: 'yes' }, [
			{ ...textField('notes'), label: 'Field notes' },
		])
		const c = await client()
		const [observations] = (await c.request('layers.list', { projectId }))
			.layers
		const notes = observations.columns.filter((col: Wire) =>
			col.name.endsWith('notes'),
		)
		assert.deepEqual(notes, [
			{
				name: 'notes',
				type: 'string',
				label: 'Field notes',
				role: 'field',
				editable: true,
			},
		])
		const tree = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const { feature } = await update(c, projectId, tree, {
			properties: { notes: ' on a tree ' },
		})
		assert.equal(feature.properties.notes, 'on a tree')
	})

	test('every other tag is kept, including ones named like Object.prototype members', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await project.observation.create(
			observationValue({
				lat: 1,
				lon: 2,
				tags: JSON.parse(
					'{"__proto__": "p", "constructor": "c", "other": [1, "a"], "notes": "n"}',
				),
			}),
		)
		const before = Object.entries(obs.tags).filter(([k]) => k !== 'notes')
		assert.ok(before.some(([k]) => k === 'constructor'))
		const feature = await getFeature(c, projectId, obs.docId)
		await update(c, projectId, feature, { properties: { notes: 'changed' } })
		const { tags } = await project.observation.getByDocId(obs.docId)
		assert.deepEqual(
			Object.entries(tags).sort(),
			[...before, ['notes', 'changed']].sort(),
		)
		assert.equal(Object.getPrototypeOf(tags), Object.prototype)
	})

	test('a category or field added after the first edit can be used at once', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const tree = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const { feature } = await update(c, projectId, tree, {
			properties: { notes: 'cached the categories' },
		})
		const later = await addCategory(project, 'Later', { later: 'yes' }, [
			textField('later_field'),
		])
		const moved = await update(c, projectId, feature, {
			categoryId: later.docId,
			properties: { later_field: 'set' },
		})
		assert.equal(moved.feature.categoryId, later.docId)
		assert.equal(moved.feature.properties.later_field, 'set')
	})
})

describe('changing the category', () => {
	test('old category tags go, new ones come, answers stay, the reference follows', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const building = await presetByName(project, 'Building')
		const tree = await getFeature(
			c,
			projectId,
			(
				await inCategory(project, 'Tree', {
					'tree-species': 'Cedar',
					notes: 'n',
				})
			).docId,
		)
		const { feature } = await update(c, projectId, tree, {
			categoryId: building.docId,
			properties: { building_type: 'School' },
		})
		assert.equal(feature.categoryId, building.docId)
		assert.equal(feature.properties.category, 'Building')
		assert.equal(feature.properties.building_type, 'School')
		const stored = await project.observation.getByDocId(tree.id)
		assert.deepEqual(stored.tags, {
			type: 'building',
			'building-type': 'School',
			'tree-species': 'Cedar',
			notes: 'n',
		})
		assert.deepEqual(stored.presetRef, {
			docId: building.docId,
			versionId: building.versionId,
		})

		const same = await update(c, projectId, feature, {
			categoryId: building.docId,
		})
		assert.equal(same.feature.version, feature.version, 'nothing written')
	})

	test('refusals: unknown, wrong geometry, would not show, null, and a value that would change it', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const options = [
			{ value: 'well', label: 'Well' },
			{ value: 'river', label: 'River' },
		]
		const source: FieldValue = {
			...textField('water_source'),
			type: 'selectOne',
			options,
		}
		await addCategory(project, 'Well', { water_source: 'well' }, [source])
		await addCategory(project, 'River source', { water_source: 'river' }, [
			source,
		])
		const c = await client()
		const tree = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const category = (name: string) =>
			presetByName(project, name).then((p) => p.docId)
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ categoryId: 'nope' }, 'unknown-category'],
			[{ categoryId: await category('New line') }, 'category-not-for-layer'],
			// The default config's "New line" has the same tags and comes first
			[{ categoryId: await category('New point') }, 'category-would-not-show'],
		]
		for (const [change, reason] of cases) {
			const err = await rpcError(update(c, projectId, tree, change))
			assert.equal(err.code, 'INVALID_VALUE', reason)
			assert.deepEqual(err.data, { target: 'category', reason })
		}
		assert.equal(
			(await rpcError(update(c, projectId, tree, { categoryId: null }))).code,
			'INVALID_PARAMS',
		)

		const well = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Well')).docId,
		)
		const err = await rpcError(
			update(c, projectId, well, {
				properties: { water_source: 'river', notes: 'x' },
			}),
		)
		assert.deepEqual(err.data, {
			target: 'column',
			column: 'water_source',
			reason: 'would-change-category',
		})
		assert.equal(
			(await project.observation.getByDocId(well.id)).versionId,
			well.version,
			'nothing written',
		)
		const moved = await update(c, projectId, well, {
			categoryId: await category('River source'),
		})
		assert.equal(moved.feature.properties.water_source, 'river')
	})
})

describe('order of checks', () => {
	test('each check in turn, with the data the contract gives', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await inCategory(project, 'Tree')
		const feature = await getFeature(c, projectId, obs.docId)
		const base = {
			projectId,
			layerId: 'observations',
			id: obs.docId,
			version: obs.versionId,
		}
		const invalid: Array<Record<string, unknown>> = [
			{ ...base, id: undefined, properties: { notes: 'x' } },
			{ ...base, version: '', properties: { notes: 'x' } },
			{ ...base, forks: 'x', properties: { notes: 'x' } },
			{ ...base, forks: [1], properties: { notes: 'x' } },
			{ ...base, properties: ['x'] },
			{ ...base, properties: {} },
			{ ...base },
			{ ...base, geometry: null },
			{ ...base, geometry: { type: 'LineString', coordinates: [1, 2] } },
			{ ...base, geometry: { type: 'Point', coordinates: [1] } },
			{ ...base, projectId: 'nope', layerId: 'nope', properties: {} },
		]
		for (const params of invalid) {
			const err = await rpcError(c.request('features.update', params))
			assert.equal(err.code, 'INVALID_PARAMS', JSON.stringify(params))
			assert.equal(err.data, undefined)
		}
		const code = async (params: Record<string, unknown>) => {
			const err = await rpcError(c.request('features.update', params))
			return [err.code, err.data]
		}
		const notes = { properties: { notes: 'x' } }
		assert.deepEqual(await code({ ...base, ...notes, projectId: 'nope' }), [
			'PROJECT_NOT_FOUND',
			undefined,
		])
		assert.deepEqual(await code({ ...base, ...notes, layerId: 'nope' }), [
			'LAYER_NOT_FOUND',
			undefined,
		])
		assert.deepEqual(await code({ ...base, ...notes, layerId: 'tracks' }), [
			'NOT_EDITABLE',
			{ target: 'layer' },
		])
		const point = { type: 'Point', coordinates: [obs.lon, obs.lat] }
		assert.deepEqual(
			await code({ ...base, geometry: point, version: 'stale', id: 'nope' }),
			['NOT_EDITABLE', { target: 'geometry' }],
			'a geometry is refused, even where the point already is',
		)
		assert.deepEqual(
			await code({ ...base, id: 'nope', properties: { created_at: 'x' } }),
			['NOT_EDITABLE', { target: 'column', column: 'created_at' }],
		)
		assert.deepEqual(await code({ ...base, ...notes, id: 'nope' }), [
			'FEATURE_NOT_FOUND',
			{ deleted: false },
		])
		const stale = await code({
			...base,
			version: 'stale',
			properties: { building_type: 'Castle' },
		})
		assert.equal(stale[0], 'CONFLICT')
		assert.deepEqual(stale[1], { feature })
		assert.deepEqual(
			await code({
				...base,
				forks: ['made-up'],
				properties: { notes: 'x' },
			}),
			['CONFLICT', { feature }],
			'forks the server does not hold are a conflict too',
		)
		assert.equal(
			(await project.observation.getByDocId(obs.docId)).versionId,
			obs.versionId,
		)

		const track = await project.track.create(trackValue())
		const del = (params: Record<string, unknown>) =>
			rpcError(c.request('features.delete', params))
		assert.deepEqual(
			(
				await del({
					projectId,
					layerId: 'tracks',
					id: track.docId,
					version: track.versionId,
				})
			).data,
			{ target: 'layer' },
		)
		assert.equal(
			(await del({ projectId, layerId: 'observations', id: obs.docId })).code,
			'INVALID_PARAMS',
		)
	})
})

describe('conflicts', () => {
	test('a stale save is refused with the current feature and writes nothing', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await inCategory(project, 'Tree', { notes: 'a' })
		const fetched = await getFeature(c, projectId, obs.docId)
		const elsewhere = await project.observation.update(obs.versionId, {
			...observationValue({ lat: -3, lon: -58 }),
			tags: { ...obs.tags, notes: 'changed in CoMapeo' },
		})
		const err = await rpcError(
			update(c, projectId, fetched, { properties: { notes: 'from QGIS' } }),
		)
		assert.equal(err.code, 'CONFLICT')
		const { feature } = err.data as Wire
		assert.equal(feature.version, elsewhere.versionId)
		assert.equal(feature.properties.notes, 'changed in CoMapeo')
		const now = await project.observation.getByDocId(obs.docId)
		assert.equal(now.versionId, elsewhere.versionId)
		assert.deepEqual(now.forks, [])

		const ok = await update(c, projectId, feature, {
			properties: { notes: 'from QGIS' },
		})
		assert.equal(ok.feature.properties.notes, 'from QGIS')
	})

	test('a resend after a lost reply is a CONFLICT that holds the values sent, and no fork', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const feature = await getFeature(
			c,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const change = { properties: { notes: 'once' } }
		await update(c, projectId, feature, change)
		const err = await rpcError(update(c, projectId, feature, change))
		assert.equal(err.code, 'CONFLICT')
		assert.equal((err.data as Wire).feature.properties.notes, 'once')
		const now = await project.observation.getByDocId(feature.id)
		assert.deepEqual(now.forks, [])
	})

	test('two connections saving the same version: one is accepted, the other refused', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const [a, b] = await Promise.all([client(), client()])
		const feature = await getFeature(
			a,
			projectId,
			(await inCategory(project, 'Tree')).docId,
		)
		const results = await Promise.allSettled([
			update(a, projectId, feature, { properties: { notes: 'a' } }),
			update(b, projectId, feature, { properties: { notes: 'b' } }),
		])
		const accepted = results.filter((r) => r.status === 'fulfilled')
		const refused = results.filter((r) => r.status === 'rejected')
		assert.equal(accepted.length, 1)
		assert.equal(refused.length, 1)
		assert.equal((refused[0] as PromiseRejectedResult).reason.code, 'CONFLICT')
		const now = await project.observation.getByDocId(feature.id)
		assert.deepEqual(now.forks, [])
	})

	test('an edit of a feature already forked on this device is written on the shown version', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await inCategory(project, 'Tree')
		const value = (notes: string) => ({
			...observationValue({ lat: -3, lon: -58 }),
			tags: { ...obs.tags, notes },
		})
		const first = await project.observation.update(obs.versionId, value('1'))
		await project.observation.update(obs.versionId, value('2'))
		const forked = await getFeature(c, projectId, obs.docId)
		assert.equal(forked.forks.length, 1)
		assert.equal(forked.forks[0], first.versionId)

		const err = await rpcError(
			update(
				c,
				projectId,
				{ ...forked, forks: [] },
				{
					properties: { notes: 'x' },
				},
			),
		)
		assert.equal(err.code, 'CONFLICT')
		const { feature } = await update(c, projectId, forked, {
			properties: { notes: 'from QGIS' },
		})
		assert.equal(feature.properties.notes, 'from QGIS')
		const stored = await project.observation.getByDocId(obs.docId)
		assert.deepEqual(stored.links, [forked.version], 'the shown version only')
		assert.deepEqual(feature.forks, [...stored.forks].sort())
	})
})

describe('the gap between check and write', () => {
	test('a change landing in the gap is reported as concurrent, with the version shown', async (t) => {
		let intrude: (() => Promise<unknown>) | undefined
		const { client, projectId, project } = await setup(t, {
			allowEdits: true,
			internal: { beforeWrite: async () => void (await intrude?.()) },
		})
		const c = await client()
		const obs = await inCategory(project, 'Tree')
		const feature = await getFeature(c, projectId, obs.docId)
		let landed: { versionId: string } | undefined
		intrude = async () => {
			landed = await project.observation.update(obs.versionId, {
				...observationValue({ lat: -3, lon: -58 }),
				tags: { ...obs.tags, notes: 'landed in the gap' },
			})
		}
		const result = await update(c, projectId, feature, {
			properties: { notes: 'from QGIS' },
		})
		assert.equal(result.concurrent, true)
		const stored = await project.observation.getByDocId(obs.docId)
		assert.equal(result.feature.version, stored.versionId)
		assert.deepEqual(result.feature.forks, [...stored.forks].sort())
		assert.equal(stored.forks.length, 1)
		const versions = new Set([stored.versionId, ...stored.forks])
		assert.ok(landed && versions.has(landed.versionId))

		intrude = undefined
		const quiet = await update(c, projectId, result.feature, {
			properties: { notes: 'later' },
		})
		assert.equal(quiet.concurrent, undefined)
	})

	test('a delete: a change in the gap is covered and reported; a delete in the gap is FEATURE_NOT_FOUND', async (t) => {
		let intrude: (() => Promise<unknown>) | undefined
		const { client, projectId, project } = await setup(t, {
			allowEdits: true,
			internal: { beforeWrite: async () => void (await intrude?.()) },
		})
		const c = await client()
		const del = (f: Wire) =>
			c.request('features.delete', {
				projectId,
				layerId: 'observations',
				id: f.id,
				version: f.version,
				forks: f.forks,
			})
		const changed = await inCategory(project, 'Tree')
		intrude = () =>
			project.observation.update(changed.versionId, {
				...observationValue({ lat: 1, lon: 2 }),
				tags: { notes: 'landed' },
			})
		const result = await del(await getFeature(c, projectId, changed.docId))
		assert.deepEqual(result, { id: changed.docId, concurrent: true })
		const after = await project.observation.getByDocId(changed.docId)
		assert.equal(after.deleted, true)
		assert.deepEqual(after.forks, [])

		const deleted = await inCategory(project, 'Tree')
		intrude = () => project.observation.delete(deleted.docId)
		const err = await rpcError(
			del(await getFeature(c, projectId, deleted.docId)),
		)
		assert.equal(err.code, 'FEATURE_NOT_FOUND')
		assert.deepEqual(err.data, { deleted: true })
	})

	test('an update in the gap after a delete there: the observation is shown again, the deletion in its forks', async (t) => {
		const gap: { intrude?: () => Promise<unknown> } = {}
		const { client, projectId, project } = await setup(t, {
			allowEdits: true,
			internal: { beforeWrite: async () => void (await gap.intrude?.()) },
		})
		const c = await client()
		const obs = await inCategory(project, 'Tree')
		const feature = await getFeature(c, projectId, obs.docId)
		let deleted: { versionId: string } | undefined
		gap.intrude = async () => {
			deleted = await project.observation.delete(obs.docId)
		}
		const result = await update(c, projectId, feature, {
			properties: { notes: 'from QGIS' },
		})
		assert.equal(result.concurrent, true)
		assert.equal(result.feature.properties.notes, 'from QGIS')
		assert.ok(deleted && result.feature.forks.includes(deleted.versionId))
		assert.deepEqual(await getFeature(c, projectId, obs.docId), result.feature)
	})

	// The other write is started, not awaited, so it overlaps core's own write
	for (const [ours, theirs] of [
		['delete', 'update'],
		['update', 'update'],
		['update', 'delete'],
	] as const) {
		const name = { update: 'an update', delete: 'a delete' }
		test(`${name[theirs]} overlapping core's own ${ours} is reported as concurrent`, async (t) => {
			let intrude: (() => Promise<unknown>) | undefined
			const { client, projectId, project } = await setup(t, {
				allowEdits: true,
				internal: { beforeWrite: async () => void (await intrude?.()) },
			})
			const c = await client()
			let overlaps = 0
			for (const startsFirst of [true, false]) {
				for (let ticks = 0; ticks < 10; ticks++) {
					const obs = await inCategory(project, 'Tree')
					const feature = await getFeature(c, projectId, obs.docId)
					const write = () =>
						theirs === 'delete'
							? project.observation.delete(obs.docId)
							: project.observation.update(obs.versionId, {
									...observationValue({ lat: -3, lon: -58 }),
									tags: { ...obs.tags, notes: 'from CoMapeo' },
								})
					const pause = async () => {
						for (let i = 0; i < ticks; i++) await Promise.resolve()
					}
					let other: Promise<unknown> = Promise.resolve()
					intrude = async () => {
						if (startsFirst) {
							other = write()
							await pause()
						} else {
							other = pause().then(write)
						}
					}
					const reply =
						ours === 'delete'
							? await c.request('features.delete', {
									projectId,
									layerId: 'observations',
									id: feature.id,
									version: feature.version,
									forks: feature.forks,
								})
							: await update(c, projectId, feature, {
									properties: { notes: 'from QGIS' },
								})
					await other
					const stored = await project.observation.getByDocId(obs.docId)
					if (stored.forks.length === 0) continue
					overlaps++
					const when = `${startsFirst ? 'before' : 'after'}, ${ticks} ticks`
					assert.equal(reply.concurrent, true, when)
					if (ours === 'update' && !stored.deleted) {
						assert.deepEqual(
							reply.feature,
							await getFeature(c, projectId, obs.docId),
							when,
						)
					}
				}
			}
			assert.ok(overlaps > 0, 'the writes overlapped')
		})
	}
})

describe('features.delete', () => {
	test('deletes, notifies the writer too, and a deleted feature is not found', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		await c.request('subscribe', { projectId })
		const obs = await inCategory(project, 'Tree')
		const feature = await getFeature(c, projectId, obs.docId)
		const params = {
			projectId,
			layerId: 'observations',
			id: obs.docId,
			version: feature.version,
		}
		const stale = await rpcError(
			c.request('features.delete', { ...params, version: 'stale' }),
		)
		assert.equal(stale.code, 'CONFLICT')
		assert.deepEqual((stale.data as Wire).feature, feature)

		assert.deepEqual(await c.request('features.delete', params), {
			id: obs.docId,
		})
		await c.waitForNotification(
			(n) =>
				n.method === 'layer.changed' &&
				(n.params.ids as string[]).includes(obs.docId),
		)
		const { removed } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		assert.deepEqual(removed, [obs.docId])
		const again = await rpcError(c.request('features.delete', params))
		assert.equal(again.code, 'FEATURE_NOT_FOUND')
		assert.deepEqual(again.data, { deleted: true })
		const edit = await rpcError(
			update(c, projectId, feature, { properties: { notes: 'x' } }),
		)
		assert.deepEqual(edit.data, { deleted: true })
	})
})

describe('speed', () => {
	test('a few hundred edits, replies included, stay well inside a client’s wait', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const ids = []
		for (let i = 0; i < 200; i++) {
			ids.push((await inCategory(project, 'Building')).docId)
		}
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids,
		})
		const started = performance.now()
		await Promise.all(
			features.map((f: Wire, i: number) =>
				update(c, projectId, f, {
					properties: {
						notes: `edit ${i}`,
						building_type: i % 2 ? 'School' : 'Shop',
					},
				}),
			),
		)
		const ms = performance.now() - started
		t.diagnostic(`200 edits in ${Math.round(ms)} ms`)
		assert.ok(ms < 15_000, `${ms} ms`)
	})
})

describe('safeguards', () => {
	test('a value CoMapeo would not accept is refused by its own check, and nothing is written', async (t) => {
		const { client, projectId, project } = await setup(t, { allowEdits: true })
		const c = await client()
		const obs = await inCategory(project, 'Tree')
		// Core's update() does not validate, so it can store what create() refuses
		const invalid = await project.observation.update(obs.versionId, {
			...observationValue({ lat: 100, lon: -58 }),
			tags: obs.tags,
		})
		const feature = await getFeature(c, projectId, obs.docId)
		const err = await rpcError(
			update(c, projectId, feature, { properties: { notes: 'x' } }),
		)
		assert.equal(err.code, 'INVALID_VALUE')
		const data = err.data as Wire
		assert.equal(data.target, 'column')
		assert.equal(data.reason, 'schema')
		assert.match(data.detail, /lat/)
		assert.equal(
			(await project.observation.getByDocId(obs.docId)).versionId,
			invalid.versionId,
		)
	})

	test('editing keeps one updated-docs listener per data type, and close removes it', async (t) => {
		const { client, projectId, project, server } = await setup(t, {
			allowEdits: true,
		})
		const dataTypes = [
			project.observation,
			project.track,
			project.preset,
			project.field,
			project.$translation.dataType,
		]
		const counts = () => dataTypes.map((d) => d.listenerCount('updated-docs'))
		const before = counts()
		const plusOne = before.map((n) => n + 1)
		const [a, b] = await Promise.all([client(), client()])
		const obs = await inCategory(project, 'Tree')
		let feature = await getFeature(a, projectId, obs.docId)
		;({ feature } = await update(a, projectId, feature, {
			properties: { notes: 'no subscriber' },
		}))
		assert.deepEqual(counts(), plusOne)
		await a.request('subscribe', { projectId })
		await b.request('subscribe', { projectId })
		;({ feature } = await update(b, projectId, feature, {
			properties: { notes: 'two subscribers' },
		}))
		assert.deepEqual(counts(), plusOne)
		await a.request('unsubscribe', { projectId })
		await b.close()
		await update(a, projectId, feature, { properties: { notes: 'none again' } })
		assert.deepEqual(counts(), plusOne)
		await server.close()
		assert.deepEqual(counts(), before)
	})
})
