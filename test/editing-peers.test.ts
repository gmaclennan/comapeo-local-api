import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { roles, type MapeoProject } from '@comapeo/core'

import { RpcError, type TestClient, type Wire } from './helpers/client.ts'
import { observationValue } from './helpers/fixtures.ts'
import { setupPeers } from './helpers/peers.ts'

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
	const err = await promise.then(
		() => assert.fail('expected an error'),
		(e: unknown) => e,
	)
	assert.ok(err instanceof RpcError, String(err))
	return err
}

async function until<T>(
	check: () => Promise<T | undefined | false>,
	label: string,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const result = await check()
		if (result) return result
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
		await delay(20)
	}
}

/** Waits until `project` has indexed `versionId` as the version shown or a fork. */
function untilHolds(project: MapeoProject, docId: string, versionId: string) {
	return until(async () => {
		const doc = await project.observation.getByDocId(docId, {
			mustBeFound: false,
		})
		return (
			(doc?.versionId === versionId || doc?.forks.includes(versionId)) && doc
		)
	}, `version ${versionId} indexed`)
}

async function getFeature(c: TestClient, projectId: string, id: string) {
	const { features } = await c.request('layers.getFeatures', {
		projectId,
		layerId: 'observations',
		ids: [id],
	})
	return features[0]
}

function update(
	c: TestClient,
	projectId: string,
	feature: Wire,
	properties: Record<string, unknown>,
) {
	return c.request('features.update', {
		projectId,
		layerId: 'observations',
		id: feature.id,
		version: feature.version,
		forks: feature.forks,
		properties,
	})
}

function remove(c: TestClient, projectId: string, feature: Wire) {
	return c.request('features.delete', {
		projectId,
		layerId: 'observations',
		id: feature.id,
		version: feature.version,
		forks: feature.forks,
	})
}

// Not exported by core; the same id in 7.5.2 and 7.7.0
const BLOCKED_ROLE_ID = '9e6d29263cba36c9'

const value = (notes: string) =>
	observationValue({ lat: 1, lon: 2, tags: { notes } })

describe('roles', () => {
	test('a member edits only its own observations; made coordinator, it edits all', async (t) => {
		const { client, projectId, local, localProject, remoteProject } =
			await setupPeers(t, { allowEdits: true })
		const c = await client()
		await c.request('subscribe', { projectId })
		const own = await localProject.observation.create(value('own'))
		const theirs = await remoteProject.observation.create(value('theirs'))
		await untilHolds(localProject, theirs.docId, theirs.versionId)

		const [observations] = (await c.request('layers.list', { projectId }))
			.layers
		assert.equal(observations.editable, true)
		const ownFeature = await getFeature(c, projectId, own.docId)
		const theirFeature = await getFeature(c, projectId, theirs.docId)
		assert.equal(ownFeature.editable, true)
		assert.equal(theirFeature.editable, false)

		const refused = await rpcError(
			update(c, projectId, theirFeature, { notes: 'x' }),
		)
		assert.equal(refused.code, 'NOT_PERMITTED')
		assert.deepEqual(refused.data, { reason: 'not-own' })
		const stale = await rpcError(
			update(c, projectId, { ...theirFeature, version: 'stale' }, {}),
		)
		assert.equal(stale.code, 'INVALID_PARAMS')
		const staleAndNotOwn = await rpcError(
			update(
				c,
				projectId,
				{ ...theirFeature, version: 'stale' },
				{
					notes: 'x',
				},
			),
		)
		assert.equal(
			staleAndNotOwn.code,
			'NOT_PERMITTED',
			'the role is checked before the version',
		)
		assert.equal(
			(await rpcError(remove(c, projectId, theirFeature))).code,
			'NOT_PERMITTED',
		)
		const accepted = await update(c, projectId, ownFeature, { notes: 'mine' })
		assert.equal(accepted.feature.properties.notes, 'mine')

		c.notifications.length = 0
		await remoteProject.$member.assignRole(
			local.deviceId,
			roles.COORDINATOR_ROLE_ID,
		)
		await c.waitForNotification(
			(n) =>
				n.method === 'layer.schemaChanged' &&
				n.params.layerId === 'observations',
			15_000,
		)
		assert.equal((await getFeature(c, projectId, theirs.docId)).editable, true)
		const edited = await update(
			c,
			projectId,
			await getFeature(c, projectId, theirs.docId),
			{ notes: 'edited by the coordinator' },
		)
		assert.equal(edited.feature.properties.notes, 'edited by the coordinator')
		await untilHolds(remoteProject, theirs.docId, edited.feature.version)
	})

	test('a blocked device can edit nothing', async (t) => {
		const { client, projectId, local, localProject, remoteProject } =
			await setupPeers(t, { allowEdits: true })
		const c = await client()
		const own = await localProject.observation.create(value('own'))
		const feature = await getFeature(c, projectId, own.docId)
		await remoteProject.$member.assignRole(local.deviceId, BLOCKED_ROLE_ID)
		await until(
			async () => (await localProject.$getOwnRole()).roleId === BLOCKED_ROLE_ID,
			'blocked',
		)
		const { layers } = await c.request('layers.list', { projectId })
		const [observations] = layers
		assert.equal(observations.editable, false)
		assert.equal(observations.readOnlyReason, 'role')
		const err = await rpcError(update(c, projectId, feature, { notes: 'x' }))
		assert.equal(err.code, 'NOT_PERMITTED')
		assert.deepEqual(err.data, { reason: 'role' })
	})
})

