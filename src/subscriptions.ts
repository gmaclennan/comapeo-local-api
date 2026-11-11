import type { MapeoProject } from '@comapeo/core'

import { LAYERS, type LayerId } from './project-data.ts'

const NOTIFICATION_DELAY_MS = 250

export interface Subscriber {
	notify(method: string, params: object): void
}

interface Watch {
	project: MapeoProject
	subscribers: Set<Subscriber>
	/** Kept while the project's cached categories depend on this watch */
	held: boolean
	detach(): void
	changed: Map<LayerId, Set<string>>
	schemaChanged: boolean
	timer: NodeJS.Timeout | null
}

type DocsListener = (docs: Array<{ docId: string }>) => void

interface Emitter {
	on(event: 'updated-docs', listener: DocsListener): unknown
	off(event: 'updated-docs', listener: DocsListener): unknown
}

// A left project's DataTypes return rejected promises, which must not reach the host
function safely(call: () => unknown) {
	try {
		const result = call()
		if (result instanceof Promise) result.catch(() => {})
	} catch {
		// Nothing to undo: the project's data types are already closed
	}
}

/**
 * One `updated-docs` listener per data type per project, shared by every
 * subscriber, because core 7.x attaches its datastore handler again for a
 * second listener but detaches it only once.
 */
export class Subscriptions {
	#watches = new Map<string, Watch>()
	#isJoined: (projectId: string) => Promise<boolean>
	#onSchemaChange: (projectId: string) => void

	/**
	 * `isJoined` is checked when a project closes or this device's role
	 * changes. `onSchemaChange` is called at once when a project's categories,
	 * fields or translations change, and when its watch stops.
	 */
	constructor({
		isJoined,
		onSchemaChange,
	}: {
		isJoined: (projectId: string) => Promise<boolean>
		onSchemaChange: (projectId: string) => void
	}) {
		this.#isJoined = isJoined
		this.#onSchemaChange = onSchemaChange
	}

	add(projectId: string, project: MapeoProject, subscriber: Subscriber) {
		this.#watch(projectId, project).subscribers.add(subscriber)
	}

	/**
	 * Watches the project for schema changes until it closes or is left, so
	 * that its categories can be cached. Returns false when it cannot.
	 */
	hold(projectId: string, project: MapeoProject): boolean {
		this.#watch(projectId, project).held = true
		return this.#watches.get(projectId)?.project === project
	}

	#watch(projectId: string, project: MapeoProject): Watch {
		let watch = this.#watches.get(projectId)
		// A different instance means the project was closed or left and opened again
		if (!watch || watch.project !== project) {
			const previous = watch
			if (previous) this.#stop(projectId, previous)
			watch = this.#attach(projectId, project)
			for (const s of previous?.subscribers ?? []) watch.subscribers.add(s)
			this.#watches.set(projectId, watch)
		}
		return watch
	}

	remove(projectId: string, subscriber: Subscriber) {
		const watch = this.#watches.get(projectId)
		if (!watch) return
		watch.subscribers.delete(subscriber)
		if (watch.subscribers.size === 0 && !watch.held) {
			this.#stop(projectId, watch)
		}
	}

	removeAll(subscriber: Subscriber) {
		for (const projectId of [...this.#watches.keys()]) {
			this.remove(projectId, subscriber)
		}
	}

	close() {
		for (const [projectId, watch] of [...this.#watches]) {
			this.#stop(projectId, watch)
		}
	}

	#stop(projectId: string, watch: Watch) {
		watch.detach()
		if (watch.timer) clearTimeout(watch.timer)
		watch.timer = null
		if (this.#watches.get(projectId) === watch) {
			this.#watches.delete(projectId)
			this.#onSchemaChange(projectId)
		}
	}

	#attach(projectId: string, project: MapeoProject): Watch {
		const watch: Watch = {
			project,
			subscribers: new Set(),
			held: false,
			detach: () => {},
			changed: new Map(),
			schemaChanged: false,
			timer: null,
		}
		const schedule = () => {
			watch.timer ??= setTimeout(
				() => this.#flush(projectId, watch),
				NOTIFICATION_DELAY_MS,
			)
		}
		const onDocs =
			(layerId: LayerId): DocsListener =>
			(docs) => {
				let ids = watch.changed.get(layerId)
				if (!ids) watch.changed.set(layerId, (ids = new Set()))
				for (const doc of docs) ids.add(doc.docId)
				schedule()
			}
		const onSchema: DocsListener = () => {
			if (this.#watches.get(projectId) === watch) {
				this.#onSchemaChange(projectId)
			}
			watch.schemaChanged = true
			schedule()
		}
		// Captured once: after a leave, reading these getters again returns the proxy
		const listeners: Array<[Emitter, DocsListener]> = [
			[project.observation, onDocs('observations')],
			[project.track, onDocs('tracks')],
			[project.preset, onSchema],
			[project.field, onSchema],
			// Category names and column labels follow translations
			[project.$translation.dataType, onSchema],
		]
		for (const [emitter, listener] of listeners) {
			safely(() => emitter.on('updated-docs', listener))
		}

		const isCurrent = () => this.#watches.get(projectId) === watch
		const onRoleChange = () => {
			// What this device may edit has changed
			watch.schemaChanged = true
			schedule()
			this.#isJoined(projectId).then(
				(joined) => {
					if (!joined && isCurrent()) this.#stop(projectId, watch)
				},
				() => {},
			)
		}
		const onClose = () => {
			if (isCurrent()) this.#stop(projectId, watch)
		}
		project.on('own-role-change', onRoleChange)
		project.once('close', onClose)

		watch.detach = () => {
			for (const [emitter, listener] of listeners) {
				safely(() => emitter.off('updated-docs', listener))
			}
			project.off('own-role-change', onRoleChange)
			project.off('close', onClose)
		}
		return watch
	}

	#flush(projectId: string, watch: Watch) {
		watch.timer = null
		const messages: Array<[string, object]> = []
		if (watch.schemaChanged) {
			for (const { layerId } of LAYERS) {
				messages.push(['layer.schemaChanged', { projectId, layerId }])
			}
		}
		for (const [layerId, ids] of watch.changed) {
			if (ids.size === 0) continue
			messages.push([
				'layer.changed',
				{ projectId, layerId, ids: [...ids].sort() },
			])
		}
		watch.changed.clear()
		watch.schemaChanged = false
		for (const subscriber of watch.subscribers) {
			for (const [method, params] of messages) subscriber.notify(method, params)
		}
	}
}
