import { setTimeout as delay } from 'node:timers/promises'

import { roles, type MapeoProject } from '@comapeo/core'
import type {
	FieldValue,
	Observation,
	ObservationValue,
	PresetValue,
} from '@comapeo/core/schema.js'

import { until } from './peers.ts'
import { createRandom, randomObservation, type Random } from './seed.ts'

type ObservationDoc = Observation & {
	docId: string
	versionId: string
	updatedAt: string
	createdBy?: string | undefined
	forks: string[]
}

function editable(doc: ObservationDoc): ObservationValue {
	const value: ObservationValue = {
		schemaName: 'observation',
		tags: { ...doc.tags },
		attachments: doc.attachments,
	}
	if (doc.lat !== undefined) value.lat = doc.lat
	if (doc.lon !== undefined) value.lon = doc.lon
	if (doc.metadata) value.metadata = doc.metadata
	if (doc.presetRef) value.presetRef = doc.presetRef
	return value
}

function withNotes(doc: ObservationDoc, notes: string): ObservationValue {
	const value = editable(doc)
	value.tags.notes = `${notes} at ${new Date().toISOString()}`
	return value
}

const hasLocation = (doc: ObservationDoc) =>
	typeof doc.lat === 'number' && typeof doc.lon === 'number'

export interface DevProject {
	projectId: string
	/** The project on the served device */
	project: MapeoProject
	/** The same project on the second device, in member mode */
	remote?: MapeoProject | undefined
}

export interface CommandResult {
	action: string
	projectId: string
	docId?: string
	versionId?: string
	forks?: string[]
	ids?: string[]
	roleId?: string
}

const ROLE_IDS: Record<string, typeof roles.MEMBER_ROLE_ID> = {
	member: roles.MEMBER_ROLE_ID,
	coordinator: roles.COORDINATOR_ROLE_ID as typeof roles.MEMBER_ROLE_ID,
}

function summary(doc: ObservationDoc) {
	return { docId: doc.docId, versionId: doc.versionId, forks: doc.forks }
}

/** Mutations a developer can trigger from stdin to exercise live updates. */
export class DevCommands {
	#projects: DevProject[]
	#random: Random
	#categoryCount = 0
	#preparedFork: { docId: string; remoteVersion: string } | null = null

	constructor(projects: DevProject[], seed: number) {
		this.#projects = projects
		this.#random = createRandom(seed + 7919)
	}

	static readonly HELP = [
		'Commands (optional project number, 1-based, defaults to 1). Each prints',
		'OK once the served device has indexed the change:',
		'  create [project]               create an observation',
		'  update [project] [docId]       move an observation and change a tag',
		'  delete [project] [docId]       delete an observation',
		'  category [project]             add a category with a new field',
		'  fork [project] [docId]         fork an observation on this device',
		'  list [project] own|other|nolocation [n]',
		'                                 ids of observations of that kind',
		'With --as-member, on the first project:',
		'  remote-create                  create an observation on the other device',
		'  remote-update [docId]          change an observation on the other device',
		'  remote-delete [docId]          delete an observation on the other device',
		'  role member|coordinator        change the served device’s role',
		'  fork-prepare [docId]           stop sync, change an observation on both',
		'                                 devices, the served one last',
		'  fork-release                   restart sync; OK once the fork has arrived',
		'  help                           show this help',
		'  quit                           stop the server (as Ctrl-C does)',
	].join('\n')

