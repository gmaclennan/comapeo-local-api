import * as fs from 'node:fs/promises'
import type { TestContext } from 'node:test'

import { createDevManager } from '../../src/dev/manager.ts'
import { connectPeers, joinAsMember } from '../../src/dev/peers.ts'
import { createServer, type InternalServerOptions } from '../../src/server.ts'
import { TestClient } from './client.ts'
import { APP, tempDir } from './server.ts'

/**
 * Two devices on a local connection. `remote` creates a project and invites
 * `local` as a member; `local` serves the API.
 */
export async function setupPeers(
	t: TestContext,
	{
		allowEdits,
		internal,
	}: { allowEdits?: boolean; internal?: InternalServerOptions } = {},
) {
	const remoteDev = await createDevManager({ deviceName: 'Remote device' })
	const localDev = await createDevManager({ deviceName: 'Local device' })
	const remote = remoteDev.manager
	const local = localDev.manager

	const disconnect = await connectPeers(remote, local)
	const projectId = await remote.createProject({ name: 'Shared project' })
	const remoteProject = await remote.getProject(projectId)
	const localProject = await joinAsMember(remoteProject, local, projectId)

	const discoveryDir = await tempDir(t)
	const server = createServer(
		{
			manager: local,
			discoveryDir,
			app: APP,
			...(allowEdits && { allowEdits }),
		},
		internal,
	)
	const { socketPath, discoveryFilePath } = await server.listen()
	const discovery = JSON.parse(await fs.readFile(discoveryFilePath, 'utf8'))
	const clients: TestClient[] = []
	t.after(async () => {
		await Promise.all(clients.map((c) => c.close()))
		await server.close()
		await disconnect()
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
