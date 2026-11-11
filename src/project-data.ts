import { randomBytes } from 'node:crypto'

import type { MapeoManager, MapeoProject } from '@comapeo/core'
import type { Field, Observation, Preset, Track } from '@comapeo/core/schema.js'

import {
	fetchIcon,
	matchCategory,
	untilAborted,
	type InlineIcon,
} from './categories.ts'
import {
	buildColumns,
	coerceValue,
	NOTES_TAG,
	OBSERVATION_BUILTINS,
	publicColumn,
	schemaVersion,
	TRACK_BUILTINS,
	type Column,
} from './columns.ts'
import { InvalidCursor, LayerNotFound, ProjectNotFound } from './errors.ts'

const DEFAULT_LIMIT = 1000
export const MAX_LIMIT = 5000

interface DocFields {
	docId: string
	versionId: string
	createdAt: string
	updatedAt: string
	createdBy?: string | undefined
	updatedBy?: string | undefined
	deleted: boolean
	forks?: string[]
	links?: string[]
}

export type ObservationDoc = Observation & DocFields
type TrackDoc = Track & DocFields
export type PresetDoc = Preset & DocFields
type FieldDoc = Field & DocFields

export type LayerId = 'observations' | 'tracks'

type EditOperation = 'properties' | 'category' | 'delete'

export type OwnRole = Awaited<ReturnType<MapeoProject['$getOwnRole']>>

export interface LayerSpec {
	layerId: LayerId
	title: string
	docType: 'observation' | 'track'
	geometryType: 'Point' | 'LineString'
	presetGeometry: 'point' | 'line'
	builtins: typeof OBSERVATION_BUILTINS
	/** Empty when the layer cannot be edited through the API */
	editOperations: readonly EditOperation[]
}

export const LAYERS: readonly LayerSpec[] = [
	{
		layerId: 'observations',
		title: 'Observations',
		docType: 'observation',
		geometryType: 'Point',
		presetGeometry: 'point',
		builtins: OBSERVATION_BUILTINS,
		editOperations: ['properties', 'category', 'delete'],
	},
	{
		layerId: 'tracks',
		title: 'Tracks',
		docType: 'track',
		geometryType: 'LineString',
		presetGeometry: 'line',
		builtins: TRACK_BUILTINS,
		editOperations: [],
	},
]

type Geometry =
	| { type: 'Point'; coordinates: [number, number] }
	| { type: 'LineString'; coordinates: Array<[number, number]> }

interface FeatureAttachment {
	type: 'photo' | 'audio' | 'video'
	name: string
	key: string
	urls: { original: string; preview?: string; thumbnail?: string }
}

export interface Feature {
	id: string
	version: string
	forks: string[]
	editable: boolean
	geometry: Geometry | null
	times?: string[]
	properties: Record<string, unknown>
	categoryId: string | null
	attachments: FeatureAttachment[]
}

/** Pages stop growing once their features pass this, well under MAX_FRAME. */
const PAGE_BYTE_BUDGET = 4 * 1024 * 1024
const SNAPSHOT_TTL_MS = 60_000
const MAX_SNAPSHOTS = 16
const YIELD_EVERY = 100

interface CursorState {
	p: string
	l: string
	ids: boolean
	after: string
	/** Snapshot of the layer's sorted ids; optional so an expired one falls back */
	s?: string
}

interface Snapshot {
	projectId: string
	layerId: string
	ids: string[]
	expires: number
}

function encodeCursor(state: CursorState): string {
	return Buffer.from(JSON.stringify(state)).toString('base64url')
}

function decodeCursor(
	cursor: string,
	expected: Omit<CursorState, 'after' | 's'>,
): { after: string; snapshot: string | undefined } {
	let state: unknown
	try {
		state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
	} catch {
		throw new InvalidCursor()
	}
	if (
		typeof state !== 'object' ||
		state === null ||
		!('p' in state && 'l' in state && 'ids' in state && 'after' in state) ||
		state.p !== expected.p ||
		state.l !== expected.l ||
		state.ids !== expected.ids ||
		typeof state.after !== 'string' ||
		('s' in state && typeof state.s !== 'string')
	) {
		throw new InvalidCursor()
	}
	return {
		after: state.after,
		snapshot: 's' in state ? (state.s as string) : undefined,
	}
}

/** Index of the first id greater than `after` in sorted `ids`. */
function firstAfter(ids: string[], after: string): number {
	let lo = 0
	let hi = ids.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if ((ids[mid] as string) <= after) lo = mid + 1
		else hi = mid
	}
	return lo
}

