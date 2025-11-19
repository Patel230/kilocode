// Refactored ManagedIndexer using Jotai and functional modules

import * as vscode from "vscode"
import { createStore } from "jotai"
import pLimit from "p-limit"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { GitWatcher, GitWatcherEvent } from "../../../shared/GitWatcher"
import { MANAGED_MAX_CONCURRENT_FILES } from "../constants"
import { logger } from "../../../utils/logging"

// Import atoms
import {
	configAtom,
	isIndexingEnabledAtom,
	isActiveAtom,
	workspaceFoldersAtom,
	fileUpsertQueueAtom,
	dequeueFileUpsertAtom,
	errorsAtom,
	clearErrorsAtom,
} from "./state/atoms"

// Import operations
import { loadConfiguration } from "./operations/config"
import { initializeWorkspaceFolder, createWatcher, disposeAllWatchers } from "./operations/workspace"
import { getOrFetchManifest } from "./operations/manifest"
import { processFileUpsert } from "./operations/file-upsert"
import { processGitEvent } from "./operations/git-events"
import { createError } from "./operations/error"
import { WorkspaceFolderState } from "./state/types"

/**
 * Refactored ManagedIndexer - Thin orchestrator using Jotai and functional modules
 */
export class ManagedIndexer implements vscode.Disposable {
	private store = createStore()
	private disposables: vscode.Disposable[] = []
	private fileUpsertLimit = pLimit(MANAGED_MAX_CONCURRENT_FILES)
	private fileUpsertInterval: NodeJS.Timeout | null = null

	// Public properties for compatibility
	public get config() {
		return this.store.get(configAtom)
	}

	public get organization() {
		// Organization is now handled via atoms
		return null // This would need to be async in the new architecture
	}

	public get isActive() {
		return this.store.get(isActiveAtom)
	}

	public get workspaceFolderState() {
		return Array.from(this.store.get(workspaceFoldersAtom).values())
	}

	constructor(public contextProxy: ContextProxy) {
		this.setupSubscriptions()
	}

	private setupSubscriptions() {
		// Subscribe to config changes
		const configChangeListener = this.contextProxy.onManagedIndexerConfigChange(() => {
			this.onConfigurationChange()
		})
		this.disposables.push(configChangeListener)

		// Subscribe to workspace folder changes
		const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(
			this.onDidChangeWorkspaceFolders.bind(this),
		)
		this.disposables.push(workspaceFolderListener)

		// Start file upsert processing
		this.startFileUpsertProcessing()
	}

	private async onConfigurationChange(): Promise<void> {
		logger.info("[ManagedIndexer] Configuration changed, restarting...")
		await this.restart()
	}