	async run(line: string): Promise<CommandResult | null> {
		const [command, ...args] = line.trim().split(/\s+/)
		if (!command) return null
		let index = 0
		if (args[0] && /^\d+$/.test(args[0])) index = Number(args.shift()) - 1
		const target = this.#projects[index]
		if (!target) throw new Error(`No project number ${index + 1}`)
		const { project, projectId } = target
		const result = (action: string, doc: ObservationDoc) => ({
			action,
			projectId,
			docId: doc.docId,
			versionId: doc.versionId,
		})
		switch (command) {
			case 'create': {
				const value = await randomObservation(project, this.#random)
				value.tags.notes = `Created from the dev command at ${new Date().toISOString()}`
				return result(
					'create',
					(await project.observation.create(value)) as ObservationDoc,
				)
			}
			case 'update': {
				const doc = await this.#pick(project, args[0])
				const value = withNotes(doc, 'Updated from the dev command')
				if (value.lat !== undefined && value.lon !== undefined) {
					value.lat = Number(
						(value.lat + (this.#random() - 0.5) * 0.01).toFixed(6),
					)
					value.lon = Number(
						(value.lon + (this.#random() - 0.5) * 0.01).toFixed(6),
					)
				}
				return result(
					'update',
					(await project.observation.update(
						doc.versionId,
						value,
					)) as ObservationDoc,
				)
			}
			case 'delete': {
				const doc = await this.#pick(project, args[0])
				return result(
					'delete',
					(await project.observation.delete(doc.docId)) as ObservationDoc,
				)
			}
			case 'category':
				return { ...(await this.#addCategory(project)), projectId }
			case 'fork': {
				const doc = await this.#pick(project, args[0], this.#own(project))
				const first = await project.observation.update(
					doc.versionId,
					withNotes(doc, 'First of two versions'),
				)
				await delay(50)
				const second = (await project.observation.update(
					doc.versionId,
					withNotes(doc, 'Second of two versions'),
				)) as ObservationDoc
				if (!second.forks.includes(first.versionId)) {
					throw new Error('Core did not keep both versions')
				}
				return { action: 'fork', projectId, ...summary(second) }
			}
			case 'list': {
				const [kind, n = '5'] = args
				const filters: Record<string, (d: ObservationDoc) => boolean> = {
					own: this.#own(project),
					other: (d) => d.createdBy !== project.deviceId && hasLocation(d),
					nolocation: (d) => !hasLocation(d),
				}
				const filter = kind ? filters[kind] : undefined
				if (!filter) throw new Error('Usage: list own|other|nolocation [n]')
				const all = (await project.observation.getMany()) as ObservationDoc[]
				const ids = all
					.filter(filter)
					.map((d) => d.docId)
					.sort()
					.slice(0, Number(n))
				return { action: 'list', projectId, ids }
			}
			case 'remote-create':
			case 'remote-update':
			case 'remote-delete':
			case 'role':
			case 'fork-prepare':
			case 'fork-release':
				return this.#remote(command, target, args)
			default:
				throw new Error(`Unknown command ${command}; type "help"`)
		}
	}

	async #remote(
		command: string,
		{ project, projectId, remote }: DevProject,
		args: string[],
	): Promise<CommandResult> {
		if (!remote) {
			throw new Error(`${command} needs --as-member, on the first project`)
		}
		const indexed = async (doc: ObservationDoc) => {
			await this.#untilIndexed(project, doc.docId, doc.versionId)
			return { action: command, projectId, ...summary(doc) }
		}
		switch (command) {
			case 'remote-create': {
				const value = await randomObservation(remote, this.#random)
				value.tags.notes = `Created on the other device at ${new Date().toISOString()}`
				return indexed(
					(await remote.observation.create(value)) as ObservationDoc,
				)
			}
			case 'remote-update': {
				const doc = await this.#pick(remote, args[0], this.#other(project))
				return indexed(
					(await remote.observation.update(
						doc.versionId,
						withNotes(doc, 'Updated on the other device'),
					)) as ObservationDoc,
				)
			}
			case 'remote-delete': {
				const doc = await this.#pick(remote, args[0], this.#other(project))
				return indexed(
					(await remote.observation.delete(doc.docId)) as ObservationDoc,
				)
			}
			case 'role': {
				const roleId = args[0] ? ROLE_IDS[args[0]] : undefined
				if (!roleId) throw new Error('Usage: role member|coordinator')
				await remote.$member.assignRole(project.deviceId, roleId)
				await until(
					async () => (await project.$getOwnRole()).roleId === roleId,
					'the served device to have the new role',
				)
				return { action: 'role', projectId, roleId }
			}
			case 'fork-prepare': {
				const doc = await this.#pick(project, args[0], this.#own(project))
				const remoteDoc = (await remote.observation.getByDocId(
					doc.docId,
				)) as ObservationDoc
				project.$sync.stop()
				remote.$sync.stop()
				const theirs = (await remote.observation.update(
					remoteDoc.versionId,
					withNotes(remoteDoc, 'Changed on the other device, earlier'),
				)) as ObservationDoc
				// CoMapeo shows the later version, which must be the served device's
				await delay(100)
				let ours = (await project.observation.update(
					doc.versionId,
					withNotes(doc, 'Changed on the served device, later'),
				)) as ObservationDoc
				while (ours.updatedAt <= theirs.updatedAt) {
					await delay(100)
					ours = (await project.observation.update(
						ours.versionId,
						withNotes(ours, 'Changed on the served device, later'),
					)) as ObservationDoc
				}
				this.#preparedFork = {
					docId: doc.docId,
					remoteVersion: theirs.versionId,
				}
				return { action: command, projectId, ...summary(ours) }
			}
			case 'fork-release': {
				const prepared = this.#preparedFork
				if (!prepared) throw new Error('Run fork-prepare first')
				const before = (await project.observation.getByDocId(
					prepared.docId,
				)) as ObservationDoc
				project.$sync.start()
				remote.$sync.start()
				const forked = await until(async () => {
					const doc = (await project.observation.getByDocId(
						prepared.docId,
					)) as ObservationDoc
					return doc.forks.includes(prepared.remoteVersion) && doc
				}, 'the other device’s version to arrive')
				this.#preparedFork = null
				if (forked.versionId !== before.versionId) {
					throw new Error('The version shown changed: the fork did not lose')
				}
				return { action: command, projectId, ...summary(forked) }
			}
			default:
				throw new Error(`Unknown command ${command}`)
		}
	}

	#own(project: MapeoProject) {
		return (d: ObservationDoc) =>
			d.createdBy === project.deviceId && hasLocation(d)
	}

	#other(project: MapeoProject) {
		return (d: ObservationDoc) => d.createdBy !== project.deviceId
	}

	async #untilIndexed(project: MapeoProject, docId: string, versionId: string) {
		await until(async () => {
			const doc = (await project.observation.getByDocId(docId, {
				mustBeFound: false,
			})) as ObservationDoc | null
			return doc?.versionId === versionId || doc?.forks.includes(versionId)
		}, 'the served device to index the change')
	}

	async #addCategory(project: MapeoProject) {
		const n = ++this.#categoryCount
		const field = await project.field.create({
			schemaName: 'field',
			tagKey: `dev-field-${n}`,
			type: 'selectOne',
			label: `Dev field ${n}`,
			options: [
				{ value: 'yes', label: 'Yes' },
				{ value: 'no', label: 'No' },
			],
		} satisfies FieldValue)
		const preset = await project.preset.create({
			schemaName: 'preset',
			name: `Dev category ${n}`,
			geometry: ['point'],
			tags: { 'dev-category': String(n) },
			addTags: {},
			removeTags: {},
			fieldRefs: [{ docId: field.docId, versionId: field.versionId }],
			terms: [],
			color: '#E36414',
		} satisfies PresetValue)
		return {
			action: 'category',
			docId: preset.docId,
			versionId: preset.versionId,
		}
	}

	async #pick(
		project: MapeoProject,
		docId: string | undefined,
		filter: (doc: ObservationDoc) => boolean = () => true,
	): Promise<ObservationDoc> {
		if (docId) {
			return (await project.observation.getByDocId(docId)) as ObservationDoc
		}
		const all = ((await project.observation.getMany()) as ObservationDoc[])
			.filter(filter)
			.sort((a, b) => (a.docId < b.docId ? -1 : 1))
		if (all.length === 0) throw new Error('No observation of that kind')
		return all[Math.floor(this.#random() * all.length)] as ObservationDoc
	}
}
