import { FrameTooLarge } from './errors.ts'

export const PRE_AUTH_MAX_FRAME = 4 * 1024
export const MAX_FRAME = 16 * 1024 * 1024

const HEADER_BYTES = 4

/** Throws FrameTooLarge if the encoded message is over `maxFrame`. */
export function encodeFrame(message: unknown, maxFrame = MAX_FRAME): Buffer {
	const body = Buffer.from(JSON.stringify(message), 'utf8')
	if (body.length > maxFrame) {
		throw new FrameTooLarge({
			length: String(body.length),
			limit: String(maxFrame),
		})
	}
	const header = Buffer.alloc(HEADER_BYTES)
	header.writeUInt32LE(body.length, 0)
	return Buffer.concat([header, body])
}

/**
 * Incremental decoder for length-prefixed frames, read one frame at a time so
 * that the limit can change between frames. The limit is checked against the
 * header alone, so an over-length frame is rejected before its payload is
 * buffered, and chunks are joined only once a whole frame has arrived.
 */
export class FrameDecoder {
	#chunks: Buffer[] = []
	#buffered = 0
	maxFrame: number

	constructor(maxFrame: number) {
		this.maxFrame = maxFrame
	}

	push(chunk: Buffer) {
		if (chunk.length === 0) return
		this.#chunks.push(chunk)
		this.#buffered += chunk.length
	}

	/** Returns the next complete frame payload, if any; throws FrameTooLarge. */
	next(): Buffer | undefined {
		if (this.#buffered < HEADER_BYTES) return undefined
		let first = this.#chunks[0] as Buffer
		if (first.length < HEADER_BYTES) first = this.#flatten()
		const length = first.readUInt32LE(0)
		if (length > this.maxFrame) {
			throw new FrameTooLarge({
				length: String(length),
				limit: String(this.maxFrame),
			})
		}
		const end = HEADER_BYTES + length
		if (this.#buffered < end) return undefined
		const buf = first.length >= end ? first : this.#flatten()
		const frame = buf.subarray(HEADER_BYTES, end)
		this.#chunks.shift()
		const rest = buf.subarray(end)
		if (rest.length) this.#chunks.unshift(rest)
		this.#buffered -= end
		return frame
	}

	#flatten(): Buffer {
		const joined = Buffer.concat(this.#chunks)
		this.#chunks = [joined]
		return joined
	}
}
