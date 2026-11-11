import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { SocketPathTooLong } from './errors.ts'

export const DISCOVERY_FILE_NAME = 'comapeo-local-api.json'

// macOS allows 103 bytes in sun_path, Linux 107; stay under both with margin.
const MAX_SOCKET_PATH_BYTES = 100

export interface DiscoveryFile {
	discoveryVersion: 1
	socketPath: string
	secret: string
	protocolVersions: number[]
	pid: number
	app: { name: string; version: string }
}

export interface SocketLocation {
	socketPath: string
	/** Directory created for the socket, removed on close */
	ownedDir: string | null
}

export function isWindowsPipe(socketPath: string): boolean {
	return /^\\\\[.?]\\pipe\\/i.test(socketPath)
}

export function assertSocketPathLength(socketPath: string): void {
	if (isWindowsPipe(socketPath)) return
	const length = Buffer.byteLength(socketPath)
	if (length >= MAX_SOCKET_PATH_BYTES) {
		throw new SocketPathTooLong({
			socketPath,
			length: String(length),
			limit: String(MAX_SOCKET_PATH_BYTES - 1),
		})
	}
}

export async function createSocketLocation(
	platform: NodeJS.Platform = process.platform,
): Promise<SocketLocation> {
	if (platform === 'win32') {
		return {
			socketPath: `\\\\.\\pipe\\comapeo-local-api-${randomBytes(16).toString('hex')}`,
			ownedDir: null,
		}
	}
	let base = os.tmpdir()
	// 'comapeo-XXXXXX/api.sock' adds 23 bytes
	if (Buffer.byteLength(base) + 24 >= MAX_SOCKET_PATH_BYTES) base = '/tmp'
	const dir = await fs.mkdtemp(path.join(base, 'comapeo-'))
	await fs.chmod(dir, 0o700)
	const socketPath = path.join(dir, 'api.sock')
	assertSocketPathLength(socketPath)
	return { socketPath, ownedDir: dir }
}

export function generateSecret(): string {
	return randomBytes(32).toString('base64url')
}

/** Written to a temporary file with mode 0600, then renamed into place. */
export async function writeDiscoveryFile(
	discoveryDir: string,
	content: DiscoveryFile,
): Promise<string> {
	await fs.mkdir(discoveryDir, { recursive: true, mode: 0o700 })
	const filePath = path.join(discoveryDir, DISCOVERY_FILE_NAME)
	const tmpPath = path.join(
		discoveryDir,
		`.${DISCOVERY_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`,
	)
	const handle = await fs.open(tmpPath, 'wx', 0o600)
	try {
		await handle.writeFile(JSON.stringify(content, null, 2) + '\n', 'utf8')
		await handle.sync()
	} finally {
		await handle.close()
	}
	try {
		await fs.rename(tmpPath, filePath)
	} catch (err) {
		await fs.rm(tmpPath, { force: true })
		throw err
	}
	return filePath
}

/** Removes the discovery file only if it still holds this server's secret. */
export async function removeDiscoveryFile(
	filePath: string,
	secret: string,
): Promise<void> {
	let current: unknown
	try {
		current = JSON.parse(await fs.readFile(filePath, 'utf8'))
	} catch {
		return
	}
	if (
		typeof current === 'object' &&
		current !== null &&
		'secret' in current &&
		current.secret === secret
	) {
		await fs.rm(filePath, { force: true })
	}
}
