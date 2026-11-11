import { createHash } from 'node:crypto'

import type { Field, Preset } from '@comapeo/core/schema.js'

export type ColumnType =
	| 'string'
	| 'number'
	| 'integer'
	| 'boolean'
	| 'datetime'
	| 'string_list'
	| 'json'

type ColumnRole = 'builtin' | 'field' | 'tags'

type OptionValue = string | number | boolean | null

export interface Column {
	name: string
	type: ColumnType
	label: string
	role: ColumnRole
	options?: Array<{ value: OptionValue; label: string }>
	/** Not sent to clients: the tag key a field column reads */
	tagKey?: string
	/** Not sent to clients: the built-in value this column holds */
	builtin?: string
}

interface BuiltinSpec {
	key: string
	type: ColumnType
	label: string
}

const COMMON_BUILTINS: BuiltinSpec[] = [
	{ key: 'id', type: 'string', label: 'ID' },
	{ key: 'category', type: 'string', label: 'Category' },
	{ key: 'created_at', type: 'datetime', label: 'Created' },
	{ key: 'updated_at', type: 'datetime', label: 'Updated' },
	{ key: 'created_by', type: 'string', label: 'Created by' },
	{ key: 'updated_by', type: 'string', label: 'Updated by' },
]

export const OBSERVATION_BUILTINS: BuiltinSpec[] = [
	...COMMON_BUILTINS,
	{ key: 'accuracy', type: 'number', label: 'GPS accuracy (m)' },
	{ key: 'altitude', type: 'number', label: 'Altitude (m)' },
	{ key: 'photo_count', type: 'integer', label: 'Photos' },
	{ key: 'audio_count', type: 'integer', label: 'Audio recordings' },
]

export const TRACK_BUILTINS: BuiltinSpec[] = [
	...COMMON_BUILTINS,
	{ key: 'start_time', type: 'datetime', label: 'Start time' },
	{ key: 'end_time', type: 'datetime', label: 'End time' },
]

const TAGS_KEY = 'tags'

// Words the QGIS expression parser will not read as a column name (checked
// with QgsExpression in QGIS 4.2)
const QGIS_EXPRESSION_KEYWORDS = new Set([
	'and',
	'between',
	'case',
	'else',
	'end',
	'false',
	'ilike',
	'in',
	'is',
	'like',
	'not',
	'null',
	'or',
	'then',
	'true',
	'when',
])

function keyHash(tagKey: string, length: number): string {
	return createHash('sha256')
		.update(tagKey, 'utf8')
		.digest('hex')
		.slice(0, length)
}

const MAX_NAME_LENGTH = 63

function withKeyHash(name: string, tagKey: string): string {
	const suffix = `_${keyHash(tagKey, 6)}`
	return name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix
}

function sanitiseColumnName(tagKey: string): string {
	let name = tagKey
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
	// Keys in other scripts keep nothing readable, so name them by the key itself
	if (!/[a-z0-9]/.test(name)) return `field_${keyHash(tagKey, 8)}`
	if (/^[0-9]/.test(name)) name = '_' + name
	if (QGIS_EXPRESSION_KEYWORDS.has(name)) name += '_'
	return name.length > MAX_NAME_LENGTH ? withKeyHash(name, tagKey) : name
}

/**
 * Names that do not depend on field order: when tag keys sanitise to the same
 * name, only a key already equal to that name keeps it; the others always get
 * a suffix derived from the key.
 */
function fieldColumnNames(tagKeys: string[]): Map<string, string> {
	const groups = new Map<string, string[]>()
	for (const tagKey of tagKeys) {
		const base = sanitiseColumnName(tagKey)
		const group = groups.get(base)
		if (group) group.push(tagKey)
		else groups.set(base, [tagKey])
	}
	const names = new Map<string, string>()
	const used = new Set<string>()
	const suffixed: Array<[string, string]> = []
	for (const [base, group] of groups) {
		for (const tagKey of group) {
			if (group.length === 1 || tagKey === base) {
				names.set(tagKey, base)
				used.add(base)
			} else {
				suffixed.push([tagKey, base])
			}
		}
	}
	suffixed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	for (const [tagKey, base] of suffixed) {
		const hashed = withKeyHash(base, tagKey)
		let name = hashed
		for (let i = 2; used.has(name); i++) name = `${hashed}_${i}`
		used.add(name)
		names.set(tagKey, name)
	}
	return names
}

