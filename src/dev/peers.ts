import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

import { roles, type MapeoManager, type MapeoProject } from '@comapeo/core'

/** Polls `check` until it returns something truthy. */
export async function until<T>(
	check: () => Promise<T | undefined | null | false>,
	label: string,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const result = await check()
		if (result) return result
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
		await delay(20)
	}
}

async function waitForPeer(manager: MapeoManager, deviceId: string) {
	const connected = async () =>
		(await manager.listLocalPeers()).some(
			(p) => p.deviceId === deviceId && p.status === 'connected',
		)
	while (!(await connected())) await once(manager, 'local-peers')
}

/** Connects two managers over 127.0.0.1; the result disconnects them. */
export async function connectPeers(
	a: MapeoManager,
	b: MapeoManager,
): Promise<() => Promise<void>> {
	const [, bServer] = (await Promise.all(
		[a, b].map((m) => m.startLocalPeerDiscoveryServer()),
	)) as [{ name: string; port: number }, { name: string; port: number }]
	// Dialling both ways makes two connections, and core's closing one of them can abort an invite
	a.connectLocalPeer({ address: '127.0.0.1', ...bServer })
	await Promise.all([waitForPeer(a, b.deviceId), waitForPeer(b, a.deviceId)])
	return async () => {
		await Promise.all(
			[a, b].map((m) => m.stopLocalPeerDiscoveryServer({ force: true })),
		)
	}
}

/**
 * `remote` invites `local` to its project as a member and both start
 * syncing. Resolves when `local` lists the project as joined, which core does
 * only once the project settings have synced.
 */
export async function joinAsMember(
	remoteProject: MapeoProject,
	local: MapeoManager,
	projectId: string,
): Promise<MapeoProject> {
	await Promise.all([
		remoteProject.$member.invite(local.deviceId, {
			roleId: roles.MEMBER_ROLE_ID,
		}),
		(async () => {
			const [invite] = await once(local.invite, 'invite-received')
			await local.invite.accept(invite)
		})(),
	])
	const localProject = await local.getProject(projectId)
	remoteProject.$sync.start()
	localProject.$sync.start()
	await until(
		async () =>
			(await local.listProjects()).some(
				(p) => p.projectId === projectId && p.status === 'joined',
			),
		'project joined',
	)
	return localProject
}