	private async onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
		// TODO: Could be more intelligent instead of full restart
		await this.restart()
	}

	private startFileUpsertProcessing() {
		// Process file upsert queue periodically
		this.fileUpsertInterval = setInterval(() => {
			this.processFileUpsertQueue()
		}, 100)
	}

	private async processFileUpsertQueue() {
		const { get, set } = this.store
		const task = set(dequeueFileUpsertAtom)

		if (!task) {
			return
		}

		// Process with concurrency limit
		await this.fileUpsertLimit(async () => {
			const config = get(configAtom)
			if (!config.token || !config.organizationId) {
				return
			}

			try {
				await processFileUpsert(task, config)
			} catch (error) {
				const errorObj = createError("file-upsert", error, {
					filePath: task.filePath,
					branch: task.branch,
				})

				const errors = get(errorsAtom)
				set(errorsAtom, [...errors, errorObj])
			}
		})
	}

	async start() {
		const { get, set } = this.store

		// Load configuration
		await loadConfiguration(this.contextProxy, set)

		// Check workspace folders first
		if (!vscode.workspace.workspaceFolders?.length) {
			logger.info("[ManagedIndexer] No workspace folders found, skipping managed indexing")
			return
		}

		// Check if enabled (this is now async)
		const isEnabled = await get(isIndexingEnabledAtom)
		if (!isEnabled) {
			logger.info("[ManagedIndexer] Indexing not enabled")
			return
		}

		// Check configuration
		const config = get(configAtom)
		if (!config.token || !config.organizationId) {
			logger.info("[ManagedIndexer] No organization ID or token found, skipping managed indexing")
			return
		}

		set(isActiveAtom, true)

		try {
			// Initialize workspace folders
			const folders = await Promise.all(
				vscode.workspace.workspaceFolders?.map((folder) => initializeWorkspaceFolder(folder, config)) ?? [],
			)

			// Create workspace folder map with watchers
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
		} catch (error) {
			logger.error("[ManagedIndexer] Failed to start:", error)
			set(isActiveAtom, false)
			throw error
		}
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
			const watcher = createWatcher(state, (event) => this.handleGitEvent(event))

			if (!watcher) {
				throw new Error("Failed to create watcher")
			}

			return { ...state, watcher }
		} catch (error) {
			const errorObj = createError("manifest", error, {
				operation: "setup-workspace",
				branch: state.gitBranch || undefined,
			})
			return { ...state, lastError: errorObj }
		}
	}

	private async handleGitEvent(event: GitWatcherEvent) {
		const { get } = this.store

		if (!get(isActiveAtom)) {
			return
		}

		try {
			await processGitEvent(event, this.store.get, this.store.set)
		} catch (error) {
			logger.error("[ManagedIndexer] Error processing git event:", error)
		}
	}

	private async startWatchers() {
		const { get } = this.store
		const folders = get(workspaceFoldersAtom)

		await Promise.all(
			Array.from(folders.values()).map(async (state) => {
				if (state.watcher) {
					try {
						await state.watcher.scan()
						await state.watcher.start()
					} catch (error) {
						logger.error(`[ManagedIndexer] Failed to start watcher for ${state.folder.uri.fsPath}:`, error)
					}
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

		// Stop file upsert processing
		if (this.fileUpsertInterval) {
			clearInterval(this.fileUpsertInterval)
			this.fileUpsertInterval = null
		}

		// Dispose watchers
		const folders = get(workspaceFoldersAtom)
		disposeAllWatchers(folders)

		// Clear state
		set(workspaceFoldersAtom, new Map())
		set(isActiveAtom, false)
		set(fileUpsertQueueAtom, [])
		set(clearErrorsAtom)

		// Dispose subscriptions
		this.disposables.forEach((d) => {
			if (d && typeof d.dispose === "function") {
				d.dispose()
			}
		})
		this.disposables = []
	}

	// Public API for compatibility
	async fetchConfig() {
		await loadConfiguration(this.contextProxy, this.store.set)
		return this.store.get(configAtom)
	}

	async fetchOrganization() {
		// This is now handled via atoms
		// Would need to be refactored in calling code to handle async
		return null
	}

	async isEnabled() {
		return await this.store.get(isIndexingEnabledAtom)
	}

	async onEvent(event: GitWatcherEvent) {
		await this.handleGitEvent(event)
	}

	getWorkspaceFolderStateSnapshot() {
		const folders = this.store.get(workspaceFoldersAtom)

		return Array.from(folders.values()).map((state) => ({
			workspaceFolderPath: state.folder.uri.fsPath,
			workspaceFolderName: state.folder.name,
			gitBranch: state.gitBranch,
			projectId: state.projectId,
			isIndexing: state.isIndexing,
			hasManifest: true, // Simplified - would need to check manifest cache
			manifestFileCount: 0, // Would need to check manifest cache
			hasWatcher: !!state.watcher,
			error: state.lastError
				? {
						type: state.lastError.type,
						message: state.lastError.message,
						timestamp: state.lastError.timestamp,
						context: state.lastError.context,
					}
				: undefined,
		}))
	}
}
