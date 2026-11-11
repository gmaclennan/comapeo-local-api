import { createHash, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import type { MapeoManager } from '@comapeo/core'

import {
	assertSocketPathLength,
	createSocketLocation,
	generateSecret,
	isWindowsPipe,
	removeDiscoveryFile,
	writeDiscoveryFile,
	type SocketLocation,
} from './discovery.ts'
import { Editor, type EditHooks, type EditTarget } from './editing.ts'
import {
	EditingDisabled,
	InternalError,
	MethodNotFound,
	PROTOCOL_ERROR_CODES,
	ServerAlreadyStarted,
	ServerClosed,
	UnsupportedProtocolVersion,
	InvalidParams,
} from './errors.ts'
import {
	encodeFrame,
	FrameDecoder,
	MAX_FRAME,
	PRE_AUTH_MAX_FRAME,
} from './framing.ts'
import { SERVER_INFO } from './package-info.ts'
import {
	optionalCategoryId,
	optionalForks,
	optionalIds,
	optionalLang,
	optionalLimit,
	optionalPoint,
	optionalProperties,
	optionalString,
	requireString,
	type Params,
} from './params.ts'
import { getLayerSpec, ProjectData } from './project-data.ts'
import { Subscriptions, type Subscriber } from './subscriptions.ts'

export const PROTOCOL_VERSIONS: readonly number[] = [1]

const HELLO_TIMEOUT_MS = 5000

export interface AppInfo {
	name: string
	version: string
}

export interface LocalApiServerOptions {
	/** The running CoMapeo instance to serve data from */
	manager: MapeoManager
	/** Directory to write `comapeo-local-api.json` into */
	discoveryDir: string
	/** Identifies the host app to clients */
	app: AppInfo
	/** Unix socket path or Windows named pipe; generated when omitted */
	socketPath?: string
	/**
	 * Lets clients change and delete observations (PROTOCOL.md "Editing").
	 * Off unless true; fixed for the life of the server.
	 */
	allowEdits?: boolean
}

/** Not part of the package's API: seams for tests and the dev command. */
export interface InternalServerOptions extends EditHooks {
	/** Holds back each edit's reply, after the edit is written */
	editReplyDelayMs?: number
}

export interface ListenResult {
	socketPath: string
	discoveryFilePath: string
}

export interface LocalApiServer {
	/** Starts listening and writes the discovery file. */
	listen(): Promise<ListenResult>
	/** Disconnects clients, stops listening and removes the discovery file. */
	close(): Promise<void>
}

type Handler = (params: Params, connection: Connection) => Promise<object>

function sha256(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest()
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface WireError {
	code: string
	message: string
	data?: unknown
}

function toWireError(err: unknown): WireError {
	if (
		err instanceof Error &&
		'code' in err &&
		typeof err.code === 'string' &&
		PROTOCOL_ERROR_CODES.has(err.code)
	) {
		const data = 'data' in err ? err.data : undefined
		return data === undefined
			? { code: err.code, message: err.message }
			: { code: err.code, message: err.message, data }
	}
	const internal = new InternalError()
	const detail = err instanceof Error ? err.message : String(err)
	return { code: internal.code, message: `${internal.message}: ${detail}` }
}

type Request = { id: number; method: string; params: unknown }

/**
 * One client connection. Requests are handled one at a time, in order, and the
 * next is not read until the previous reply has been flushed to the socket, so
 * a client that does not read its replies cannot make the host buffer more
 * than one reply. Notifications are not held back.
 */
class Connection implements Subscriber {
	#socket: net.Socket
	#decoder = new FrameDecoder(PRE_AUTH_MAX_FRAME)
	#authed = false
	#closed = false
	#ending = false
	#busy = false
	#helloTimer: NodeJS.Timeout
	#secretDigest: Buffer
	#onHello: (params: Record<string, unknown>) => object
	#dispatch: (request: Request, c: Connection) => Promise<void>
	#onClose: (c: Connection) => void

	constructor(
		socket: net.Socket,
		opts: {
			secretDigest: Buffer
			onHello: (params: Record<string, unknown>) => object
			dispatch: (request: Request, c: Connection) => Promise<void>
			onClose: (c: Connection) => void
		},
	) {
		this.#socket = socket
		this.#secretDigest = opts.secretDigest
		this.#onHello = opts.onHello
		this.#dispatch = opts.dispatch
		this.#onClose = opts.onClose
		this.#helloTimer = setTimeout(() => this.destroy(), HELLO_TIMEOUT_MS)
		socket.on('data', (chunk: Buffer) => this.#onData(chunk))
		socket.on('error', () => this.destroy())
		socket.on('close', () => this.destroy())
	}

	get closed(): boolean {
		return this.#closed
	}

	/** Sends a reply; a result too large for a frame becomes an INTERNAL_ERROR. */
	respond(id: number, reply: { result: object } | { error: WireError }) {
		if (this.#closed || !this.#authed) return
		let bytes: Buffer
		try {
			bytes = encodeFrame({ id, ...reply })
		} catch (err) {
			bytes = encodeFrame({ id, error: toWireError(err) })
		}
		this.#socket.write(bytes)
	}

	notify(method: string, params: object) {
		if (this.#closed || !this.#authed) return
		try {
			this.#socket.write(encodeFrame({ method, params }))
		} catch {
			// A notification too large to frame is dropped; ids are short
		}
	}

	destroy() {
		if (this.#closed) return
		this.#closed = true
		clearTimeout(this.#helloTimer)
		this.#socket.destroy()
		this.#onClose(this)
	}

	#onData(chunk: Buffer) {
		if (this.#closed || this.#ending) return
		this.#decoder.push(chunk)
		this.#pump()
	}

	#pump() {
		while (!this.#busy && !this.#closed && !this.#ending) {
			let frame: Buffer | undefined
			try {
				frame = this.#decoder.next()
			} catch {
				this.destroy()
				return
			}
			if (!frame) {
				this.#socket.resume()
				return
			}
			let message: unknown
			try {
				message = JSON.parse(frame.toString('utf8'))
			} catch {
				this.destroy()
				return
			}
			if (!this.#authed) {
				this.#handleHello(message)
				continue
			}
			const request = this.#parseRequest(message)
			if (!request) return
			this.#busy = true
			this.#socket.pause()
			void this.#dispatch(request, this).then(() => this.#whenFlushed())
		}
	}

	#whenFlushed() {
		if (this.#closed) return
		const next = () => {
			this.#busy = false
			this.#pump()
		}
		if (this.#socket.writableNeedDrain) this.#socket.once('drain', next)
		else next()
	}

	#handleHello(message: unknown) {
		if (
			!isObject(message) ||
			typeof message.id !== 'number' ||
			message.method !== 'hello' ||
			!isObject(message.params) ||
			typeof message.params.secret !== 'string' ||
			!Array.isArray(message.params.protocolVersions)
		) {
			this.destroy()
			return
		}
		if (!timingSafeEqual(sha256(message.params.secret), this.#secretDigest)) {
			this.destroy()
			return
		}
		const offered = message.params.protocolVersions.filter(
			(v): v is number => typeof v === 'number',
		)
		const shared = PROTOCOL_VERSIONS.filter((v) => offered.includes(v))
		if (shared.length === 0) {
			const err = new UnsupportedProtocolVersion({
				supported: PROTOCOL_VERSIONS.join(', '),
			})
			this.#ending = true
			clearTimeout(this.#helloTimer)
			this.#socket.end(
				encodeFrame({
					id: message.id,
					error: {
						code: err.code,
						message: err.message,
						data: { supported: [...PROTOCOL_VERSIONS] },
					},
				}),
				() => this.destroy(),
			)
			return
		}
		clearTimeout(this.#helloTimer)
		this.#authed = true
		this.#decoder.maxFrame = MAX_FRAME
		this.respond(message.id, {
			result: {
				protocolVersion: Math.max(...shared),
				...this.#onHello(message.params),
			},
		})
	}

	/** Returns the request to run, or nothing if the message was fatal. */
	#parseRequest(message: unknown): Request | undefined {
		if (
			!isObject(message) ||
			typeof message.id !== 'number' ||
			typeof message.method !== 'string'
		) {
			this.destroy()
			return undefined
		}
		const { id, method } = message
		return { id, method, params: message.params ?? {} }
	}
}

function editTarget(params: Params): EditTarget {
	return {
		projectId: requireString(params, 'projectId'),
		layerId: requireString(params, 'layerId'),
		id: requireString(params, 'id'),
		version: requireString(params, 'version'),
		forks: optionalForks(params),
	}
}

/**
 * Creates a server that exposes project data from `manager` on a local
 * socket, following PROTOCOL.md version 1. Data can be changed only when
 * `allowEdits` is true.
 */
export function createLocalApiServer(
	options: LocalApiServerOptions,
): LocalApiServer {
	return createServer(options)
}

export function createServer(
	options: LocalApiServerOptions,
	internal: InternalServerOptions = {},
): LocalApiServer {
	const { manager, discoveryDir, app } = options
	const allowEdits = options.allowEdits === true
	const data = new ProjectData(manager, { allowEdits })
	const subscriptions = new Subscriptions({
		isJoined: (projectId) => data.isJoined(projectId),
		onSchemaChange: (projectId) => data.invalidate(projectId),
	})
	const { editReplyDelayMs = 0, ...hooks } = internal
	const editor = new Editor(data, subscriptions, hooks)
	const afterEdit = () =>
		editReplyDelayMs > 0 ? delay(editReplyDelayMs) : undefined
	const connections = new Set<Connection>()
	const inFlight = new Set<Promise<void>>()
	const secret = generateSecret()
	const secretDigest = sha256(secret)
	let server: net.Server | null = null
	let location: SocketLocation | null = null
	let discoveryFilePath: string | null = null
	let state: 'idle' | 'listening' | 'closed' = 'idle'
	let closing: Promise<void> | null = null
	let starting: Promise<ListenResult> | null = null

	const handlers: Record<string, Handler> = {
		async 'projects.list'() {
			return { projects: await data.listProjects() }
		},
		async 'layers.list'(params) {
			const layers = await data.listLayers(
				requireString(params, 'projectId'),
				optionalLang(params),
			)
			return { layers }
		},
		async 'layers.getFeatures'(params) {
			return data.getFeatures({
				projectId: requireString(params, 'projectId'),
				layerId: requireString(params, 'layerId'),
				lang: optionalLang(params),
				limit: optionalLimit(params),
				cursor: optionalString(params, 'cursor'),
				ids: optionalIds(params),
			})
		},
		async 'categories.list'(params) {
			const categories = await data.listCategories(
				requireString(params, 'projectId'),
				optionalLang(params),
			)
			return { categories }
		},
		async subscribe(params, connection) {
			const projectId = requireString(params, 'projectId')
			const project = await data.getProject(projectId)
			if (state === 'listening' && !connection.closed) {
				subscriptions.add(projectId, project, connection)
			}
			return {}
		},
		async unsubscribe(params, connection) {
			subscriptions.remove(requireString(params, 'projectId'), connection)
			return {}
		},
		async 'features.update'(params) {
			const req = {
				...editTarget(params),
				properties: optionalProperties(params),
				categoryId: optionalCategoryId(params),
				geometry: optionalPoint(params),
				lang: optionalLang(params),
			}
			if (
				req.categoryId === undefined &&
				req.geometry === undefined &&
				Object.keys(req.properties ?? {}).length === 0
			) {
				throw new InvalidParams({ reason: 'there is nothing to change' })
			}
			if (!allowEdits) throw new EditingDisabled()
			const project = await data.getProject(req.projectId)
			const spec = getLayerSpec(req.layerId)
			try {
				return await editor.update(project, spec, req)
			} finally {
				await afterEdit()
			}
		},
		async 'features.delete'(params) {
			const req = editTarget(params)
			if (!allowEdits) throw new EditingDisabled()
			const project = await data.getProject(req.projectId)
			const spec = getLayerSpec(req.layerId)
			try {
				return await editor.delete(project, spec, req)
			} finally {
				await afterEdit()
			}
		},
	}

	const run = async (request: Request, connection: Connection) => {
		const handler = Object.hasOwn(handlers, request.method)
			? handlers[request.method]
			: undefined
		try {
			if (!isObject(request.params)) {
				throw new InvalidParams({ reason: 'params must be an object' })
			}
			if (!handler) throw new MethodNotFound({ method: request.method })
			const result = await handler(request.params, connection)
			connection.respond(request.id, { result })
		} catch (err) {
			connection.respond(request.id, { error: toWireError(err) })
		}
	}

	const dispatch = (request: Request, connection: Connection) => {
		const running = run(request, connection)
		inFlight.add(running)
		void running.finally(() => inFlight.delete(running))
		return running
	}

	const onConnection = (socket: net.Socket) => {
		if (state !== 'listening') {
			socket.destroy()
			return
		}
		const connection = new Connection(socket, {
			secretDigest,
			onHello: () => ({
				server: SERVER_INFO,
				app: { name: app.name, version: app.version },
			}),
			dispatch,
			onClose: (c) => {
				connections.delete(c)
				subscriptions.removeAll(c)
			},
		})
		connections.add(connection)
	}

	const assertOpen = () => {
		if (state === 'closed') throw new ServerClosed()
	}

	function listen(): Promise<ListenResult> {
		if (state === 'closed') return Promise.reject(new ServerClosed())
		if (state !== 'idle') return Promise.reject(new ServerAlreadyStarted())
		state = 'listening'
		starting = start()
		return starting
	}

	async function start(): Promise<ListenResult> {
		try {
			if (options.socketPath) {
				assertSocketPathLength(options.socketPath)
				location = { socketPath: options.socketPath, ownedDir: null }
			} else {
				location = await createSocketLocation()
			}
			assertOpen()
			const { socketPath } = location
			const srv = net.createServer(onConnection)
			server = srv
			await new Promise<void>((resolve, reject) => {
				srv.once('error', reject)
				srv.listen(socketPath, () => {
					srv.off('error', reject)
					resolve()
				})
			})
			// Accept errors must not become uncaught exceptions in the host process
			srv.on('error', () => {})
			assertOpen()
			if (!isWindowsPipe(socketPath)) await fs.chmod(socketPath, 0o600)
			assertOpen()
			discoveryFilePath = await writeDiscoveryFile(discoveryDir, {
				discoveryVersion: 1,
				socketPath,
				secret,
				protocolVersions: [...PROTOCOL_VERSIONS],
				pid: process.pid,
				app: { name: app.name, version: app.version },
			})
			assertOpen()
			return { socketPath, discoveryFilePath }
		} catch (err) {
			state = 'closed'
			await release()
			throw err
		}
	}

	// Safe to run more than once, including while listen() is still running.
	async function release() {
		try {
			for (const connection of [...connections]) connection.destroy()
			data.abort()
			// A running handler can hold a media server connection open, delaying the host's close
			await Promise.all(inFlight)
			subscriptions.close()
			data.clearCache()
		} finally {
			try {
				if (discoveryFilePath) {
					await removeDiscoveryFile(discoveryFilePath, secret)
				}
			} finally {
				const srv = server
				if (srv?.listening) {
					await new Promise<void>((resolve) => srv.close(() => resolve()))
				}
				if (location?.ownedDir) {
					await fs.rm(location.ownedDir, { recursive: true, force: true })
				}
			}
		}
	}

	function close(): Promise<void> {
		state = 'closed'
		closing ??= (async () => {
			await starting?.catch(() => {})
			await release()
		})()
		return closing
	}

	return { listen, close }
}
