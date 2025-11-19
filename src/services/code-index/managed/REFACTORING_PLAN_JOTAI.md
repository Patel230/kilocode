# ManagedIndexer Refactoring with Jotai

## Why Jotai?

- **Atomic State Management**: Each piece of state is an independent atom
- **Derived State**: Computed atoms for derived values
- **No Providers**: Works without React context (perfect for VS Code extensions)
- **TypeScript First**: Excellent type inference
- **Composable**: Atoms can depend on other atoms
- **Async Support**: Built-in support for async atoms

## Architecture Overview

### 1. Atomic State Structure

```typescript
// state/atoms.ts - Define atomic pieces of state
import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

// Configuration atoms
export const configTokenAtom = atom<string | null>(null)
export const configOrganizationIdAtom = atom<string | null>(null)
export const configTesterWarningsDisabledUntilAtom = atom<number | null>(null)

// Derived config atom
export const configAtom = atom((get) => ({
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

// Indexing enabled atom (derived)
export const isIndexingEnabledAtom = atom((get) => {
	const org = get(organizationAtom)
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
```

### 2. Pure Operation Functions

```typescript
// operations/config.ts - Pure functions for config operations
import { Getter, Setter } from "jotai"

export async function loadConfiguration(contextProxy: ContextProxy, set: Setter): Promise<void> {
	const token = contextProxy.getSecret("kilocodeToken")
	const organizationId = contextProxy.getValue("kilocodeOrganizationId")
	const testerWarnings = contextProxy.getValue("kilocodeTesterWarningsDisabledUntil")

	set(configTokenAtom, token ?? null)
	set(configOrganizationIdAtom, organizationId ?? null)
	set(configTesterWarningsDisabledUntilAtom, testerWarnings ?? null)
}

export async function fetchOrganization(config: {
	token: string
	organizationId: string
	testerWarningsDisabledUntil: number | null
}): Promise<KiloOrganization | null> {
	return OrganizationService.fetchOrganization(
		config.token,
		config.organizationId,
		config.testerWarningsDisabledUntil ?? undefined,
	)
}

export function isIndexingEnabled(org: KiloOrganization | null): boolean {
	return OrganizationService.isCodeIndexingEnabled(org)
}
```

```typescript
// operations/workspace.ts - Pure workspace operations
export async function initializeWorkspaceFolder(
	folder: vscode.WorkspaceFolder,
	config: ConfigState,
): Promise<WorkspaceFolderState | null> {
	const cwd = folder.uri.fsPath

	if (!(await isGitRepository(cwd))) {
		return null
	}

	const [gitInfo, projectConfig] = await Promise.all([fetchGitInfo(cwd), getKilocodeConfig(cwd)])

	if (!projectConfig?.project?.id) {
		return null
	}

	return {
		folder,
		gitBranch: gitInfo.branch,
		projectId: projectConfig.project.id,
		repositoryUrl: gitInfo.repositoryUrl,
		isIndexing: false,
		watcher: null,
		lastError: null,
	}
}

export function updateWorkspaceFolder(
	folders: Map<string, WorkspaceFolderState>,
	folderId: string,
	updates: Partial<WorkspaceFolderState>,
): Map<string, WorkspaceFolderState> {
	const newFolders = new Map(folders)
	const existing = newFolders.get(folderId)
	if (existing) {
		newFolders.set(folderId, { ...existing, ...updates })
	}
	return newFolders
}
```

```typescript
// operations/manifest.ts - Pure manifest operations
export async function fetchManifest(params: {
	organizationId: string
	projectId: string
	branch: string
	token: string
}): Promise<ServerManifest> {
	return getServerManifest(params.organizationId, params.projectId, params.branch, params.token)
}

export function getCachedManifest(cache: Map<string, ManifestCacheEntry>, key: string): ServerManifest | null {
	const entry = cache.get(key)
	if (!entry) return null

	// Check if cache is still valid (e.g., 5 minutes)
	const isExpired = Date.now() - entry.fetchedAt > 5 * 60 * 1000
	return isExpired ? null : entry.manifest
}

export async function getOrFetchManifest(
	params: ManifestFetchParams,
	get: Getter,
	set: Setter,
): Promise<ServerManifest> {
	const cache = get(manifestCacheAtom)
	const key = `${params.projectId}:${params.branch}`

	// Check if we're already fetching
	const existing = cache.get(key)
	if (existing?.fetchPromise) {
		return existing.fetchPromise
	}

	// Check cache
	const cached = getCachedManifest(cache, key)
	if (cached) {
		return cached
	}

	// Fetch new manifest
	const promise = fetchManifest(params)

	// Store promise in cache
	const newCache = new Map(cache)
	newCache.set(key, {
		manifest: null as any,
		fetchedAt: Date.now(),
		fetchPromise: promise,
	})
	set(manifestCacheAtom, newCache)

	try {
		const manifest = await promise

		// Update cache with result
		const finalCache = new Map(get(manifestCacheAtom))
		finalCache.set(key, {
			manifest,
			fetchedAt: Date.now(),
			fetchPromise: null,
		})
		set(manifestCacheAtom, finalCache)

		return manifest
	} catch (error) {
		// Remove from cache on error
		const errorCache = new Map(get(manifestCacheAtom))
		errorCache.delete(key)
		set(manifestCacheAtom, errorCache)
		throw error
	}
}

export function isFileIndexed(manifest: ServerManifest, filePath: string, fileHash: string): boolean {
	return manifest.files.some((f) => f.filePath === filePath && f.fileHash === fileHash)
}
```

