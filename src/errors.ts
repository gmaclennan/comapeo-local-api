import {
	createErrorClass,
	createErrorClassesByName,
} from 'custom-error-creator'

/** Errors returned to clients in a response's `error` member. */
export const {
	UnsupportedProtocolVersion,
	MethodNotFound,
	InvalidParams,
	ProjectNotFound,
	LayerNotFound,
	InvalidCursor,
	InternalError,
} = createErrorClassesByName([
	{
		code: 'UNSUPPORTED_PROTOCOL_VERSION',
		message: 'No shared protocol version: server supports {supported}',
	},
	{ code: 'METHOD_NOT_FOUND', message: 'Unknown method {method}' },
	{ code: 'INVALID_PARAMS', message: 'Invalid params: {reason}' },
	{ code: 'PROJECT_NOT_FOUND', message: 'Project {projectId} not found' },
	{ code: 'LAYER_NOT_FOUND', message: 'Layer {layerId} not found' },
	{
		code: 'INVALID_CURSOR',
		message: 'Cursor is not valid for this layer; start again without one',
	},
	{ code: 'INTERNAL_ERROR', message: 'Internal error' },
])

const Editing = createErrorClassesByName([
	{ code: 'EDITING_DISABLED', message: 'Editing is not allowed by the host' },
	{ code: 'NOT_EDITABLE', message: 'This cannot be edited' },
	{ code: 'FEATURE_NOT_FOUND', message: 'Feature not found' },
	{
		code: 'NOT_PERMITTED',
		message: "This device's role does not allow this edit",
	},
	{
		code: 'CONFLICT',
		message: 'The feature has changed since it was fetched',
	},
	{ code: 'INVALID_VALUE', message: 'A value cannot be stored' },
])

export const { EditingDisabled } = Editing

export interface NotEditableData {
	target: 'layer' | 'column' | 'category' | 'geometry' | 'delete'
	column?: string
	reason?: 'no-location' | 'not-in-category'
}

export class NotEditable extends Editing.NotEditable {
	readonly data: NotEditableData
	constructor(data: NotEditableData) {
		super()
		this.data = data
	}
}

export class FeatureNotFound extends Editing.FeatureNotFound {
	readonly data: { deleted: boolean }
	constructor(data: { deleted: boolean }) {
		super()
		this.data = data
	}
}

export class NotPermitted extends Editing.NotPermitted {
	readonly data: { reason: 'not-own' | 'role' }
	constructor(data: { reason: 'not-own' | 'role' }) {
		super()
		this.data = data
	}
}

export class Conflict extends Editing.Conflict {
	readonly data: { feature: object }
	constructor(data: { feature: object }) {
		super()
		this.data = data
	}
}

export interface InvalidValueData {
	target: 'column' | 'category' | 'geometry'
	column?: string
	reason: string
	detail?: string
}

export class InvalidValue extends Editing.InvalidValue {
	readonly data: InvalidValueData
	constructor(data: InvalidValueData) {
		super(
			`A value cannot be stored: ${data.reason}${data.column ? ` (${data.column})` : ''}${data.detail ? `: ${data.detail}` : ''}`,
		)
		this.data = data
	}
}

/** Errors thrown by the server API to its host. */
export const { ServerAlreadyStarted, ServerClosed, SocketPathTooLong } =
	createErrorClassesByName([
		{
			code: 'SERVER_ALREADY_STARTED',
			message: 'listen() has already been called',
		},
		{ code: 'SERVER_CLOSED', message: 'The server has been closed' },
		{
			code: 'SOCKET_PATH_TOO_LONG',
			message:
				'Socket path {socketPath} is {length} bytes; the limit is {limit}',
		},
	])

/** Internal: an incoming frame's header announces more than the limit. */
export const FrameTooLarge = createErrorClass({
	code: 'FRAME_TOO_LARGE',
	message: 'Frame of {length} bytes exceeds the {limit} byte limit',
})

export const PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set([
	UnsupportedProtocolVersion.code,
	MethodNotFound.code,
	InvalidParams.code,
	ProjectNotFound.code,
	LayerNotFound.code,
	InvalidCursor.code,
	InternalError.code,
	EditingDisabled.code,
	NotEditable.code,
	FeatureNotFound.code,
	NotPermitted.code,
	Conflict.code,
	InvalidValue.code,
])
