import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createDevManager } from '../src/dev/manager.ts'
import { missingAttachment } from '../src/dev/seed.ts'
import {
	createLocalApiServer,
	DISCOVERY_FILE_NAME,
	ServerAlreadyStarted,
	ServerClosed,
	SocketPathTooLong,
} from '../src/index.ts'
import { TestClient } from './helpers/client.ts'
import { observationValue } from './helpers/fixtures.ts'
import { APP, setup, tempDir } from './helpers/server.ts'

const isWindows = process.platform === 'win32'

async function devManager(t: Parameters<typeof tempDir>[0]) {
	const dev = await createDevManager()
	t.after(() => dev.close())
	return dev.manager
}

describe('discovery file and socket', () => {
	test('discovery file holds the socket path, secret, versions, pid and app', async (t) => {
		const { discoveryFilePath, discoveryDir, socketPath } = await setup(t)
		assert.equal(
			discoveryFilePath,
			path.join(discoveryDir, DISCOVERY_FILE_NAME),
		)
		const content = JSON.parse(await fs.readFile(discoveryFilePath, 'utf8'))
		assert.deepEqual(Object.keys(content).sort(), [
			'app',
			'discoveryVersion',
			'pid',
			'protocolVersions',
			'secret',
			'socketPath',
		])
		assert.equal(content.discoveryVersion, 1)
		assert.equal(content.socketPath, socketPath)
		assert.match(content.secret, /^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url')
		assert.deepEqual(content.protocolVersions, [1])
		assert.equal(content.pid, process.pid)
		assert.deepEqual(content.app, APP)
		assert.deepEqual(
			await fs.readdir(discoveryDir),
			[DISCOVERY_FILE_NAME],
			'no temp files left',
		)
		assert.ok(Buffer.byteLength(socketPath) < 100)
	})

	test(
		'discovery file is readable only by the user and the socket sits in a private directory',
		{ skip: isWindows },
		async (t) => {
			const { discoveryFilePath, socketPath } = await setup(t)
			assert.equal((await fs.stat(discoveryFilePath)).mode & 0o777, 0o600)
			assert.equal(
				(await fs.stat(path.dirname(socketPath))).mode & 0o777,
				0o700,
			)
			assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600)
		},
	)

	test('each server gets a new secret and socket', async (t) => {
		const a = await setup(t)
		const b = await setup(t)
		assert.notEqual(a.secret, b.secret)
		assert.notEqual(a.socketPath, b.socketPath)
	})

	test(
		'a given socket path is used, and an over-long one is refused',
		{ skip: isWindows },
		async (t) => {
			const manager = await devManager(t)
			const dir = await tempDir(t)
			const socketPath = path.join(dir, 's.sock')
			const server = createLocalApiServer({
				manager,
				discoveryDir: dir,
				app: APP,
				socketPath,
			})
			t.after(() => server.close())
			const result = await server.listen()
			assert.equal(result.socketPath, socketPath)
			const client = await TestClient.fromDiscoveryFile(
				result.discoveryFilePath,
			)
			await client.close()

			const long = createLocalApiServer({
				manager,
				discoveryDir: dir,
				app: APP,
				socketPath: path.join(dir, 'x'.repeat(120)),
			})
			await assert.rejects(long.listen(), SocketPathTooLong)
		},
	)
})

