// Jotai atoms for ManagedIndexer state management

import { atom } from "jotai"
import { ConfigState, WorkspaceFolderState, ManifestCacheEntry, FileUpsertTask, ManagedIndexerError } from "./types"
import { fetchOrganization, isIndexingEnabled } from "../operations/config"

// Configuration atoms
export const configTokenAtom = atom<string | null>(null)
export const configOrganizationIdAtom = atom<string | null>(null)
export const configTesterWarningsDisabledUntilAtom = atom<number | null>(null)

// Derived config atom
export const configAtom = atom<ConfigState>((get) => ({
	token: get(configTokenAtom),
	organizationId: get(configOrganizationIdAtom),
	testerWarningsDisabledUntil: get(configTesterWarningsDisabledUntilAtom),
}))

// Organization atom (async)
export const organizationAtom = atom(async (get) => {
	const config = get(configAtom)
	if (!config.token || !config.organizationId) {
		return null
	}
	return fetchOrganization(config)
})

// Indexing enabled atom (derived, async)
export const isIndexingEnabledAtom = atom(async (get) => {
	const org = await get(organizationAtom)
	return isIndexingEnabled(org)
})

// Workspace folders state
export const workspaceFoldersAtom = atom<Map<string, WorkspaceFolderState>>(new Map())

// Manifest cache
export const manifestCacheAtom = atom<Map<string, ManifestCacheEntry>>(new Map())

// File upsert queue
export const fileUpsertQueueAtom = atom<FileUpsertTask[]>([])

// Errors
export const errorsAtom = atom<ManagedIndexerError[]>([])

// Active state
export const isActiveAtom = atom(false)

// Selectors (derived atoms)
export const activeWorkspaceFoldersAtom = atom((get) => {
	const folders = get(workspaceFoldersAtom)
	return Array.from(folders.values()).filter((f) => f.watcher !== null)
})

export const indexingWorkspacesAtom = atom((get) => {
	const folders = get(workspaceFoldersAtom)
	return Array.from(folders.values()).filter((f) => f.isIndexing)
})

export const totalErrorCountAtom = atom((get) => {
	const errors = get(errorsAtom)
	const folders = get(workspaceFoldersAtom)
	const folderErrors = Array.from(folders.values()).filter((f) => f.lastError).length
	return errors.length + folderErrors
})

// Helper atom for getting workspace folder by path
export const getWorkspaceFolderByPathAtom = atom(null, (get, set, path: string) => {
	const folders = get(workspaceFoldersAtom)
	return folders.get(path)
})

// Helper atom for updating a specific workspace folder
export const updateWorkspaceFolderAtom = atom(
	null,
	(get, set, { path, updates }: { path: string; updates: Partial<WorkspaceFolderState> }) => {
		const folders = get(workspaceFoldersAtom)
		const existing = folders.get(path)
		if (existing) {
			const newFolders = new Map(folders)
			newFolders.set(path, { ...existing, ...updates })
			set(workspaceFoldersAtom, newFolders)
		}
	},
)

// Helper atom for adding an error
export const addErrorAtom = atom(null, (get, set, error: ManagedIndexerError) => {
	const errors = get(errorsAtom)
	set(errorsAtom, [...errors, error])
})

// Helper atom for clearing errors
export const clearErrorsAtom = atom(null, (get, set) => {
	set(errorsAtom, [])
})

// Helper atom for processing file upsert queue
export const dequeueFileUpsertAtom = atom(null, (get, set) => {
	const queue = get(fileUpsertQueueAtom)
	if (queue.length === 0) return null

	const [task, ...remaining] = queue
	set(fileUpsertQueueAtom, remaining)
	return task
})

// Helper atom for adding to file upsert queue
export const enqueueFileUpsertAtom = atom(null, (get, set, task: FileUpsertTask) => {
	const queue = get(fileUpsertQueueAtom)
	set(fileUpsertQueueAtom, [...queue, task])
})