describe('conflicts between devices', () => {
	test('a stale save after a remote edit is refused and writes no fork', async (t) => {
		const { client, projectId, localProject, remoteProject } = await setupPeers(
			t,
			{ allowEdits: true },
		)
		const c = await client()
		const own = await localProject.observation.create(value('first'))
		await untilHolds(remoteProject, own.docId, own.versionId)
		const fetched = await getFeature(c, projectId, own.docId)

		const remote = await remoteProject.observation.update(
			own.versionId,
			value('changed on the other device'),
		)
		await untilHolds(localProject, own.docId, remote.versionId)
		const err = await rpcError(update(c, projectId, fetched, { notes: 'qgis' }))
		assert.equal(err.code, 'CONFLICT')
		const { feature } = err.data as Wire
		assert.equal(feature.version, remote.versionId)
		assert.equal(feature.properties.notes, 'changed on the other device')

		const saved = await update(c, projectId, feature, { notes: 'qgis' })
		const onRemote = await untilHolds(
			remoteProject,
			own.docId,
			saved.feature.version,
		)
		assert.equal(onRemote.versionId, saved.feature.version)
		assert.deepEqual(onRemote.forks, [])
		assert.deepEqual(
			(await localProject.observation.getByDocId(own.docId)).forks,
			[],
		)
	})

	for (const kind of ['update', 'delete'] as const) {
		test(`a late losing fork refuses a ${kind} until the client has seen it`, async (t) => {
			const { client, projectId, localProject, remoteProject } =
				await setupPeers(t, { allowEdits: true })
			const c = await client()
			const v1 = await localProject.observation.create(value('v1'))
			await untilHolds(remoteProject, v1.docId, v1.versionId)

			localProject.$sync.stop()
			remoteProject.$sync.stop()
			const theirs = await remoteProject.observation.update(
				v1.versionId,
				value('remote, earlier'),
			)
			// The later version is shown; leave a margin over coarse timer resolution
			await delay(100)
			const ours = await localProject.observation.update(
				v1.versionId,
				value('local, later'),
			)
			const fetched = await getFeature(c, projectId, v1.docId)
			assert.equal(fetched.version, ours.versionId)
			assert.deepEqual(fetched.forks, [])

			localProject.$sync.start()
			remoteProject.$sync.start()
			const forked = await untilHolds(localProject, v1.docId, theirs.versionId)
			assert.equal(forked.versionId, ours.versionId, 'shown version unchanged')
			assert.deepEqual(forked.forks, [theirs.versionId])

			const send = (f: Wire) =>
				kind === 'update'
					? update(c, projectId, f, { notes: 'from QGIS' })
					: remove(c, projectId, f)
			const err = await rpcError(send(fetched))
			assert.equal(err.code, 'CONFLICT')
			const current = (err.data as Wire).feature
			assert.equal(current.version, ours.versionId)
			assert.deepEqual(current.forks, [theirs.versionId])
			const untouched = await localProject.observation.getByDocId(v1.docId)
			assert.equal(untouched.versionId, ours.versionId)
			assert.deepEqual(untouched.forks, [theirs.versionId])

			const result = await send(current)
			assert.equal(result.concurrent, undefined)
			const written = await localProject.observation.getByDocId(v1.docId)
			if (kind === 'update') {
				assert.equal(result.feature.version, written.versionId)
				assert.deepEqual(written.links, [ours.versionId], 'shown version only')
			} else {
				assert.equal(written.deleted, true)
				assert.deepEqual(
					[...(written.links ?? [])].sort(),
					[ours.versionId, theirs.versionId].sort(),
				)
			}
			const onRemote = await untilHolds(
				remoteProject,
				v1.docId,
				written.versionId,
			)
			assert.equal(onRemote.versionId, written.versionId)
			assert.equal(onRemote.deleted, kind === 'delete')
		})
	}

	test('a remote edit landing between check and write is reported as concurrent', async (t) => {
		const gap: { intrude?: () => Promise<unknown> } = {}
		const { client, projectId, localProject, remoteProject } = await setupPeers(
			t,
			{
				allowEdits: true,
				internal: { beforeWrite: async () => void (await gap.intrude?.()) },
			},
		)
		const c = await client()
		const own = await localProject.observation.create(value('first'))
		await untilHolds(remoteProject, own.docId, own.versionId)
		const fetched = await getFeature(c, projectId, own.docId)
		let theirs: { versionId: string } | undefined
		gap.intrude = async () => {
			theirs = await remoteProject.observation.update(
				own.versionId,
				value('remote, in the gap'),
			)
			await untilHolds(localProject, own.docId, theirs.versionId)
		}
		const result = await update(c, projectId, fetched, { notes: 'from QGIS' })
		assert.equal(result.concurrent, true)
		const shown = await localProject.observation.getByDocId(own.docId)
		assert.equal(result.feature.version, shown.versionId)
		const versions = [shown.versionId, ...shown.forks]
		assert.equal(versions.length, 2)
		assert.ok(theirs && versions.includes(theirs.versionId))
	})
})
