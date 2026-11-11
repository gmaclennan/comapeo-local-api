import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TestClient } from './helpers/client.ts'
import { tempDir } from './helpers/server.ts'

const CLI = fileURLToPath(new URL('../src/dev/cli.ts', import.meta.url))

test('dev command serves generated projects and changes data on stdin', async (t) => {
	const discoveryDir = await tempDir(t)
	const child = spawn(
		process.execPath,
		[
			CLI,
			'--discovery-dir',
			discoveryDir,
			'--observations',
			'60',
			'--photos',
			'4',
			'--tracks',
			'2',
		],
		{ stdio: ['pipe', 'pipe', 'inherit'] },
	)
	t.after(() => {
		if (child.exitCode === null) child.kill('SIGKILL')
	})
	const lines = readline.createInterface({ input: child.stdout })
	const iterator = lines[Symbol.asyncIterator]()
	const nextLine = async (prefix: string) => {
		for (;;) {
			const { value, done } = await iterator.next()
			if (done) throw new Error(`stdout ended before ${prefix}`)
			if (value.startsWith(prefix)) return value.slice(prefix.length)
		}
	}

	const discoveryFilePath = await nextLine('READY ')
	const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
	const { projects } = await client.request('projects.list')
	assert.equal(projects.length, 2)
	const [main] = projects
	assert.ok(main.name)

	const { categories } = await client.request('categories.list', {
		projectId: main.projectId,
	})
	assert.ok(categories.length > 10)
	assert.ok(categories.every((c: { icon?: unknown }) => c.icon))

	const observations = await client.request('layers.getFeatures', {
		projectId: main.projectId,
		layerId: 'observations',
	})
	type F = {
		geometry: unknown
		categoryId: string | null
		attachments: Array<{ type: string; urls: Record<string, string> }>
	}
	const features: F[] = observations.features
	assert.ok(features.length >= 60)
	assert.ok(
		features.some((f) => f.geometry === null),
		'some have no location',
	)
	assert.ok(features.filter((f) => f.categoryId).length > features.length / 2)
	assert.ok(
		new Set(features.map((f) => f.categoryId)).size > 5,
		'varied categories',
	)

	const attachments = features.flatMap((f) => f.attachments)
	const statuses = await Promise.all(
		attachments.map(async (a) => {
			const res = await fetch(a.urls.original as string, {
				signal: AbortSignal.timeout(5000),
			})
			await res.body?.cancel()
			return `${a.type}:${res.status}`
		}),
	)
	assert.ok(statuses.includes('photo:200'))
	assert.ok(statuses.includes('audio:200'))
	assert.ok(
		statuses.some((s) => s.endsWith(':404')),
		'one attachment is not synced',
	)

	const tracks = await client.request('layers.getFeatures', {
		projectId: main.projectId,
		layerId: 'tracks',
	})
	assert.equal(tracks.features.length, 2)
	assert.equal(tracks.features[0].geometry.type, 'LineString')

	await client.request('subscribe', { projectId: main.projectId })
	child.stdin.write('create\n')
	const created = JSON.parse(await nextLine('OK '))
	assert.equal(created.projectId, main.projectId)
	await client.waitForNotification(
		(n) =>
			n.method === 'layer.changed' &&
			(n.params.ids as string[]).includes(created.docId),
	)
	child.stdin.write(`delete 1 ${created.docId}\n`)
	assert.equal(JSON.parse(await nextLine('OK ')).docId, created.docId)
	child.stdin.write('category\n')
	await nextLine('OK ')
	await client.waitForNotification((n) => n.method === 'layer.schemaChanged')
	child.stdin.write('nonsense\n')
	assert.match(await nextLine('ERROR '), /Unknown command/)

	child.stdin.write('quit\n')
	const [code] = await once(child, 'exit')
	assert.equal(code, 0)
	await client.closed
	await assert.rejects(fs.access(discoveryFilePath), { code: 'ENOENT' })
})

test(
	'dev command cleans up on SIGTERM',
	{ skip: process.platform === 'win32' },
	async (t) => {
		const discoveryDir = await tempDir(t)
		const child = spawn(
			process.execPath,
			[
				CLI,
				'--discovery-dir',
				discoveryDir,
				'--observations',
				'3',
				'--photos',
				'1',
				'--tracks',
				'1',
				'--projects',
				'1',
			],
			{ stdio: ['ignore', 'pipe', 'ignore'] },
		)
		t.after(() => {
			if (child.exitCode === null) child.kill('SIGKILL')
		})
		const lines = readline.createInterface({ input: child.stdout })
		let discoveryFilePath = ''
		for await (const line of lines) {
			if (line.startsWith('READY ')) {
				discoveryFilePath = line.slice('READY '.length)
				break
			}
		}
		await fs.access(discoveryFilePath)
		child.kill('SIGTERM')
		const [code] = await once(child, 'exit')
		assert.equal(code, 0)
		await assert.rejects(fs.access(discoveryFilePath), { code: 'ENOENT' })
	},
)

test('dev command with no observations or tracks serves an empty project', async (t) => {
	const discoveryDir = await tempDir(t)
	const child = spawn(
		process.execPath,
		[
			CLI,
			'--discovery-dir',
			discoveryDir,
			'--observations',
			'0',
			'--tracks',
			'0',
			'--photos',
			'0',
			'--projects',
			'1',
		],
		{ stdio: ['pipe', 'pipe', 'ignore'] },
	)
	t.after(() => {
		if (child.exitCode === null) child.kill('SIGKILL')
	})
	const lines = readline.createInterface({ input: child.stdout })
	let discoveryFilePath = ''
	for await (const line of lines) {
		if (line.startsWith('READY ')) {
			discoveryFilePath = line.slice('READY '.length)
			break
		}
	}
	const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
	const [project] = (await client.request('projects.list')).projects
	for (const layerId of ['observations', 'tracks']) {
		const { features } = await client.request('layers.getFeatures', {
			projectId: project.projectId,
			layerId,
		})
		assert.deepEqual(features, [], layerId)
	}
	await client.close()
	child.stdin.write('quit\n')
	const [code] = await once(child, 'exit')
	assert.equal(code, 0)
})

test('dev command reports a bad option in one line', async () => {
	const child = spawn(process.execPath, [CLI, '--observations', 'lots'], {
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
	const [code] = await once(child, 'exit')
	assert.equal(code, 1)
	assert.equal(stderr, '--observations must be a whole number\n')
})
