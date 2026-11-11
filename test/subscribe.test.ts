import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { frame, RpcError } from './helpers/client.ts'
import { observationValue, trackValue } from './helpers/fixtures.ts'
import { setup } from './helpers/server.ts'

const changed =
	(layerId: string, id: string) =>
	(n: { method: string; params: Record<string, unknown> }) =>
		n.method === 'layer.changed' &&
		n.params.layerId === layerId &&
		(n.params.ids as string[]).includes(id)

describe('subscribe', () => {
	test('create, update and delete each send layer.changed with the doc id', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		assert.deepEqual(await c.request('subscribe', { projectId }), {})

		const start = Date.now()
		const obs = await project.observation.create(
			observationValue({ lat: 1, lon: 1 }),
		)
		const created = await c.waitForNotification(
			changed('observations', obs.docId),
		)
		assert.ok(Date.now() - start < 1500, 'delivered within the batching window')
		assert.deepEqual(created.params, {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})

		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: created.params.ids,
		})
		assert.equal(features[0].version, obs.versionId)

		c.notifications.length = 0
		const updated = await project.observation.update(obs.versionId, {
			...observationValue({ lat: 2, lon: 2 }),
		})
		await c.waitForNotification(changed('observations', obs.docId))
		const after = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		assert.equal(after.features[0].version, updated.versionId)
		assert.deepEqual(after.features[0].geometry.coordinates, [2, 2])

		c.notifications.length = 0
		await project.observation.delete(obs.docId)
		await c.waitForNotification(changed('observations', obs.docId))
		const gone = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		assert.deepEqual(gone.features, [])
		assert.deepEqual(gone.removed, [obs.docId])
	})

	test('changes close together are batched into one notification per layer', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		await c.request('subscribe', { projectId })
		const [observations, track] = await Promise.all([
			Promise.all(
				Array.from({ length: 5 }, () =>
					project.observation.create(observationValue()),
				),
			),
			project.track.create(trackValue()),
		])
		await c.waitForNotification(changed('tracks', track.docId))
		await delay(400)
		const ofLayer = (layerId: string) =>
			c.notifications.filter(
				(n) => n.method === 'layer.changed' && n.params.layerId === layerId,
			)
		assert.equal(ofLayer('observations').length, 1)
		assert.deepEqual(
			ofLayer('observations')[0]?.params.ids,
			observations.map((o) => o.docId).sort(),
		)
		assert.equal(ofLayer('tracks').length, 1)
	})

	test('subscribe then unsubscribe in one write leaves the client unsubscribed', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		c.socket.cork()
		const replies = Promise.all([
			c.request('subscribe', { projectId }),
			c.request('unsubscribe', { projectId }),
		])
		c.socket.uncork()
		await replies
		const obs = await project.observation.create(observationValue())
		await delay(600)
		assert.ok(!c.notifications.some(changed('observations', obs.docId)))
		assert.equal(project.observation.listenerCount('updated-docs'), 0)
	})

	test('a category or field change sends layer.schemaChanged for each layer', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		await c.request('subscribe', { projectId })
		const before = await c.request('layers.list', { projectId })
		const field = await project.field.create({
			schemaName: 'field',
			tagKey: 'condition',
			type: 'text',
			label: 'Condition',
		})
		await project.preset.create({
			schemaName: 'preset',
			name: 'Bridge',
			geometry: ['point'],
			tags: { bridge: 'yes' },
			addTags: {},
			removeTags: {},
			fieldRefs: [{ docId: field.docId, versionId: field.versionId }],
			terms: [],
		})
		for (const layerId of ['observations', 'tracks']) {
			await c.waitForNotification(
				(n) =>
					n.method === 'layer.schemaChanged' && n.params.layerId === layerId,
			)
		}
		const schema = c.notifications.find(
			(n) => n.method === 'layer.schemaChanged',
		)
		assert.deepEqual(Object.keys(schema?.params ?? {}).sort(), [
			'layerId',
			'projectId',
		])
		const afterList = await c.request('layers.list', { projectId })
		assert.notEqual(
			afterList.layers[0].schemaVersion,
			before.layers[0].schemaVersion,
		)
		assert.ok(
			afterList.layers[0].columns.some(
				(col: { name: string }) => col.name === 'condition',
			),
		)
		const { categories } = await c.request('categories.list', { projectId })
		assert.ok(categories.some((x: { name: string }) => x.name === 'Bridge'))
	})

	test('a translation sends layer.schemaChanged, and labels change for that lang', async (t) => {
		const { client, projectId, project } = await setup(t)
		const field = await project.field.create({
			schemaName: 'field',
			tagKey: 'condition',
			type: 'text',
			label: 'Condition',
		})
		await project.preset.create({
			schemaName: 'preset',
			name: 'Bridge',
			geometry: ['point'],
			tags: { bridge: 'yes' },
			addTags: {},
			removeTags: {},
			fieldRefs: [{ docId: field.docId, versionId: field.versionId }],
			terms: [],
		})
		const c = await client()
		await c.request('subscribe', { projectId })
		await delay(400)
		c.notifications.length = 0
		await project.$translation.put({
			schemaName: 'translation',
			docRef: { docId: field.docId, versionId: field.versionId },
			docRefType: 'field',
			propertyRef: 'label',
			languageCode: 'por',
			message: 'Condição',
		})
		await c.waitForNotification(
			(n) =>
				n.method === 'layer.schemaChanged' &&
				n.params.layerId === 'observations',
		)
		const [observations] = (
			await c.request('layers.list', { projectId, lang: 'pt' })
		).layers
		const column = observations.columns.find(
			(col: { name: string }) => col.name === 'condition',
		)
		assert.equal(column.label, 'Condição')
	})

	test('only subscribed clients are notified, and unsubscribe stops notifications', async (t) => {
		const { client, projectId, project } = await setup(t)
		const [one, two, idle] = await Promise.all([client(), client(), client()])
		await one.request('subscribe', { projectId })
		await two.request('subscribe', { projectId })

		const first = await project.observation.create(observationValue())
		await one.waitForNotification(changed('observations', first.docId))
		await two.waitForNotification(changed('observations', first.docId))

		assert.deepEqual(await two.request('unsubscribe', { projectId }), {})
		const second = await project.observation.create(observationValue())
		await one.waitForNotification(changed('observations', second.docId))
		await delay(400)
		assert.ok(!two.notifications.some(changed('observations', second.docId)))
		assert.equal(idle.notifications.length, 0)
	})

	test('subscribing twice, or from a client that then disconnects, still notifies others once', async (t) => {
		const { client, projectId, project } = await setup(t)
		const [stays, leaves] = await Promise.all([client(), client()])
		await stays.request('subscribe', { projectId })
		await stays.request('subscribe', { projectId })
		await leaves.request('subscribe', { projectId })
		await leaves.close()

		const obs = await project.observation.create(observationValue())
		await stays.waitForNotification(changed('observations', obs.docId))
		await delay(400)
		const matching = stays.notifications.filter(
			changed('observations', obs.docId),
		)
		assert.equal(matching.length, 1)
	})

	test('a client that disconnects right after subscribing leaves no listeners behind', async (t) => {
		const { client, projectId, project } = await setup(t)
		const c = await client()
		c.socket.end(frame({ id: 99, method: 'subscribe', params: { projectId } }))
		await c.closed
		await delay(300)
		assert.equal(project.observation.listenerCount('updated-docs'), 0)
	})

	test('subscribing to an unknown project fails', async (t) => {
		const { client } = await setup(t)
		const c = await client()
		const err = await c
			.request('subscribe', { projectId: 'unknown' })
			.catch((e: unknown) => e)
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PROJECT_NOT_FOUND')
	})

	test('subscriptions are per project', async (t) => {
		const { client, manager, projectId } = await setup(t)
		const otherId = await manager.createProject({ name: 'Other' })
		const other = await manager.getProject(otherId)
		const c = await client()
		await c.request('subscribe', { projectId })
		const obs = await other.observation.create(observationValue())
		await delay(600)
		assert.ok(!c.notifications.some(changed('observations', obs.docId)))
	})
})