const yieldToEventLoop = () =>
	new Promise<void>((resolve) => setImmediate(resolve))

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

export function getLayerSpec(layerId: string): LayerSpec {
	const spec = LAYERS.find((l) => l.layerId === layerId)
	if (!spec) throw new LayerNotFound({ layerId })
	return spec
}

const GEOMETRY_TYPES = { point: 'Point', line: 'LineString' } as const

export interface LayerContext {
	spec: LayerSpec
	columns: Column[]
	presets: PresetDoc[]
}

/** What this device's role and a document allow, read once per request. */
export interface Permissions {
	deviceId: string
	writeOwn: boolean
	writeOthers: boolean
}

export function permissions(project: MapeoProject, role: OwnRole): Permissions {
	const docs = role.docs.observation
	return {
		deviceId: project.deviceId,
		writeOwn: docs.writeOwn,
		writeOthers: docs.writeOthers,
	}
}

export function mayEdit(
	perms: Permissions,
	doc: { createdBy?: string | undefined },
): boolean {
	return (
		perms.writeOthers || (perms.writeOwn && doc.createdBy === perms.deviceId)
	)
}

function layerColumns(
	spec: LayerSpec,
	presets: PresetDoc[],
	fields: FieldDoc[],
): Column[] {
	return buildColumns({
		builtins: spec.builtins,
		presets,
		fields,
		geometry: spec.presetGeometry,
		editable: spec.editOperations.includes('properties'),
	})
}

interface CachedContexts {
	project: MapeoProject
	byLang: Map<string, Promise<Map<LayerId, LayerContext>>>
}

export interface GetFeaturesParams {
	projectId: string
	layerId: string
	lang?: string | undefined
	limit?: number | undefined
	cursor?: string | null | undefined
	ids?: string[] | undefined
}

/** Reads project data from a MapeoManager in the shapes PROTOCOL.md defines. */
export class ProjectData {
	#manager: MapeoManager
	#allowEdits: boolean
	#iconCache = new Map<string, Promise<InlineIcon | undefined>>()
	#snapshots = new Map<string, Snapshot>()
	#contexts = new Map<string, CachedContexts>()
	#closing = new AbortController()

	constructor(manager: MapeoManager, { allowEdits }: { allowEdits: boolean }) {
		this.#manager = manager
		this.#allowEdits = allowEdits
	}

	/** Makes running requests give up on slow work, such as media server calls. */
	abort() {
		this.#closing.abort()
	}

	async listProjects() {
		const projects = await this.#manager.listProjects()
		return projects
			.filter((p) => p.status === 'joined')
			.map((p) => {
				const out: {
					projectId: string
					name: string
					color?: string
					description?: string
				} = { projectId: p.projectId, name: p.name ?? '' }
				if ('projectColor' in p && p.projectColor) out.color = p.projectColor
				if ('projectDescription' in p && p.projectDescription) {
					out.description = p.projectDescription
				}
				return out
			})
	}

	async isJoined(projectId: string): Promise<boolean> {
		const projects = await this.#manager.listProjects()
		return projects.some(
			(p) => p.projectId === projectId && p.status === 'joined',
		)
	}

	async getProject(projectId: string): Promise<MapeoProject> {
		if (!(await this.isJoined(projectId))) {
			throw new ProjectNotFound({ projectId })
		}
		try {
			return await this.#manager.getProject(projectId)
		} catch (err) {
			if (!(await this.isJoined(projectId))) {
				throw new ProjectNotFound({ projectId }, { cause: err })
			}
			throw err
		}
	}

	async listLayers(projectId: string, lang?: string) {
		const project = await this.getProject(projectId)
		const [{ presets, fields }, role] = await Promise.all([
			this.#loadCategories(project, lang),
			project.$getOwnRole(),
		])
		const perms = permissions(project, role)
		return LAYERS.map((spec) => {
			const columns = layerColumns(spec, presets, fields)
			const readOnlyReason =
				spec.editOperations.length === 0
					? 'unsupported'
					: !this.#allowEdits
						? 'disabled'
						: !perms.writeOwn && !perms.writeOthers
							? 'role'
							: undefined
			return {
				layerId: spec.layerId,
				title: spec.title,
				docType: spec.docType,
				geometryType: spec.geometryType,
				schemaVersion: schemaVersion(columns),
				editable: readOnlyReason === undefined,
				...(readOnlyReason && { readOnlyReason }),
				editOperations: [...spec.editOperations],
				columns: columns.map(publicColumn),
			}
		})
	}

