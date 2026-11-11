import assert from 'node:assert/strict'
import type { Socket } from 'node:net'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { TrackValue } from '@comapeo/core/schema.js'

import { frame, type TestClient, type Wire } from './helpers/client.ts'
import { trackValue } from './helpers/fixtures.ts'
import { setup } from './helpers/server.ts'

/** Waits until the socket's unsent bytes stop changing, and returns them. */
async function settledWritableLength(socket: Socket): Promise<number> {
	let last = -1
	let stableSince = Date.now()
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		const length = socket.writableLength
		if (length === 0) return 0
		if (length !== last) {
			last = length
			stableSince = Date.now()
		} else if (Date.now() - stableSince >= 750) {
			return length
		}
		await delay(50)
	}
	return socket.writableLength
}

function replyIds(client: TestClient): number[] {
	const ids: number[] = []
	let buffer = Buffer.concat(client.received)
	while (buffer.length >= 4) {
		const length = buffer.readUInt32LE(0)
		const message = JSON.parse(buffer.subarray(4, 4 + length).toString())
		if (typeof message.id === 'number') ids.push(message.id)
		buffer = buffer.subarray(4 + length)
	}
	return ids
}

/**
 * Sends `frames` from a client that does not read, then checks the server
 * stopped reading them, kept serving another client, and answers everything
 * in order once the first client reads again.
 */
async function assertHeldBack(
	reader: TestClient,
	other: TestClient,
	frames: Buffer[],
	firstId: number,
) {
	reader.socket.pause()
	reader.writeRaw(Buffer.concat(frames))

	const unsent = await settledWritableLength(reader.socket)
	assert.ok(unsent > 0, 'the server stopped reading requests')

	const start = Date.now()
	assert.ok((await other.request('projects.list')).projects)
	const elapsed = Date.now() - start
	assert.ok(elapsed < 1000, `another client was answered in ${elapsed} ms`)

	reader.socket.resume()
	const expected = frames.map((_, i) => firstId + i)
	const deadline = Date.now() + 30_000
	while (replyIds(reader).length < expected.length + 1) {
		assert.ok(Date.now() < deadline, 'every reply arrives')
		await delay(50)
	}
	assert.deepEqual(replyIds(reader).slice(1), expected, 'in request order')
}

describe('a client that does not read its replies', () => {
	test(
		'stops the server reading its requests once a large reply is unsent',
		{ timeout: 60_000 },
		async (t) => {
			const { client, projectId, project } = await setup(t)
			for (let i = 0; i < 2; i++) {
				const locations = Array.from({ length: 4000 }, (_, j) => ({
					timestamp: new Date(Date.UTC(2026, 0, 1) + j * 1000).toISOString(),
					mocked: false,
					coords: {
						latitude: -3 - j / 1e5 - i / 1e3,
						longitude: -55 - j / 1e5,
					},
				}))
				await project.track.create(
					trackValue({ locations: locations as TrackValue['locations'] }),
				)
			}
			const [reader, other] = await Promise.all([client(), client()])
			const padding = 'x'.repeat(1024 * 1024)
			const frames = [
				frame({
					id: 100,
					method: 'layers.getFeatures',
					params: { projectId, layerId: 'tracks' },
				}),
				...Array.from({ length: 30 }, (_, i) =>
					frame({ id: 101 + i, method: 'projects.list', params: { padding } }),
				),
			]
			await assertHeldBack(reader, other, frames, 100)
			const replies: Wire[] = []
			let buffer = Buffer.concat(reader.received)
			while (buffer.length >= 4) {
				const length = buffer.readUInt32LE(0)
				replies.push(JSON.parse(buffer.subarray(4, 4 + length).toString()))
				buffer = buffer.subarray(4 + length)
			}
			const tracks = replies.find((r) => r.id === 100)
			assert.equal(tracks.result.features.length, 2)
		},
	)

	test(
		'holds back error replies too, such as for params that are not an object',
		{ timeout: 60_000 },
		async (t) => {
			const { client } = await setup(t)
			const [reader, other] = await Promise.all([client(), client()])
			const padding = 'x'.repeat(1000)
			const frames = Array.from({ length: 30_000 }, (_, i) =>
				frame({ id: 100 + i, method: 'projects.list', params: [padding] }),
			)
			await assertHeldBack(reader, other, frames, 100)
			const last = Buffer.concat(reader.received).subarray(-200).toString()
			assert.match(last, /INVALID_PARAMS/)
		},
	)
})
