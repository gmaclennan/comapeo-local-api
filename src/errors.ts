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
])
