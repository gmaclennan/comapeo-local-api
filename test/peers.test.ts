import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { RpcError, type Notification } from './helpers/client.ts'
import { observationValue, trackValue } from './helpers/fixtures.ts'
import { setupPeers } from './helpers/peers.ts'

const isWindows = process.platform === 'win32'

const changed = (layerId: string, id: string) => (n: Notification) =>
	n.method === 'layer.changed' &&
	n.params.layerId === layerId &&
	(n.params.ids as string[]).includes(id)

function recordUnhandledRejections(t: TestContext) {
	const reasons: unknown[] = []
	const onRejection = (reason: unknown) => reasons.push(reason)
	process.on('unhandledRejection', onRejection)
	t.after(() => process.off('unhandledRejection', onRejection))
	return reasons
}

describe('two devices', () => {
	test('changes made on another device arrive as notifications', async (t) => {
		const { client, projectId, remoteProject } = await setupPeers(t)
		const c = await client()
		await c.request('subscribe', { projectId })

		const obs = await remoteProject.observation.create(
			observationValue({ lat: 5, lon: 6 }),
		)
		await c.waitForNotification(changed('observations', obs.docId), 10_000)
		const { features } = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		assert.deepEqual(features[0].geometry.coordinates, [6, 5])
		assert.equal(features[0].properties.created_by, 'Remote device')

		const track = await remoteProject.track.create(trackValue())
		await c.waitForNotification(changed('tracks', track.docId), 10_000)

		c.notifications.length = 0
		await remoteProject.observation.delete(obs.docId)
		await c.waitForNotification(changed('observations', obs.docId), 10_000)
		const gone = await c.request('layers.getFeatures', {
			projectId,
			layerId: 'observations',
			ids: [obs.docId],
		})
		assert.deepEqual(gone.removed, [obs.docId])

		await remoteProject.field.create({
			schemaName: 'field',
			tagKey: 'remote_field',
			type: 'text',
			label: 'Remote field',
		})
		await c.waitForNotification(
			(n) => n.method === 'layer.schemaChanged',
			10_000,
		)
	})

	test('leaving a project while clients are subscribed does not crash the host', async (t) => {
		const rejections = recordUnhandledRejections(t)
		const {
			client,
			projectId,
			local,
			localProject,
			server,
			socketPath,
			discoveryFilePath,
		} = await setupPeers(t)
		const dataTypes = [
			localProject.observation,
			localProject.track,
			localProject.preset,
			localProject.field,
			localProject.$translation.dataType,
		]
		const listenerCounts = () => ({
			updatedDocs: dataTypes.map((d) => d.listenerCount('updated-docs')),
			ownRoleChange: localProject.listenerCount('own-role-change'),
			close: localProject.listenerCount('close'),
		})
		const before = listenerCounts()
		const [disconnects, unsubscribes, stays] = await Promise.all([
			client(),
			client(),
			client(),
		])
		for (const c of [disconnects, unsubscribes, stays]) {
			await c.request('subscribe', { projectId })
		}

		assert.notDeepEqual(listenerCounts(), before)
		await local.leaveProject(projectId)
		await delay(100)
		assert.deepEqual(listenerCounts(), before, 'subscriptions ended')

		const err = await stays
			.request('layers.list', { projectId })
			.catch((e: unknown) => e)
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'PROJECT_NOT_FOUND')
		const { projects } = await stays.request('projects.list')
		assert.ok(
			!projects.some((p: { projectId: string }) => p.projectId === projectId),
		)

		await disconnects.close()
		await delay(100)
		assert.deepEqual(
			await unsubscribes.request('unsubscribe', { projectId }),
			{},
		)
		await delay(100)
		await server.close()
		await stays.closed
		await delay(100)

		assert.deepEqual(rejections, [])
		await assert.rejects(fs.access(discoveryFilePath), { code: 'ENOENT' })
		if (!isWindows) {
			await assert.rejects(fs.access(path.dirname(socketPath)), {
				code: 'ENOENT',
			})
		}
	})
})
