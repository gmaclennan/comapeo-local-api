import type { MapeoProject } from '@comapeo/core'
import type {
	FieldValue,
	Observation,
	ObservationValue,
	PresetValue,
} from '@comapeo/core/schema.js'

import { createRandom, randomObservation, type Random } from './seed.ts'

type ObservationDoc = Observation & { docId: string; versionId: string }

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

export interface CommandResult {
	action: string
	projectId: string
	docId?: string
	versionId?: string
}

/** Mutations a developer can trigger from stdin to exercise live updates. */
export class DevCommands {
	#projects: Array<{ projectId: string; project: MapeoProject }>
	#random: Random
	#categoryCount = 0

	constructor(
		projects: Array<{ projectId: string; project: MapeoProject }>,
		seed: number,
	) {
		this.#projects = projects
		this.#random = createRandom(seed + 7919)
	}

	static readonly HELP = [
		'Commands (optional project number, 1-based, defaults to 1):',
		'  create [project]          create an observation',
		'  update [project] [docId]  move an observation and change a tag',
		'  delete [project] [docId]  delete an observation',
		'  category [project]        add a category with a new field',
		'  help                      show this help',
		'  quit                      stop the server (as Ctrl-C does)',
	].join('\n')

	async run(line: string): Promise<CommandResult | null> {
		const [command, ...args] = line.trim().split(/\s+/)
		if (!command) return null
		let index = 0
		if (args[0] && /^\d+$/.test(args[0])) index = Number(args.shift()) - 1
		const target = this.#projects[index]
		if (!target) throw new Error(`No project number ${index + 1}`)
		const { project, projectId } = target
		switch (command) {
			case 'create': {
				const value = await randomObservation(project, this.#random)
				value.tags.notes = `Created from the dev command at ${new Date().toISOString()}`
				const doc = await project.observation.create(value)
				return {
					action: 'create',
					projectId,
					docId: doc.docId,
					versionId: doc.versionId,
				}
			}
			case 'update': {
				const doc = await this.#pick(project, args[0])
				const value = editable(doc)
				value.tags.notes = `Updated from the dev command at ${new Date().toISOString()}`
				if (value.lat !== undefined && value.lon !== undefined) {
					value.lat = Number(
						(value.lat + (this.#random() - 0.5) * 0.01).toFixed(6),
					)
					value.lon = Number(
						(value.lon + (this.#random() - 0.5) * 0.01).toFixed(6),
					)
				}
				const updated = await project.observation.update(doc.versionId, value)
				return {
					action: 'update',
					projectId,
					docId: updated.docId,
					versionId: updated.versionId,
				}
			}
			case 'delete': {
				const doc = await this.#pick(project, args[0])
				const deleted = await project.observation.delete(doc.docId)
				return {
					action: 'delete',
					projectId,
					docId: deleted.docId,
					versionId: deleted.versionId,
				}
			}
			case 'category': {
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
					projectId,
					docId: preset.docId,
					versionId: preset.versionId,
				}
			}
			default:
				throw new Error(`Unknown command ${command}; type "help"`)
		}
	}

	async #pick(
		project: MapeoProject,
		docId: string | undefined,
	): Promise<ObservationDoc> {
		if (docId)
			return (await project.observation.getByDocId(docId)) as ObservationDoc
		const all = (await project.observation.getMany()) as ObservationDoc[]
		if (all.length === 0) throw new Error('The project has no observations')
		return all[Math.floor(this.#random() * all.length)] as ObservationDoc
	}
}