```typescript
// operations/git-events.ts - Pure git event processing
export async function processGitEvent(event: GitWatcherEvent, get: Getter, set: Setter): Promise<void> {
	const folders = get(workspaceFoldersAtom)
	const folder = findWorkspaceFolder(folders, event.watcher)

	if (!folder) {
		console.warn("[ManagedIndexer] Event from unknown watcher")
		return
	}

	switch (event.type) {
		case "scan-start":
			await handleScanStart(folder, event, get, set)
			break

		case "scan-end":
			await handleScanEnd(folder, event, get, set)
			break

		case "file-changed":
			await handleFileChanged(folder, event, get, set)
			break

		case "file-deleted":
			await handleFileDeleted(folder, event, get, set)
			break

		case "branch-changed":
			await handleBranchChanged(folder, event, get, set)
			break
	}
}

async function handleScanStart(
	folder: WorkspaceFolderState,
	event: GitWatcherEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	const folders = get(workspaceFoldersAtom)
	const updated = updateWorkspaceFolder(folders, folder.folder.uri.fsPath, { isIndexing: true, lastError: null })
	set(workspaceFoldersAtom, updated)
}

async function handleFileChanged(
	folder: WorkspaceFolderState,
	event: GitWatcherFileChangedEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	// Check file extension
	if (!shouldProcessFile(event.filePath)) {
		return
	}

	// Get manifest
	const config = get(configAtom)
	if (!config.token || !config.organizationId || !folder.projectId) {
		return
	}

	const manifest = await getOrFetchManifest(
		{
			organizationId: config.organizationId,
			projectId: folder.projectId,
			branch: event.branch,
			token: config.token,
		},
		get,
		set,
	)

	// Check if already indexed
	if (isFileIndexed(manifest, event.filePath, event.fileHash)) {
		return
	}

	// Queue file for upsert
	const queue = get(fileUpsertQueueAtom)
	set(fileUpsertQueueAtom, [
		...queue,
		{
			filePath: event.filePath,
			fileHash: event.fileHash,
			branch: event.branch,
			isBaseBranch: event.isBaseBranch,
			projectId: folder.projectId,
			workspacePath: folder.folder.uri.fsPath,
		},
	])
}
```

### 3. Simplified ManagedIndexer with Jotai