describe('close()', () => {
	test('disconnects clients, removes the discovery file and socket, and stops listening', async (t) => {
		const {
			server,
			client,
			discoveryFilePath,
			socketPath,
			projectId,
			project,
		} = await setup(t)
		const c = await client()
		await c.request('subscribe', { projectId })
		await server.close()
		await c.closed
		await assert.rejects(fs.access(discoveryFilePath), { code: 'ENOENT' })
		if (!isWindows) {
			await assert.rejects(fs.access(path.dirname(socketPath)), {
				code: 'ENOENT',
			})
		}
		await assert.rejects(
			new Promise((resolve, reject) => {
				const s = net.connect(socketPath, () => resolve(s))
				s.on('error', reject)
			}),
		)
		assert.equal(project.observation.listenerCount('updated-docs'), 0)
		assert.equal(project.preset.listenerCount('updated-docs'), 0)
		await server.close()
	})

	test('listen() twice, or after close(), is refused', async (t) => {
		const { server } = await setup(t)
		await assert.rejects(server.listen(), ServerAlreadyStarted)
		await server.close()
		await assert.rejects(server.listen(), ServerClosed)
	})

	test('closing an older server leaves a newer discovery file in place', async (t) => {
		const manager = await devManager(t)
		const discoveryDir = await tempDir(t)
		const older = createLocalApiServer({ manager, discoveryDir, app: APP })
		const newer = createLocalApiServer({ manager, discoveryDir, app: APP })
		t.after(() => Promise.all([older.close(), newer.close()]))
		await older.listen()
		const { discoveryFilePath } = await newer.listen()
		await older.close()
		const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
		assert.ok((await client.request('projects.list')).projects)
		await client.close()
		await newer.close()
		await assert.rejects(fs.access(discoveryFilePath), { code: 'ENOENT' })
	})

	test('close() while listen() is in progress leaves nothing behind', async (t) => {
		const manager = await devManager(t)
		const discoveryDir = await tempDir(t)
		const server = createLocalApiServer({ manager, discoveryDir, app: APP })
		const listening = server.listen()
		await server.close()
		await assert.rejects(listening, ServerClosed)
		assert.deepEqual(await fs.readdir(discoveryDir), [])
	})

	test(
		'close() with requests in flight lets the host close promptly',
		{ timeout: 30_000 },
		async (t) => {
			const cases = [
				...[0, 5].map((waitMs) => ({ waitMs, startMediaServer: true })),
				// Without the media server, core waits 5 s for it before failing
				{ waitMs: 100, startMediaServer: false },
			]
			for (const { waitMs, startMediaServer } of cases) {
				const label = `after ${waitMs} ms, media server ${startMediaServer}`
				const dev = await createDevManager({ startMediaServer })
				t.after(() => dev.close())
				const projectId = await dev.manager.createProject({ name: 'p' })
				const project = await dev.manager.getProject(projectId)
				await project.observation.create(
					observationValue({
						attachments: [missingAttachment('a'.repeat(52), 'photo')],
					}),
				)
				const server = createLocalApiServer({
					manager: dev.manager,
					discoveryDir: await tempDir(t),
					app: APP,
				})
				const { discoveryFilePath } = await server.listen()
				const [one, two] = await Promise.all([
					TestClient.fromDiscoveryFile(discoveryFilePath),
					TestClient.fromDiscoveryFile(discoveryFilePath),
				])
				const outcome = (p: Promise<unknown>) =>
					p.then(
						() => 'replied',
						(e: unknown) => (e instanceof Error ? e.message : String(e)),
					)
				const pending = [
					outcome(one.request('categories.list', { projectId })),
					...(startMediaServer
						? []
						: [
								outcome(
									two.request('layers.getFeatures', {
										projectId,
										layerId: 'observations',
									}),
								),
							]),
				]
				await delay(waitMs)
				const start = Date.now()
				await server.close()
				await dev.close()
				const elapsed = Date.now() - start
				for (const result of await Promise.all(pending)) {
					assert.equal(result, 'Connection closed', label)
				}
				assert.ok(elapsed < 2000, `${label}: host closed in ${elapsed} ms`)
			}
		},
	)

	test('a server that has not listened closes cleanly', async (t) => {
		const manager = await devManager(t)
		const server = createLocalApiServer({
			manager,
			discoveryDir: await tempDir(t),
			app: APP,
		})
		await server.close()
	})
})

describe('restarts and failures', () => {
	test('a secret from an earlier server is refused by the next one', async (t) => {
		const manager = await devManager(t)
		const discoveryDir = await tempDir(t)
		const first = createLocalApiServer({ manager, discoveryDir, app: APP })
		const { discoveryFilePath } = await first.listen()
		const old = JSON.parse(await fs.readFile(discoveryFilePath, 'utf8'))
		await first.close()

		const second = createLocalApiServer({ manager, discoveryDir, app: APP })
		t.after(() => second.close())
		const { socketPath } = await second.listen()
		const stale = await TestClient.connect(socketPath)
		await assert.rejects(stale.hello(old.secret), /Connection closed/)
		assert.equal(stale.bytesReceived, 0)
		const fresh = await TestClient.fromDiscoveryFile(discoveryFilePath)
		assert.ok((await fresh.request('projects.list')).projects)
		await fresh.close()
	})

	test(
		'listen() on a socket path in use fails and leaves the other server working',
		{ skip: isWindows },
		async (t) => {
			const manager = await devManager(t)
			const dir = await tempDir(t)
			const socketPath = path.join(dir, 's.sock')
			const running = createLocalApiServer({
				manager,
				discoveryDir: path.join(dir, 'a'),
				app: APP,
				socketPath,
			})
			t.after(() => running.close())
			const { discoveryFilePath } = await running.listen()

			const clashing = createLocalApiServer({
				manager,
				discoveryDir: path.join(dir, 'b'),
				app: APP,
				socketPath,
			})
			await assert.rejects(clashing.listen(), { code: 'EADDRINUSE' })
			await assert.rejects(fs.access(path.join(dir, 'b')), { code: 'ENOENT' })
			const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
			assert.ok((await client.request('projects.list')).projects)
			await client.close()
		},
	)

	test(
		'listen() with an unusable discovery directory fails and removes its socket',
		{ skip: isWindows },
		async (t) => {
			const manager = await devManager(t)
			const dir = await tempDir(t)
			const notADir = path.join(dir, 'file')
			await fs.writeFile(notADir, '')
			const socketPath = path.join(dir, 's.sock')
			const server = createLocalApiServer({
				manager,
				discoveryDir: path.join(notADir, 'discovery'),
				app: APP,
				socketPath,
			})
			await assert.rejects(server.listen())
			await assert.rejects(fs.access(socketPath), { code: 'ENOENT' })
			assert.deepEqual((await fs.readdir(dir)).sort(), ['file'])
		},
	)
})
