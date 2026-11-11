import { readFileSync } from 'node:fs'

// Resolves from both src/ and dist/, which sit at the same depth.
const pkg = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

export const SERVER_INFO = { name: pkg.name, version: pkg.version }
