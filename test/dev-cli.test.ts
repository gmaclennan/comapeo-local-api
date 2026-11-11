import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TestClient, type Wire } from './helpers/client.ts'
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
	const [observationLayer] = (
		await client.request('layers.list', { projectId: main.projectId })
	).layers
	assert.equal(observationLayer.readOnlyReason, 'disabled')

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

test('dev command as a member, with editing: the other device, roles and forks', async (t) => {
	const discoveryDir = await tempDir(t)
	const child = spawn(
		process.execPath,
		[
			CLI,
			'--discovery-dir',
			discoveryDir,
			'--as-member',
			'--allow-edits',
			'--edit-delay',
			'300',
			'--observations',
			'40',
			'--photos',
			'0',
			'--tracks',
			'0',
			'--projects',
			'1',
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
	const command = async (line: string) => {
		child.stdin.write(`${line}\n`)
		const reply = await nextLine('')
		assert.match(reply, /^OK /, `${line}: ${reply}`)
		return JSON.parse(reply.slice(3))
	}

	const discoveryFilePath = await nextLine('READY ')
	const client = await TestClient.fromDiscoveryFile(discoveryFilePath)
	t.after(() => client.close())
	const [{ projectId }] = (await client.request('projects.list')).projects
	const feature = async (id: string) =>
		(
			await client.request('layers.getFeatures', {
				projectId,
				layerId: 'observations',
				ids: [id],
			})
		).features[0]

	const { layers } = await client.request('layers.list', { projectId })
	assert.equal(layers[0].editable, true)
	const columns = new Map<string, Wire>(
		layers[0].columns.map((c: Wire) => [c.name, c]),
	)
	assert.equal(columns.get('plot_area').type, 'number')
	assert.equal(columns.get('visit_date').type, 'datetime')
	assert.equal(columns.get('threats').type, 'string_list')
	assert.equal(columns.get('plot_quality').type, 'number')
	assert.equal(columns.get('water_source').categoryIds.length, 2)
	assert.equal(columns.get('well_depth').categoryIds.length, 1)

	const { features: all } = await client.request('layers.getFeatures', {
		projectId,
		layerId: 'observations',
	})
	const { categories } = await client.request('categories.list', {
		projectId,
	})
	for (const name of ['Survey plot', 'Well', 'Spring']) {
		const { categoryId } = categories.find((c: Wire) => c.name === name)
		const inCategory = all.filter((f: Wire) => f.categoryId === categoryId)
		assert.ok(
			inCategory.some((f: Wire) => f.editable),
			`the member has its own ${name}`,
		)
		assert.ok(
			inCategory.some((f: Wire) => !f.editable),
			`the other device has a ${name}`,
		)
	}
	const survey = all.find(
		(f: Wire) => f.properties.notes === 'An example Survey plot' && f.editable,
	)
	assert.deepEqual(survey.properties.threats, ['fire', 'logging'])
	assert.equal(survey.properties.plot_quality, 2)
	assert.equal(survey.properties.visit_date, '2026-03-01')

	const { ids: own } = await command('list own 2')
	const { ids: other } = await command('list other 2')
	const { ids: noLocation } = await command('list nolocation 1')
	assert.equal(own.length, 2)
	assert.equal(other.length, 2)
	assert.equal(noLocation.length, 1)
	assert.equal((await feature(noLocation[0])).geometry, null)
	assert.equal((await feature(own[0])).editable, true)
	assert.equal((await feature(other[0])).editable, false)

	const ownFeature = await feature(own[0])
	const started = Date.now()
	await client.request('features.update', {
		projectId,
		layerId: 'observations',
		id: ownFeature.id,
		version: ownFeature.version,
		properties: { notes: 'from the test' },
	})
	assert.ok(Date.now() - started >= 300, 'the reply was held back')
	const refused = await client
		.request('features.update', {
			projectId,
			layerId: 'observations',
			id: other[0],
			version: (await feature(other[0])).version,
			properties: { notes: 'x' },
		})
		.catch((err: { code: string }) => err)
	assert.equal(refused.code, 'NOT_PERMITTED')

	const remoteUpdate = await command(`remote-update ${other[0]}`)
	assert.equal((await feature(other[0])).version, remoteUpdate.versionId)

	await client.request('subscribe', { projectId })
	await command('role coordinator')
	await client.waitForNotification(
		(n) => n.method === 'layer.schemaChanged',
		5000,
	)
	assert.equal((await feature(other[0])).editable, true)

	const prepared = await command(`fork-prepare ${own[1]}`)
	const before = await feature(own[1])
	assert.equal(before.version, prepared.versionId)
	assert.deepEqual(before.forks, [])
	const released = await command('fork-release')
	const after = await feature(own[1])
	assert.equal(after.version, prepared.versionId, 'the remote version lost')
	assert.equal(after.forks.length, 1)
	assert.deepEqual(after.forks, released.forks)

	const forked = await command(`fork ${own[0]}`)
	assert.deepEqual((await feature(own[0])).forks, forked.forks)

	const created = await command('remote-create')
	assert.equal((await feature(created.docId)).version, created.versionId)
	await command(`remote-delete ${other[1]}`)
	const { removed } = await client.request('layers.getFeatures', {
		projectId,
		layerId: 'observations',
		ids: [other[1]],
	})
	assert.deepEqual(removed, [other[1]])
	await command('role member')

	child.stdin.write('quit\n')
	const [code] = await once(child, 'exit')
	assert.equal(code, 0)
})
