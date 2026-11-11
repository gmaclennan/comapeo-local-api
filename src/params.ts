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

export function optionalForks(params: Params): string[] {
	const value = params.forks
	if (value === undefined || value === null) return []
	if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
		throw new InvalidParams({ reason: 'forks must be an array of strings' })
	}
	return value
}

export function optionalProperties(
	params: Params,
): Record<string, unknown> | undefined {
	const value = params.properties
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidParams({ reason: 'properties must be an object' })
	}
	return value as Record<string, unknown>
}

export function optionalCategoryId(params: Params): string | undefined {
	if (!Object.hasOwn(params, 'categoryId')) return undefined
	return requireString(params, 'categoryId')
}

export interface PointGeometry {
	type: 'Point'
	coordinates: [number, number]
}

export function optionalPoint(params: Params): PointGeometry | undefined {
	if (!Object.hasOwn(params, 'geometry')) return undefined
	const value = params.geometry
	const coordinates =
		typeof value === 'object' && value !== null && 'coordinates' in value
			? value.coordinates
			: undefined
	if (
		typeof value !== 'object' ||
		value === null ||
		!('type' in value) ||
		value.type !== 'Point' ||
		!Array.isArray(coordinates) ||
		(coordinates.length !== 2 && coordinates.length !== 3) ||
		!coordinates.every((c) => typeof c === 'number' && Number.isFinite(c))
	) {
		throw new InvalidParams({ reason: 'geometry must be a GeoJSON Point' })
	}
	return { type: 'Point', coordinates: [coordinates[0], coordinates[1]] }
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