	async listCategories(projectId: string, lang?: string) {
		const project = await this.getProject(projectId)
		const { presets } = await this.#loadCategories(project, lang)
		return Promise.all(
			presets.map(async (preset) => {
				const out: {
					categoryId: string
					name: string
					color?: string
					geometryTypes: string[]
					icon?: InlineIcon
				} = {
					categoryId: preset.docId,
					name: preset.name,
					geometryTypes: LAYERS.filter((l) =>
						preset.geometry.includes(l.presetGeometry),
					).map((l) => GEOMETRY_TYPES[l.presetGeometry]),
				}
				if (preset.color) out.color = preset.color
				if (preset.iconRef) {
					const icon = await this.#getIcon(project, preset.iconRef)
					if (icon) out.icon = icon
				}
				return out
			}),
		)
	}

	async getFeatures(params: GetFeaturesParams) {
		const { projectId, layerId, lang } = params
		const limit = params.limit ?? DEFAULT_LIMIT
		const project = await this.getProject(projectId)
		const spec = getLayerSpec(layerId)
		const byIds = params.ids !== undefined
		const cursorScope = { p: projectId, l: layerId, ids: byIds }
		const cursor =
			params.cursor == null ? null : decodeCursor(params.cursor, cursorScope)
		const after = cursor?.after ?? null

		const [{ presets, fields }, role] = await Promise.all([
			this.#loadCategories(project, lang),
			project.$getOwnRole(),
		])
		const ctx: LayerContext = {
			spec,
			presets,
			columns: layerColumns(spec, presets, fields),
		}
		const perms = permissions(project, role)
		const dataType =
			spec.docType === 'observation' ? project.observation : project.track

		let candidates: string[]
		let loaded: Map<string, ObservationDoc | TrackDoc> | null = null
		let snapshotId: string | undefined
		if (params.ids !== undefined) {
			candidates = [...new Set(params.ids)].sort(compareIds)
			if (after !== null)
				candidates = candidates.slice(firstAfter(candidates, after))
		} else {
			const snapshot = cursor?.snapshot
				? this.#useSnapshot(cursor.snapshot, projectId, layerId)
				: undefined
			if (snapshot && after !== null) {
				snapshotId = cursor?.snapshot
				candidates = snapshot.ids.slice(firstAfter(snapshot.ids, after))
			} else {
				const all = (
					(await dataType.getMany()) as Array<ObservationDoc | TrackDoc>
				)
					.filter((d) => after === null || d.docId > after)
					.sort((a, b) => compareIds(a.docId, b.docId))
				loaded = new Map(all.map((d) => [d.docId, d]))
				candidates = all.map((d) => d.docId)
			}
		}

		const deviceNames = await this.#deviceNames(project)
		const features: Feature[] = []
		const removed: string[] = []
		let bytes = 0
		let lastTaken: string | null = null
		let more = false
		let processed = 0
		for (const id of candidates) {
			if (features.length >= limit) {
				more = true
				break
			}
			if (++processed % YIELD_EVERY === 0) {
				await yieldToEventLoop()
				this.#closing.signal.throwIfAborted()
			}
			let doc = loaded?.get(id)
			if (!doc) {
				doc = ((await dataType.getByDocId(id, { mustBeFound: false })) ??
					undefined) as ObservationDoc | TrackDoc | undefined
			}
			const pageHasItems = features.length + removed.length > 0
			if (!doc || doc.deleted) {
				if (byIds) {
					const size = Buffer.byteLength(JSON.stringify(id), 'utf8') + 1
					if (pageHasItems && bytes + size > PAGE_BYTE_BUDGET) {
						more = true
						break
					}
					removed.push(id)
					bytes += size
				}
				lastTaken = id
				continue
			}
			const feature = await this.toFeature(project, ctx, doc, {
				deviceNames,
				perms,
			})
			const size = Buffer.byteLength(JSON.stringify(feature), 'utf8')
			if (pageHasItems && bytes + size > PAGE_BYTE_BUDGET) {
				more = true
				break
			}
			features.push(feature)
			bytes += size
			lastTaken = id
		}

		let nextCursor: string | null = null
		if (more && lastTaken !== null) {
			if (!byIds && !snapshotId) {
				snapshotId = this.#saveSnapshot(projectId, layerId, candidates)
			}
			nextCursor = encodeCursor({
				...cursorScope,
				after: lastTaken,
				...(snapshotId ? { s: snapshotId } : {}),
			})
		} else if (snapshotId) {
			this.#snapshots.delete(snapshotId)
		}
		return byIds ? { features, removed, nextCursor } : { features, nextCursor }
	}

