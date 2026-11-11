import { isDeepStrictEqual } from 'node:util'

import type { MapeoProject } from '@comapeo/core'
import { validate, type ObservationValue } from '@comapeo/core/schema.js'

import { matchCategory } from './categories.ts'
import { ISO_8601, optionsAsSent, type Column } from './columns.ts'
import {
	Conflict,
	FeatureNotFound,
	InvalidValue,
	NotEditable,
	NotPermitted,
	type InvalidValueData,
} from './errors.ts'
import type { PointGeometry } from './params.ts'
import {
	mayEdit,
	permissions,
	type Feature,
	type LayerContext,
	type LayerSpec,
	type ObservationDoc,
	type Permissions,
	type PresetDoc,
	type ProjectData,
} from './project-data.ts'
import type { Subscriptions } from './subscriptions.ts'

export interface EditTarget {
	projectId: string
	layerId: string
	id: string
	version: string
	forks: string[]
	lang?: string | undefined
}

export interface UpdateRequest extends EditTarget {
	properties?: Record<string, unknown> | undefined
	categoryId?: string | undefined
	geometry?: PointGeometry | undefined
}

/** Internal hooks for tests and the dev command; never set by a host. */
export interface EditHooks {
	/** Awaited between the checks and the write, to let a test make a change land there */
	beforeWrite?: () => Promise<void>
}

type Head = ObservationDoc & { forks: string[] }

type Tags = ObservationDoc['tags']
type TagValue = Tags[string]

type Stored = { remove: true } | { value: TagValue } | { reason: string }

interface ColumnChange {
	column: Column
	tagKey: string
	stored: Stored
}

const DOC_ALREADY_DELETED = 'DOC_ALREADY_DELETED_ERROR'

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	const set = new Set(a)
	return set.size === new Set(b).size && b.every((v) => set.has(v))
}

function sameTags(a: Tags, b: Tags): boolean {
	const keys = Object.keys(a)
	return (
		keys.length === Object.keys(b).length &&
		keys.every((k) => Object.hasOwn(b, k) && isDeepStrictEqual(a[k], b[k]))
	)
}

/** A copy that a tag key such as `__proto__` cannot reach through. */
function copyTags(tags: Tags): Tags {
	return Object.assign(Object.create(null) as Tags, tags)
}

function storedValue(column: Column, field: Column['field'], value: unknown) {
	if (value === null) return { remove: true } as const
	const options = field?.options?.length
		? optionsAsSent(field, column.type)
		: undefined
	const fromOption = (sent: unknown): Stored => {
		const i = options?.findIndex((o) => o.value === sent) ?? -1
		const option = field?.options?.[i]
		return option ? { value: option.value } : { reason: 'not-an-option' }
	}
	switch (column.type) {
		case 'string':
			if (typeof value !== 'string') return { reason: 'type' }
			return options ? fromOption(value) : { value: value.trim() }
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				return { reason: 'type' }
			}
			return options ? fromOption(value) : { value }
		case 'boolean':
			if (typeof value !== 'boolean') return { reason: 'type' }
			return options ? fromOption(value) : { value }
		case 'datetime':
			if (typeof value !== 'string') return { reason: 'type' }
			return ISO_8601.test(value) && !Number.isNaN(Date.parse(value))
				? { value }
				: { reason: 'format' }
		case 'string_list': {
			if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
				return { reason: 'type' }
			}
			if (!options) return { value }
			const values: Array<string | number | boolean | null> = []
			for (const v of value) {
				const stored = fromOption(v)
				if (!('value' in stored)) return stored
				values.push(stored.value as string | number | boolean | null)
			}
			return { value: values }
		}
		default:
			return { reason: 'type' }
	}
}

/** PROTOCOL.md "Changing the category": the tags after moving to `target`. */
function categoryTags(
	head: ObservationDoc,
	presets: PresetDoc[],
	target: PresetDoc,
): Tags {
	const olds = new Set<PresetDoc>()
	const shown = matchCategory(head, presets)
	if (shown) olds.add(shown)
	const referenced =
		head.presetRef && presets.find((p) => p.docId === head.presetRef?.docId)
	if (referenced) olds.add(referenced)
	const setBy = (tags: Tags, key: string, value: TagValue) =>
		Object.hasOwn(tags, key) && isDeepStrictEqual(tags[key], value)
	const tags = copyTags({})
	for (const [key, value] of Object.entries(head.tags)) {
		const fromOld = [...olds].some(
			(o) => setBy(o.tags, key, value) || setBy(o.addTags, key, value),
		)
		if (!fromOld && !setBy(target.removeTags, key, value)) tags[key] = value
	}
	return Object.assign(tags, target.tags, target.addTags)
}

function baseValue(head: ObservationDoc): ObservationValue {
	const value: ObservationValue = {
		schemaName: 'observation',
		tags: copyTags(head.tags),
		attachments: head.attachments,
	}
	if (head.lat !== undefined) value.lat = head.lat
	if (head.lon !== undefined) value.lon = head.lon
	if (head.metadata) value.metadata = head.metadata
	if (head.presetRef) value.presetRef = head.presetRef
	return value
}

