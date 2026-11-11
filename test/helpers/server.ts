import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TestContext } from 'node:test'

import { createDevManager } from '../../src/dev/manager.ts'
import { createLocalApiServer } from '../../src/index.ts'
import { TestClient } from './client.ts'

export const APP = { name: 'Test App', version: '9.9.9' }

export async function tempDir(t: TestContext): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cla-'))
	t.after(() => fs.rm(dir, { recursive: true, force: true }))
	return dir
}

export async function setup(t: TestContext) {
	const dev = await createDevManager({ deviceName: 'Test device' })
	const { manager } = dev
	const projectId = await manager.createProject({ name: 'Test project' })
	const project = await manager.getProject(projectId)
	const discoveryDir = await tempDir(t)
	const server = createLocalApiServer({ manager, discoveryDir, app: APP })
	const { socketPath, discoveryFilePath } = await server.listen()
	t.after(async () => {
		await server.close()
		await dev.close()
	})
	const discovery = JSON.parse(await fs.readFile(discoveryFilePath, 'utf8'))
	const clients: TestClient[] = []
	t.after(() => Promise.all(clients.map((c) => c.close())))
	return {
		manager,
		projectId,
		project,
		server,
		socketPath,
		discoveryDir,
		discoveryFilePath,
		secret: discovery.secret as string,
		/** A connected client that has not sent hello */
		async rawClient() {
			const client = await TestClient.connect(socketPath)
			clients.push(client)
			return client
		},
		/** A connected and authenticated client */
		async client() {
			const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
			clients.push(client)
			return client
		},
	}
}
