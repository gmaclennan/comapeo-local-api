import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { frame, RpcError, TestClient, type Wire } from './helpers/client.ts'
import { APP, setup } from './helpers/server.ts'

const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

function collectReplies(socket: Socket, count: number): Promise<Wire[]> {
	return new Promise((resolve) => {
		const replies: Wire[] = []
		let buffer = Buffer.alloc(0)
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk])
			while (
				buffer.length >= 4 &&
				buffer.length >= 4 + buffer.readUInt32LE(0)
			) {
				const n = buffer.readUInt32LE(0)
				replies.push(JSON.parse(buffer.subarray(4, 4 + n).toString()))
				buffer = buffer.subarray(4 + n)
			}
			if (replies.length >= count) resolve(replies)
		})
	})
}

describe('handshake', () => {
	test('hello with the secret from the discovery file succeeds', async (t) => {
		const { rawClient, secret } = await setup(t)
		const client = await rawClient()
		const result = await client.hello(secret)
		assert.deepEqual(result, {
			protocolVersion: 1,
			server: { name: '@comapeo/local-api', version: pkg.version },
			app: APP,
		})
	})

	test('picks the highest shared version and ignores unknown ones', async (t) => {
		const { rawClient, secret } = await setup(t)
		const client = await rawClient()
		const result = await client.hello(secret, [1, 7, 'x'])
		assert.equal(result.protocolVersion, 1)
	})

	test('wrong secret closes the connection without sending anything', async (t) => {
		const { rawClient } = await setup(t)
		const client = await rawClient()
		await assert.rejects(client.hello('not-the-secret'), /Connection closed/)
		assert.equal(client.bytesReceived, 0)
	})

	test('a non-hello first frame closes the connection silently', async (t) => {
		const { rawClient } = await setup(t)
		const client = await rawClient()
		await assert.rejects(client.request('projects.list'), /Connection closed/)
		assert.equal(client.bytesReceived, 0)
	})

	test('a malformed hello closes the connection silently', async (t) => {
		const { rawClient, secret } = await setup(t)
		for (const params of [
			{ secret },
			{ protocolVersions: [1] },
			{ secret: 42, protocolVersions: [1] },
		]) {
			const client = await rawClient()
			await assert.rejects(client.request('hello', params), /Connection closed/)
			assert.equal(client.bytesReceived, 0)
		}
		const notJson = await rawClient()
		notJson.writeRaw(
			Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{{{')]),
		)
		await notJson.closed
		assert.equal(notJson.bytesReceived, 0)
	})

	test('no shared version returns UNSUPPORTED_PROTOCOL_VERSION then closes', async (t) => {
		const { rawClient, secret } = await setup(t)
		const client = await rawClient()
		const err = await client.hello(secret, [2, 3]).catch((e: unknown) => e)
		assert.ok(err instanceof RpcError)
		assert.equal(err.code, 'UNSUPPORTED_PROTOCOL_VERSION')
		assert.deepEqual(err.data, { supported: [1] })
		await client.closed
	})

	test('wrong secret with no shared version still closes silently', async (t) => {
		const { rawClient } = await setup(t)
		const client = await rawClient()
		await assert.rejects(client.hello('wrong', [99]), /Connection closed/)
		assert.equal(client.bytesReceived, 0)
	})

	test('a pre-auth frame over 4 KiB closes the connection on its header', async (t) => {
		const { rawClient } = await setup(t)
		const client = await rawClient()
		const header = Buffer.alloc(4)
		header.writeUInt32LE(4097)
		client.writeRaw(header)
		await client.closed
		assert.equal(client.bytesReceived, 0)
	})

	test('a hello split across writes, followed by a request in the same write, works', async (t) => {
		const { rawClient, secret } = await setup(t)
		const client = await rawClient()
		const bytes = Buffer.concat([
			frame({
				id: 1,
				method: 'hello',
				params: { secret, protocolVersions: [1] },
			}),
			frame({ id: 2, method: 'projects.list' }),
		])
		const replies: unknown[] = []
		const done = new Promise<void>((resolve) => {
			let buffer = Buffer.alloc(0)
			client.socket.on('data', (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk])
				while (
					buffer.length >= 4 &&
					buffer.length >= 4 + buffer.readUInt32LE(0)
				) {
					const n = buffer.readUInt32LE(0)
					replies.push(JSON.parse(buffer.subarray(4, 4 + n).toString()))
					buffer = buffer.subarray(4 + n)
				}
				if (replies.length === 2) resolve()
			})
		})
		client.writeRaw(bytes.subarray(0, 7))
		await new Promise((r) => setTimeout(r, 50))
		client.writeRaw(bytes.subarray(7))
		await done
		assert.equal((replies[0] as { id: number }).id, 1)
		assert.equal((replies[1] as { id: number }).id, 2)
		assert.ok('projects' in (replies[1] as { result: object }).result)
	})

	test('a client that does not finish hello is disconnected after 5 seconds, and an idle authenticated one is not', async (t) => {
		const { socketPath, client: authed } = await setup(t)
		const idle = await authed()
		const client = await TestClient.connect(socketPath)
		const start = Date.now()
		client.writeRaw(Buffer.from([10, 0]))
		await client.closed
		const elapsed = Date.now() - start
		assert.ok(elapsed >= 4900 && elapsed < 7000, `closed after ${elapsed} ms`)
		assert.equal(client.bytesReceived, 0)
		await delay(500)
		assert.ok((await idle.request('projects.list')).projects)
	})

	test('after hello, a frame over 4 KiB is accepted', async (t) => {
		const { client } = await setup(t)
		const c = await client()
		const result = await c.request('projects.list', {
			padding: 'x'.repeat(10_000),
		})
		assert.ok(Array.isArray(result.projects))
	})

	test(
		'after hello, a frame over 16 MiB closes the connection',
		{ timeout: 5000 },
		async (t) => {
			const { client } = await setup(t)
			const c = await client()
			const header = Buffer.alloc(4)
			header.writeUInt32LE(16 * 1024 * 1024 + 1)
			c.writeRaw(header)
			await c.closed
		},
	)

	test('hello and a request over 4 KiB in the same write both get replies', async (t) => {
		const { rawClient, secret } = await setup(t)
		const client = await rawClient()
		const replies = collectReplies(client.socket, 2)
		client.writeRaw(
			Buffer.concat([
				frame({
					id: 1,
					method: 'hello',
					params: { secret, protocolVersions: [1] },
				}),
				frame({
					id: 2,
					method: 'projects.list',
					params: { padding: 'x'.repeat(10_000) },
				}),
			]),
		)
		const [hello, list] = await replies
		assert.equal(hello.result.protocolVersion, 1)
		assert.equal(list.id, 2)
		assert.ok(Array.isArray(list.result.projects))
	})

	test(
		'after hello, a frame that is not a request closes the connection',
		{ timeout: 10_000 },
		async (t) => {
			const { client } = await setup(t)
			for (const body of ['{{{', '{"method":"projects.list"}', '[1]']) {
				const c = await client()
				const before = c.bytesReceived
				const bytes = Buffer.from(body)
				const header = Buffer.alloc(4)
				header.writeUInt32LE(bytes.length)
				c.writeRaw(Buffer.concat([header, bytes]))
				await c.closed
				assert.equal(c.bytesReceived, before, body)
			}
		},
	)

	test('params: null is treated as no params', async (t) => {
		const { client } = await setup(t)
		const c = await client()
		const replies = collectReplies(c.socket, 1)
		c.writeRaw(frame({ id: 50, method: 'projects.list', params: null }))
		const [message] = await replies
		assert.equal(message.id, 50)
		assert.ok(Array.isArray(message.result.projects))
	})
})
