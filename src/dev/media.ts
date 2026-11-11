import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import jpeg from 'jpeg-js'

/** A gradient with a disc whose colour and position vary with `seed`. */
function makeJpeg(width: number, height: number, seed: number): Buffer {
	const data = Buffer.alloc(width * height * 4)
	const hue = (seed * 47) % 360
	const [r1, g1, b1] = hsl(hue, 0.55, 0.35)
	const [r2, g2, b2] = hsl((hue + 60) % 360, 0.6, 0.7)
	const [dr, dg, db] = hsl((hue + 180) % 360, 0.7, 0.5)
	const cx = width * (0.3 + ((seed * 13) % 40) / 100)
	const cy = height * (0.3 + ((seed * 29) % 40) / 100)
	const radius = Math.min(width, height) * 0.2
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const t = y / height
			const inDisc = (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2
			data[i] = inDisc ? dr : r1 + (r2 - r1) * t
			data[i + 1] = inDisc ? dg : g1 + (g2 - g1) * t
			data[i + 2] = inDisc ? db : b1 + (b2 - b1) * t
			data[i + 3] = 255
		}
	}
	return jpeg.encode({ width, height, data }, 80).data
}

function hsl(h: number, s: number, l: number): [number, number, number] {
	const a = s * Math.min(l, 1 - l)
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
	}
	return [f(0), f(8), f(4)]
}

/** A mono 16-bit PCM WAV file with a sine tone. */
function makeWav(seconds: number, frequency: number): Buffer {
	const sampleRate = 8000
	const samples = Math.round(seconds * sampleRate)
	const buf = Buffer.alloc(44 + samples * 2)
	buf.write('RIFF', 0)
	buf.writeUInt32LE(36 + samples * 2, 4)
	buf.write('WAVE', 8)
	buf.write('fmt ', 12)
	buf.writeUInt32LE(16, 16)
	buf.writeUInt16LE(1, 20)
	buf.writeUInt16LE(1, 22)
	buf.writeUInt32LE(sampleRate, 24)
	buf.writeUInt32LE(sampleRate * 2, 28)
	buf.writeUInt16LE(2, 32)
	buf.writeUInt16LE(16, 34)
	buf.write('data', 36)
	buf.writeUInt32LE(samples * 2, 40)
	for (let i = 0; i < samples; i++) {
		const fade = Math.min(1, i / 400, (samples - i) / 400)
		const v = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.4 * fade
		buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
	}
	return buf
}

export interface PhotoFiles {
	original: string
	preview: string
	thumbnail: string
}

export async function writePhotoFiles(
	dir: string,
	seed: number,
): Promise<PhotoFiles> {
	const files = {
		original: path.join(dir, `photo-${seed}-original.jpg`),
		preview: path.join(dir, `photo-${seed}-preview.jpg`),
		thumbnail: path.join(dir, `photo-${seed}-thumbnail.jpg`),
	}
	await Promise.all([
		fs.writeFile(files.original, makeJpeg(640, 480, seed)),
		fs.writeFile(files.preview, makeJpeg(320, 240, seed)),
		fs.writeFile(files.thumbnail, makeJpeg(160, 120, seed)),
	])
	return files
}

export async function writeAudioFile(
	dir: string,
	seed: number,
): Promise<string> {
	const file = path.join(dir, `audio-${seed}.wav`)
	await fs.writeFile(file, makeWav(2, 330 + (seed % 5) * 110))
	return file
}