function fieldColumnType(field: Field): ColumnType {
	switch (field.type) {
		case 'number':
			return 'number'
		case 'date':
			return 'datetime'
		case 'selectMultiple':
			return 'string_list'
		case 'selectOne': {
			const values = (field.options ?? [])
				.map((o) => o.value)
				.filter((v) => v !== null)
			if (values.length > 0 && values.every((v) => typeof v === 'number')) {
				return 'number'
			}
			if (values.length > 0 && values.every((v) => typeof v === 'boolean')) {
				return 'boolean'
			}
			return 'string'
		}
		default:
			return 'string'
	}
}

/**
 * Builds a layer's columns: built-ins, one column per field used by the
 * layer's categories (in category then field order), then the tags column.
 */
export function buildColumns({
	builtins,
	presets,
	fields,
	geometry,
}: {
	builtins: BuiltinSpec[]
	presets: Preset[]
	fields: Array<Field & { docId: string }>
	geometry: 'point' | 'line'
}): Column[] {
	const fieldsById = new Map(fields.map((f) => [f.docId, f]))
	const orderedFields: Array<Field & { docId: string }> = []
	const seenFieldIds = new Set<string>()
	const addField = (field: (Field & { docId: string }) | undefined) => {
		if (!field || seenFieldIds.has(field.docId)) return
		seenFieldIds.add(field.docId)
		orderedFields.push(field)
	}
	for (const preset of presets) {
		if (!preset.geometry.includes(geometry)) continue
		for (const ref of preset.fieldRefs) addField(fieldsById.get(ref.docId))
	}
	for (const field of fields) if (field.universal) addField(field)

	const fieldsByTagKey = new Map<string, Field & { docId: string }>()
	for (const field of orderedFields) {
		if (!fieldsByTagKey.has(field.tagKey)) {
			fieldsByTagKey.set(field.tagKey, field)
		}
	}
	const names = fieldColumnNames([...fieldsByTagKey.keys()])
	const usedFieldNames = new Set(names.values())
	const fieldColumns: Column[] = []
	for (const field of fieldsByTagKey.values()) {
		const name = names.get(field.tagKey) as string
		const type = fieldColumnType(field)
		const column: Column = {
			name,
			type,
			label: field.label || field.tagKey,
			role: 'field',
			tagKey: field.tagKey,
		}
		if (field.options && field.options.length > 0) {
			column.options = field.options.map((o) => ({
				value:
					type === 'string' || type === 'string_list'
						? o.value === null
							? null
							: String(o.value)
						: o.value,
				label: o.label,
			}))
		}
		fieldColumns.push(column)
	}

	const builtinName = (key: string) => {
		let name = key
		while (usedFieldNames.has(name)) name = `comapeo_${name}`
		return name
	}
	const builtinColumns: Column[] = builtins.map((b) => ({
		name: builtinName(b.key),
		type: b.type,
		label: b.label,
		role: 'builtin',
		builtin: b.key,
	}))
	const tagsColumn: Column = {
		name: builtinName(TAGS_KEY),
		type: 'json',
		label: 'All tags',
		role: 'tags',
	}
	return [...builtinColumns, ...fieldColumns, tagsColumn]
}

export function publicColumn(column: Column) {
	const { name, type, label, role, options } = column
	return options
		? { name, type, label, role, options }
		: { name, type, label, role }
}

export function schemaVersion(columns: Column[]): string {
	return createHash('sha256')
		.update(JSON.stringify(columns.map(publicColumn)))
		.digest('base64url')
		.slice(0, 16)
}

type TagValue =
	string | number | boolean | null | Array<string | number | boolean | null>

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const ISO_8601 =
	/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** Converts a tag value to the column's type, or null if it cannot be. */
export function coerceValue(value: unknown, type: ColumnType): unknown {
	if (value === undefined || value === null) return null
	switch (type) {
		case 'string':
			if (Array.isArray(value)) {
				const parts = value.filter((v) => v !== null).map(String)
				return parts.length ? parts.join(', ') : null
			}
			return typeof value === 'object' ? JSON.stringify(value) : String(value)
		case 'number': {
			const n =
				typeof value === 'string' && DECIMAL.test(value.trim())
					? Number(value)
					: value
			return typeof n === 'number' && Number.isFinite(n) ? n : null
		}
		case 'integer': {
			const n = coerceValue(value, 'number')
			return typeof n === 'number' && Number.isInteger(n) ? n : null
		}
		case 'boolean':
			if (typeof value === 'boolean') return value
			if (value === 'true' || value === 'yes') return true
			if (value === 'false' || value === 'no') return false
			return null
		case 'datetime':
			return typeof value === 'string' &&
				ISO_8601.test(value) &&
				!Number.isNaN(Date.parse(value))
				? value
				: null
		case 'string_list': {
			const list = (Array.isArray(value) ? value : [value]) as TagValue[]
			return list.filter((v) => v !== null).map(String)
		}
		case 'json':
			return value
		default:
			return null
	}
}