type Outcome =
	| { kind: 'refused'; error: Error }
	| { kind: 'conflict'; head: Head }
	| { kind: 'done'; doc: ObservationDoc; concurrent: boolean }

/**
 * Applies edits one at a time per project, across connections, following
 * PROTOCOL.md "Editing". Between reading the feature and calling into core
 * nothing is awaited, so no other edit through this API can land in between.
 */
export class Editor {
	#data: ProjectData
	#subscriptions: Subscriptions
	#hooks: EditHooks
	#queues = new Map<string, Promise<unknown>>()

	constructor(
		data: ProjectData,
		subscriptions: Subscriptions,
		hooks: EditHooks = {},
	) {
		this.#data = data
		this.#subscriptions = subscriptions
		this.#hooks = hooks
	}

	async update(project: MapeoProject, spec: LayerSpec, req: UpdateRequest) {
		const outcome = await this.#enqueue(req.projectId, async () => {
			const ctx = await this.#context(project, req, spec, undefined)
			const perms = permissions(project, await project.$getOwnRole())
			const sent = this.#checkLayerForUpdate(ctx, req)

			let target: PresetDoc | undefined
			let held: InvalidValueData | undefined
			if (req.categoryId !== undefined) {
				target = ctx.presets.find((p) => p.docId === req.categoryId)
				if (!target) {
					held = { target: 'category', reason: 'unknown-category' }
				} else if (!target.geometry.includes(spec.presetGeometry)) {
					held = { target: 'category', reason: 'category-not-for-layer' }
				}
			}

			const head = await this.#head(project, req.id)
			// From here to the call into core nothing may be awaited
			const refused = this.#checkFeature(head, req, perms)
			if (refused) return refused
			const doc = head as Head

			const shownBefore = matchCategory(doc, ctx.presets)
			if (target && target.docId === shownBefore?.docId) target = undefined
			const after = held ? undefined : (target ?? shownBefore)

			const changes: ColumnChange[] = []
			for (const [column, value] of sent) {
				let field = column.field
				if (column.edit?.fieldOf) {
					if (held) continue
					field = after && column.edit.fieldOf.get(after.docId)
					if (!field) {
						return refusal(
							new NotEditable({
								target: 'column',
								column: column.name,
								reason: 'not-in-category',
							}),
						)
					}
				}
				changes.push({
					column,
					tagKey: column.tagKey as string,
					stored: storedValue(column, field, value),
				})
			}
			if (held) return refusal(new InvalidValue(held))
			for (const { column, stored } of changes) {
				if ('reason' in stored) {
					return refusal(
						new InvalidValue({
							target: 'column',
							column: column.name,
							reason: stored.reason,
						}),
					)
				}
			}

			const build = (only?: ColumnChange) => {
				const value = baseValue(doc)
				if (target) {
					value.tags = categoryTags(doc, ctx.presets, target)
					value.presetRef = { docId: target.docId, versionId: target.versionId }
				}
				for (const change of changes) {
					if (only && only !== change) continue
					if ('remove' in change.stored) delete value.tags[change.tagKey]
					else if ('value' in change.stored) {
						value.tags[change.tagKey] = change.stored.value
					}
				}
				return value
			}
			const value = build()
			if (matchCategory(value, ctx.presets)?.docId !== after?.docId) {
				if (target) {
					return refusal(
						new InvalidValue({
							target: 'category',
							reason: 'category-would-not-show',
						}),
					)
				}
				const culprit = changes.find(
					(c) => matchCategory(build(c), ctx.presets)?.docId !== after?.docId,
				)
				return refusal(
					new InvalidValue({
						target: 'column',
						...(culprit && { column: culprit.column.name }),
						reason: 'would-change-category',
					}),
				)
			}
			if (
				sameTags(value.tags, doc.tags) &&
				isDeepStrictEqual(value.presetRef, doc.presetRef)
			) {
				return { kind: 'done', doc, concurrent: false } as const
			}
			value.tags = Object.fromEntries(Object.entries(value.tags))
			if (!validate('observation', value)) {
				const first = validate.errors?.[0]
				return refusal(
					new InvalidValue({
						target: changes.length > 0 ? 'column' : 'category',
						reason: 'schema',
						detail:
							`${first?.instancePath ?? ''} ${first?.message ?? ''}`.trim(),
					}),
				)
			}

			const seen = new Set([doc.versionId, ...doc.forks])
			if (this.#hooks.beforeWrite) await this.#hooks.beforeWrite()
			const written = (await project.observation.update(
				doc.versionId,
				value as never,
			)) as Head
			// update() returns the version CoMapeo now shows, ours or one that landed in the gap
			const concurrent = written.forks.some((v) => !seen.has(v))
			return { kind: 'done', doc: written, concurrent } as const
		})
		const feature = await this.#reply(project, spec, req, outcome)
		return outcome.kind === 'done' && outcome.concurrent
			? { feature, concurrent: true }
			: { feature }
	}

	async delete(project: MapeoProject, spec: LayerSpec, req: EditTarget) {
		const outcome = await this.#enqueue(req.projectId, async () => {
			const perms = permissions(project, await project.$getOwnRole())
			if (spec.editOperations.length === 0) {
				return refusal(new NotEditable({ target: 'layer' }))
			}
			if (!spec.editOperations.includes('delete')) {
				return refusal(new NotEditable({ target: 'delete' }))
			}
			const head = await this.#head(project, req.id)
			// From here to the call into core nothing may be awaited
			const refused = this.#checkFeature(head, req, perms)
			if (refused) return refused
			const doc = head as Head
			const seen = new Set([doc.versionId, ...doc.forks])
			if (this.#hooks.beforeWrite) await this.#hooks.beforeWrite()
			let deleted: ObservationDoc
			try {
				deleted = (await project.observation.delete(req.id)) as ObservationDoc
			} catch (err) {
				if (isCode(err, DOC_ALREADY_DELETED)) {
					return refusal(new FeatureNotFound({ deleted: true }))
				}
				throw err
			}
			// delete() returns the version CoMapeo now shows: a write that overlapped it can win
			const concurrent =
				!deleted.deleted ||
				[...(deleted.links ?? []), ...(deleted as Head).forks].some(
					(v) => !seen.has(v),
				)
			return { kind: 'done', doc: deleted, concurrent } as const
		})
		if (outcome.kind === 'refused') throw outcome.error
		if (outcome.kind === 'conflict') {
			throw new Conflict({
				feature: await this.#feature(project, spec, req, outcome.head),
			})
		}
		return outcome.concurrent
			? { id: req.id, concurrent: true }
			: { id: req.id }
	}

	#enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(projectId) ?? Promise.resolve()
		const next = previous.then(task)
		const settled = next.then(
			() => {},
			() => {},
		)
		this.#queues.set(projectId, settled)
		void settled.then(() => {
			if (this.#queues.get(projectId) === settled) {
				this.#queues.delete(projectId)
			}
		})
		return next
	}

	#context(
		project: MapeoProject,
		req: EditTarget,
		spec: LayerSpec,
		lang: string | undefined,
	): Promise<LayerContext> {
		const cached = this.#subscriptions.hold(req.projectId, project)
		return this.#data.layerContext(project, req.projectId, spec, lang, cached)
	}

	/** PROTOCOL.md check 4 for an update: what the layer offers. */
	#checkLayerForUpdate(
		ctx: LayerContext,
		req: UpdateRequest,
	): Array<[Column, unknown]> {
		const ops = ctx.spec.editOperations
		if (ops.length === 0) throw new NotEditable({ target: 'layer' })
		if (req.categoryId !== undefined && !ops.includes('category')) {
			throw new NotEditable({ target: 'category' })
		}
		if (req.geometry !== undefined) {
			throw new NotEditable({ target: 'geometry' })
		}
		const sent: Array<[Column, unknown]> = []
		for (const [name, value] of Object.entries(req.properties ?? {})) {
			const column = ctx.columns.find((c) => c.name === name)
			if (!column?.edit || !ops.includes('properties')) {
				throw new NotEditable({ target: 'column', column: name })
			}
			sent.push([column, value])
		}
		return sent
	}

	async #head(project: MapeoProject, id: string) {
		return (await project.observation.getByDocId(id, {
			mustBeFound: false,
		})) as Head | null
	}

	/** PROTOCOL.md checks 5 to 7. */
	#checkFeature(
		head: Head | null,
		req: EditTarget,
		perms: Permissions,
	): Outcome | undefined {
		if (!head) return refusal(new FeatureNotFound({ deleted: false }))
		if (head.deleted) return refusal(new FeatureNotFound({ deleted: true }))
		if (!mayEdit(perms, head)) {
			return refusal(
				new NotPermitted({ reason: perms.writeOwn ? 'not-own' : 'role' }),
			)
		}
		if (head.versionId !== req.version || !sameSet(head.forks, req.forks)) {
			return { kind: 'conflict', head }
		}
		return undefined
	}

	async #reply(
		project: MapeoProject,
		spec: LayerSpec,
		req: UpdateRequest,
		outcome: Outcome,
	): Promise<Feature> {
		if (outcome.kind === 'refused') throw outcome.error
		if (outcome.kind === 'conflict') {
			throw new Conflict({
				feature: await this.#feature(project, spec, req, outcome.head),
			})
		}
		return this.#feature(project, spec, req, outcome.doc)
	}

	async #feature(
		project: MapeoProject,
		spec: LayerSpec,
		req: EditTarget,
		doc: ObservationDoc,
	): Promise<Feature> {
		const [ctx, role, deviceNames] = await Promise.all([
			this.#context(project, req, spec, req.lang),
			project.$getOwnRole(),
			this.#data.deviceNames(project),
		])
		return this.#data.toFeature(project, ctx, doc, {
			deviceNames,
			perms: permissions(project, role),
		})
	}
}

function refusal(error: Error): Outcome {
	return { kind: 'refused', error }
}

function isCode(err: unknown, code: string): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		err.code === code
	)
}
