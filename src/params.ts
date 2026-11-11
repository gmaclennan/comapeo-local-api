import { InvalidParams } from './errors.ts'
import { MAX_LIMIT } from './project-data.ts'

export type Params = Record<string, unknown>

export function requireString(params: Params, key: string): string {
	const value = params[key]
	if (typeof value !== 'string' || value === '') {
		throw new InvalidParams({ reason: `${key} must be a non-empty string` })
	}
	return value
}

export function optionalString(
	params: Params,
	key: string,
): string | undefined {
	const value = params[key]
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') {
		throw new InvalidParams({ reason: `${key} must be a string` })
	}
	return value
}

export function optionalLimit(params: Params): number | undefined {
	const value = params.limit
	if (value === undefined || value === null) return undefined
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > MAX_LIMIT
	) {
		throw new InvalidParams({
			reason: `limit must be an integer from 1 to ${MAX_LIMIT}`,
		})
	}
	return value
}

export function optionalIds(params: Params): string[] | undefined {
	const value = params.ids
	if (value === undefined || value === null) return undefined
	if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
		throw new InvalidParams({ reason: 'ids must be an array of strings' })
	}
	return value
}

const MAX_LANG_LENGTH = 35

/**
 * `lang` with the `pt_BR` locale spelling accepted as `pt-BR`. Empty or
 * over-long values are treated as absent, so the project default applies.
 */
export function optionalLang(params: Params): string | undefined {
	const value = optionalString(params, 'lang')
	if (value === undefined) return undefined
	const tag = value.trim().replaceAll('_', '-')
	return tag === '' || tag.length > MAX_LANG_LENGTH ? undefined : tag
}
