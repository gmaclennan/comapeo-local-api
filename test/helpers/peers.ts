import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import type { TestContext } from 'node:test'

import { roles, type MapeoManager } from '@comapeo/core'

import { createDevManager } from '../../src/dev/manager.ts'
import { createLocalApiServer } from '../../src/index.ts'
import { TestClient } from './client.ts'
import { APP, tempDir } from './server.ts'

async function waitForPeer(manager: MapeoManager, deviceId: string) {
	const connected = async () =>
		(await manager.listLocalPeers()).some(
			(p) => p.deviceId === deviceId && p.status === 'connected',
		)
	while (!(await connected())) await once(manager, 'local-peers')
}

/**
 * Two devices on a local connection. `remote` creates a project and invites
 * `local` as a member; `local` serves the API.
 */
export async function setupPeers(t: TestContext) {
	const remoteDev = await createDevManager({ deviceName: 'Remote device' })
	const localDev = await createDevManager({ deviceName: 'Local device' })
	const remote = remoteDev.manager
	const local = localDev.manager

	const servers = await Promise.all(
		[remote, local].map((m) => m.startLocalPeerDiscoveryServer()),
	)
	const [remoteServer, localServer] = servers as [
		{ name: string; port: number },
		{ name: string; port: number },
	]
	local.connectLocalPeer({ address: '127.0.0.1', ...remoteServer })
	remote.connectLocalPeer({ address: '127.0.0.1', ...localServer })
	await Promise.all([
		waitForPeer(remote, local.deviceId),
		waitForPeer(local, remote.deviceId),
	])

	const projectId = await remote.createProject({ name: 'Shared project' })
	const remoteProject = await remote.getProject(projectId)
	await Promise.all([
		remoteProject.$member.invite(local.deviceId, {
			roleId: roles.MEMBER_ROLE_ID,
		}),
		(async () => {
			const [invite] = await once(local.invite, 'invite-received')
			await local.invite.accept(invite)
		})(),
	])
	const localProject = await local.getProject(projectId)
	remoteProject.$sync.start()
	localProject.$sync.start()

	const discoveryDir = await tempDir(t)
	const server = createLocalApiServer({
		manager: local,
		discoveryDir,
		app: APP,
	})
	const { socketPath, discoveryFilePath } = await server.listen()
	const discovery = JSON.parse(await fs.readFile(discoveryFilePath, 'utf8'))
	const clients: TestClient[] = []
	t.after(async () => {
		await Promise.all(clients.map((c) => c.close()))
		await server.close()
		await Promise.all(
			[remote, local].map((m) =>
				m.stopLocalPeerDiscoveryServer({ force: true }),
			),
		)
		await Promise.all([remoteDev.close(), localDev.close()])
	})
	return {
		projectId,
		remote,
		local,
		remoteProject,
		localProject,
		server,
		socketPath,
		discoveryFilePath,
		secret: discovery.secret as string,
		async client() {
			const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
			clients.push(client)
			return client
		},
	}
}