	#useSnapshot(
		id: string,
		projectId: string,
		layerId: string,
	): Snapshot | undefined {
		const now = Date.now()
		this.#dropExpiredSnapshots(now)
		const snapshot = this.#snapshots.get(id)
		if (
			!snapshot ||
			snapshot.projectId !== projectId ||
			snapshot.layerId !== layerId
		) {
			return undefined
		}
		this.#snapshots.delete(id)
		snapshot.expires = now + SNAPSHOT_TTL_MS
		this.#snapshots.set(id, snapshot)
		return snapshot
	}

	#saveSnapshot(projectId: string, layerId: string, ids: string[]): string {
		const now = Date.now()
		this.#dropExpiredSnapshots(now)
		const id = randomBytes(9).toString('base64url')
		this.#snapshots.set(id, {
			projectId,
			layerId,
			ids,
			expires: now + SNAPSHOT_TTL_MS,
		})
		for (const key of this.#snapshots.keys()) {
			if (this.#snapshots.size <= MAX_SNAPSHOTS) break
			this.#snapshots.delete(key)
		}
		return id
	}

	#dropExpiredSnapshots(now: number) {
		for (const [key, s] of this.#snapshots) {
			if (s.expires <= now) this.#snapshots.delete(key)
		}
	}

	clearCache() {
		this.#iconCache.clear()
		this.#snapshots.clear()
		this.#contexts.clear()
	}

	/** Drops the cached categories and columns of a project. */
	invalidate(projectId: string) {
		this.#contexts.delete(projectId)
	}

	/**
	 * The layer's categories and columns, cached per project and language. Only
	 * cache while `cached` is true, that is while something drops the cache
	 * when the categories change.
	 */
	async layerContext(
		project: MapeoProject,
		projectId: string,
		spec: LayerSpec,
		lang: string | undefined,
		cached: boolean,
	): Promise<LayerContext> {
		const load = async () => {
			const { presets, fields } = await this.#loadCategories(project, lang)
			return new Map(
				LAYERS.map((s) => [
					s.layerId,
					{ spec: s, presets, columns: layerColumns(s, presets, fields) },
				]),
			)
		}
		let contexts: Promise<Map<LayerId, LayerContext>>
		if (!cached) {
			contexts = load()
		} else {
			let entry = this.#contexts.get(projectId)
			if (!entry || entry.project !== project) {
				entry = { project, byLang: new Map() }
				this.#contexts.set(projectId, entry)
			}
			const key = lang ?? ''
			const existing = entry.byLang.get(key)
			if (existing) {
				contexts = existing
			} else {
				contexts = load()
				entry.byLang.set(key, contexts)
				const byLang = entry.byLang
				contexts.catch(() => {
					if (byLang.get(key) === contexts) byLang.delete(key)
				})
			}
		}
		return (await contexts).get(spec.layerId) as LayerContext
	}

	deviceNames(project: MapeoProject) {
		return this.#deviceNames(project)
	}

	async #loadCategories(
		project: MapeoProject,
		lang?: string,
	): Promise<{ presets: PresetDoc[]; fields: FieldDoc[] }> {
		const opts = lang ? { lang } : {}
		try {
			const [presets, fields] = await Promise.all([
				project.preset.getMany(opts) as Promise<PresetDoc[]>,
				project.field.getMany(opts) as Promise<FieldDoc[]>,
			])
			return { presets, fields }
		} catch (err) {
			// PROTOCOL.md: a lang the server cannot use falls back to the default
			if (lang) return this.#loadCategories(project)
			throw err
		}
	}

	async #deviceNames(project: MapeoProject): Promise<Map<string, string>> {
		const members = await project.$member.getMany()
		const names = new Map<string, string>()
		for (const m of members) if (m.name) names.set(m.deviceId, m.name)
		return names
	}

	#getIcon(
		project: MapeoProject,
		iconRef: { docId: string; versionId: string },
	) {
		let pending = this.#iconCache.get(iconRef.versionId)
		if (!pending) {
			pending = fetchIcon(project.$icons, iconRef.docId, this.#closing.signal)
			this.#iconCache.set(iconRef.versionId, pending)
			pending.then((icon) => {
				if (!icon) this.#iconCache.delete(iconRef.versionId)
			})
		}
		return pending
	}

	async toFeature(
		project: MapeoProject,
		ctx: LayerContext,
		doc: ObservationDoc | TrackDoc,
		{
			deviceNames,
			perms,
		}: { deviceNames: Map<string, string>; perms: Permissions },
	): Promise<Feature> {
		const category = matchCategory(doc, ctx.presets)
		const deviceName = (deviceId: string | undefined) =>
			deviceId ? (deviceNames.get(deviceId) ?? deviceId) : null

		const tag = (key: string) =>
			Object.hasOwn(doc.tags, key) ? doc.tags[key] : undefined
		const builtinValues: Record<string, unknown> = {
			id: doc.docId,
			category: category?.name ?? null,
			created_at: doc.createdAt,
			updated_at: doc.updatedAt,
			created_by: deviceName(doc.createdBy),
			updated_by: deviceName(doc.updatedBy),
		}

		let geometry: Geometry | null = null
		let times: string[] | undefined
		let attachments: FeatureAttachment[] = []

		if (doc.schemaName === 'observation') {
			const coords = doc.metadata?.position?.coords
			builtinValues.accuracy = coords?.accuracy ?? null
			builtinValues.altitude = coords?.altitude ?? null
			builtinValues.photo_count = doc.attachments.filter(
				(a) => a.type === 'photo',
			).length
			builtinValues.audio_count = doc.attachments.filter(
				(a) => a.type === 'audio',
			).length
			builtinValues.notes = tag(NOTES_TAG)
			if (typeof doc.lat === 'number' && typeof doc.lon === 'number') {
				geometry = { type: 'Point', coordinates: [doc.lon, doc.lat] }
			}
			attachments = await this.#attachments(project, doc.attachments)
		} else {
			const locations = doc.locations ?? []
			times = locations.map((l) => l.timestamp)
			builtinValues.start_time = times[0] ?? null
			builtinValues.end_time = times[times.length - 1] ?? null
			if (locations.length >= 2) {
				geometry = {
					type: 'LineString',
					coordinates: locations.map((l) => [
						l.coords.longitude,
						l.coords.latitude,
					]),
				}
			} else {
				times = []
			}
		}

		// A column or tag key such as `__proto__` or `constructor` must not reach Object.prototype
		const properties: Record<string, unknown> = Object.create(null)
		for (const column of ctx.columns) {
			if (column.role === 'builtin') {
				properties[column.name] = coerceValue(
					builtinValues[column.builtin as string],
					column.type,
				)
			} else if (column.role === 'field') {
				properties[column.name] = coerceValue(
					tag(column.tagKey as string),
					column.type,
				)
			} else {
				properties[column.name] = doc.tags
			}
		}

		const feature: Feature = {
			id: doc.docId,
			version: doc.versionId,
			forks: [...(doc.forks ?? [])].sort(compareIds),
			editable: ctx.spec.editOperations.length > 0 && mayEdit(perms, doc),
			geometry,
			properties,
			categoryId: category?.docId ?? null,
			attachments,
		}
		if (times) feature.times = times
		return feature
	}

	async #attachments(
		project: MapeoProject,
		attachments: Observation['attachments'],
	): Promise<FeatureAttachment[]> {
		const out: FeatureAttachment[] = []
		const getUrl = (blobId: Parameters<MapeoProject['$blobs']['getUrl']>[0]) =>
			untilAborted(project.$blobs.getUrl(blobId), this.#closing.signal)
		for (const a of attachments) {
			if (a.type !== 'photo' && a.type !== 'audio' && a.type !== 'video')
				continue
			const base = { driveId: a.driveDiscoveryId, name: a.name }
			const urls: FeatureAttachment['urls'] =
				a.type === 'photo'
					? {
							thumbnail: await getUrl({
								...base,
								type: 'photo',
								variant: 'thumbnail',
							}),
							preview: await getUrl({
								...base,
								type: 'photo',
								variant: 'preview',
							}),
							original: await getUrl({
								...base,
								type: 'photo',
								variant: 'original',
							}),
						}
					: {
							original: await getUrl({
								...base,
								type: a.type,
								variant: 'original',
							}),
						}
			out.push({
				type: a.type,
				name: a.name,
				key: `${a.driveDiscoveryId}/${a.type}/${a.name}`,
				urls,
			})
		}
		return out
	}
}
