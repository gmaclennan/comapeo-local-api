import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'

export interface WireError {
	code: string
	message: string
	data?: unknown
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire data is checked by assertions
export type Wire = any

export class RpcError extends Error {
	readonly code: string
	readonly data: unknown
	constructor(error: WireError) {
		super(error.message)
		this.code = error.code
		this.data = error.data
	}
}

export interface Notification {
	method: string
	params: Record<string, unknown>
}

export function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message))
	const header = Buffer.alloc(4)
	header.writeUInt32LE(body.length)
	return Buffer.concat([header, body])
}

/** A minimal protocol client that speaks only through the socket. */
export class TestClient {
	readonly socket: net.Socket
	readonly received: Buffer[] = []
	readonly notifications: Notification[] = []
	readonly closed: Promise<void>
	#buffer = Buffer.alloc(0)
	#nextId = 1
	#pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: unknown) => void }
	>()
	#notificationWaiters: Array<() => void> = []

	private constructor(socket: net.Socket) {
		this.socket = socket
		this.closed = new Promise((resolve) =>
			socket.once('close', () => resolve()),
		)
		socket.on('error', () => {})
		socket.on('data', (chunk: Buffer) => {
			this.received.push(chunk)
			this.#buffer = Buffer.concat([this.#buffer, chunk])
			while (this.#buffer.length >= 4) {
				const length = this.#buffer.readUInt32LE(0)
				if (this.#buffer.length < 4 + length) break
				const message = JSON.parse(
					this.#buffer.subarray(4, 4 + length).toString(),
				)
				this.#buffer = this.#buffer.subarray(4 + length)
				this.#onMessage(message)
			}
		})
		this.closed.then(() => {
			for (const { reject } of this.#pending.values()) {
				reject(new Error('Connection closed'))
			}
			this.#pending.clear()
		})
	}

	static async connect(socketPath: string): Promise<TestClient> {
		const socket = net.connect(socketPath)
		await once(socket, 'connect')
		return new TestClient(socket)
	}

	/** Connects using the discovery file and completes the handshake. */
	static async fromDiscoveryFile(filePath: string): Promise<TestClient> {
		const discovery = JSON.parse(await fs.readFile(filePath, 'utf8'))
		const client = await TestClient.connect(discovery.socketPath)
		await client.hello(discovery.secret)
		return client
	}

	get bytesReceived(): number {
		return this.received.reduce((n, b) => n + b.length, 0)
	}

	hello(secret: string, protocolVersions: unknown[] = [1]) {
		return this.request('hello', {
			secret,
			protocolVersions,
			client: { name: 'test-client', version: '0.0.0' },
		})
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- results are checked by assertions
	request<T = any>(method: string, params?: object): Promise<T> {
		if (this.socket.destroyed) {
			return Promise.reject(new Error('Connection closed'))
		}
		const id = this.#nextId++
		const message =
			params === undefined ? { id, method } : { id, method, params }
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
			})
			this.socket.write(frame(message))
		})
	}

	writeRaw(data: Buffer) {
		this.socket.write(data)
	}

	/** Resolves when a notification matching `predicate` has arrived. */
	async waitForNotification(
		predicate: (n: Notification) => boolean,
		timeoutMs = 3000,
	): Promise<Notification> {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const found = this.notifications.find(predicate)
			if (found) return found
			const remaining = deadline - Date.now()
			if (remaining <= 0) throw new Error('Timed out waiting for notification')
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining)
				this.#notificationWaiters.push(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		}
	}

	close() {
		this.socket.destroy()
		return this.closed
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire data
	#onMessage(message: any) {
		if (typeof message.id === 'number') {
			const pending = this.#pending.get(message.id)
			if (!pending) return
			this.#pending.delete(message.id)
			if (message.error) pending.reject(new RpcError(message.error))
			else pending.resolve(message.result)
			return
		}
		this.notifications.push(message)
		const waiters = this.#notificationWaiters.splice(0)
		for (const w of waiters) w()
	}
}
