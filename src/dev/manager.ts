import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FastifyController, MapeoManager } from '@comapeo/core'
import Fastify from 'fastify'

const require = createRequire(import.meta.url)

export interface DevManager {
	manager: MapeoManager
	close(): Promise<void>
}

/**
 * A MapeoManager with an in-memory database, cores in a temporary directory
 * and its media server listening on 127.0.0.1, so blob and icon URLs work.
 */
export async function createDevManager({
	deviceName = 'CoMapeo dev server',
	startMediaServer = true,
}: {
	deviceName?: string
	/** false leaves the media server stopped, as when the host fails to start it */
	startMediaServer?: boolean
} = {}): Promise<DevManager> {
	const coreUrl = import.meta.resolve('@comapeo/core')
	const coreStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'comapeo-dev-'))
	const fastify = Fastify()
	const fastifyController = new FastifyController({ fastify })
	const manager = new MapeoManager({
		rootKey: randomBytes(16),
		dbFolder: ':memory:',
		coreStorage,
		projectMigrationsFolder: fileURLToPath(
			new URL('../drizzle/project', coreUrl),
		),
		clientMigrationsFolder: fileURLToPath(
			new URL('../drizzle/client', coreUrl),
		),
		fastify,
		// The package's main entry is the binary .comapeocat file
		defaultConfigPath: require.resolve('@mapeo/default-config'),
	})
	await manager.setDeviceInfo({ name: deviceName, deviceType: 'desktop' })
	if (startMediaServer) {
		await fastifyController.start({ host: '127.0.0.1', port: 0 })
	}
	let closing: Promise<void> | null = null
	return {
		manager,
		close() {
			closing ??= (async () => {
				if (startMediaServer) await fastifyController.stop()
				await manager.close()
				await fs.rm(coreStorage, { recursive: true, force: true })
			})()
			return closing
		},
	}
}