```typescript
// ManagedIndexer.ts - Thin orchestrator using Jotai
import { createStore, Provider } from "jotai"
import pLimit from "p-limit"

export class ManagedIndexer implements vscode.Disposable {
	private store = createStore()
	private disposables: vscode.Disposable[] = []
	private fileUpsertLimit = pLimit(MANAGED_MAX_CONCURRENT_FILES)

	constructor(private contextProxy: ContextProxy) {
		this.setupSubscriptions()
	}

	private setupSubscriptions() {
		// Subscribe to config changes
		this.disposables.push(
			this.contextProxy.onManagedIndexerConfigChange(() => {
				this.restart()
			}),
		)

		// Subscribe to file upsert queue
		this.store.sub(fileUpsertQueueAtom, () => {
			this.processFileUpsertQueue()
		})
	}

	async start() {
		const { get, set } = this.store

		// Load configuration
		await loadConfiguration(this.contextProxy, set)

		// Check if enabled
		const isEnabled = get(isIndexingEnabledAtom)
		if (!isEnabled) {
			console.log("[ManagedIndexer] Indexing not enabled")
			return
		}

		set(isActiveAtom, true)

		// Initialize workspace folders
		const config = get(configAtom)
		const folders = await Promise.all(
			vscode.workspace.workspaceFolders?.map((folder) => initializeWorkspaceFolder(folder, config)) ?? [],
		)

		// Create workspace folder map
		const folderMap = new Map<string, WorkspaceFolderState>()
		for (const folder of folders.filter(Boolean)) {
			const state = await this.setupWorkspaceFolder(folder!)
			if (state) {
				folderMap.set(folder!.folder.uri.fsPath, state)
			}
		}

		set(workspaceFoldersAtom, folderMap)

		// Start watchers
		await this.startWatchers()
	}

	private async setupWorkspaceFolder(state: WorkspaceFolderState): Promise<WorkspaceFolderState | null> {
		const { get } = this.store
		const config = get(configAtom)

		if (!config.token || !config.organizationId || !state.projectId) {
			return null
		}

		try {
			// Fetch initial manifest
			await getOrFetchManifest(
				{
					organizationId: config.organizationId,
					projectId: state.projectId,
					branch: state.gitBranch!,
					token: config.token,
				},
				this.store.get,
				this.store.set,
			)

			// Create watcher
			const watcher = new GitWatcher({ cwd: state.folder.uri.fsPath })
			watcher.onEvent((event) => this.handleGitEvent(event))

			return { ...state, watcher }
		} catch (error) {
			const errorObj = createError("manifest", error)
			return { ...state, lastError: errorObj }
		}
	}

	private async handleGitEvent(event: GitWatcherEvent) {
		const { get } = this.store

		if (!get(isActiveAtom)) {
			return
		}

		await processGitEvent(event, this.store.get, this.store.set)
	}

	private async processFileUpsertQueue() {
		const { get, set } = this.store
		const queue = get(fileUpsertQueueAtom)

		if (queue.length === 0) return

		// Take one item from queue
		const [task, ...remaining] = queue
		set(fileUpsertQueueAtom, remaining)

		// Process with concurrency limit
		await this.fileUpsertLimit(async () => {
			const config = get(configAtom)
			if (!config.token || !config.organizationId) {
				return
			}

			try {
				await processFileUpsert(task, config)
			} catch (error) {
				// Add to errors
				const errors = get(errorsAtom)
				set(errorsAtom, [...errors, createError("file-upsert", error)])
			}
		})
	}

	private async startWatchers() {
		const { get } = this.store
		const folders = get(workspaceFoldersAtom)

		await Promise.all(
			Array.from(folders.values()).map(async (state) => {
				if (state.watcher) {
					await state.watcher.scan()
					await state.watcher.start()
				}
			}),
		)
	}

	private async restart() {
		this.dispose()
		await this.start()
	}

	dispose() {
		const { get, set } = this.store

		// Dispose watchers
		const folders = get(workspaceFoldersAtom)
		folders.forEach((state) => state.watcher?.dispose())

		// Clear state
		set(workspaceFoldersAtom, new Map())
		set(isActiveAtom, false)
		set(fileUpsertQueueAtom, [])

		// Dispose subscriptions
		this.disposables.forEach((d) => d.dispose())
	}

	// Public API
	getWorkspaceFolderStateSnapshot() {
		const { get } = this.store
		const folders = get(workspaceFoldersAtom)

		return Array.from(folders.values()).map((state) => ({
			workspaceFolderPath: state.folder.uri.fsPath,
			workspaceFolderName: state.folder.name,
			gitBranch: state.gitBranch,
			projectId: state.projectId,
			isIndexing: state.isIndexing,
			hasWatcher: !!state.watcher,
			error: state.lastError,
		}))
	}
}
```

### 4. Benefits of Jotai Approach

1. **Atomic Updates**: Each piece of state can be updated independently
2. **Derived State**: Computed values update automatically
3. **Async Support**: Built-in support for async atoms and operations
4. **Type Safety**: Excellent TypeScript support with inference
5. **Testing**: Easy to test - just create a store and test atoms
6. **Debugging**: Jotai DevTools for state inspection
7. **Performance**: Only re-compute what changed
8. **No Boilerplate**: Less code than Redux/MobX

### 5. Testing Strategy

```typescript
// __tests__/atoms.test.ts
import { createStore } from "jotai"
import { configAtom, organizationAtom } from "../state/atoms"

describe("ManagedIndexer Atoms", () => {
	let store: ReturnType<typeof createStore>

	beforeEach(() => {
		store = createStore()
	})

	it("should derive config from individual atoms", () => {
		store.set(configTokenAtom, "test-token")
		store.set(configOrganizationIdAtom, "test-org")

		const config = store.get(configAtom)
		expect(config).toEqual({
			token: "test-token",
			organizationId: "test-org",
			testerWarningsDisabledUntil: null,
		})
	})

	it("should fetch organization when config is valid", async () => {
		vi.mocked(OrganizationService.fetchOrganization).mockResolvedValue(mockOrg)

		store.set(configTokenAtom, "test-token")
		store.set(configOrganizationIdAtom, "test-org")

		const org = await store.get(organizationAtom)
		expect(org).toEqual(mockOrg)
	})
})
```

This Jotai-based approach gives us:

- Clean separation between state and logic
- Pure functions for all operations
- Atomic, composable state management
- Excellent TypeScript support
- Easy testing and debugging
