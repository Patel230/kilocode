// kilocode_change new file

import * as vscode from "vscode"
import * as path from "path"
import { promises as fs } from "fs"
import pLimit from "p-limit"
import { ContextProxy } from "../../../core/config/ContextProxy"
import { KiloOrganization } from "../../../shared/kilocode/organization"
import { OrganizationService } from "../../kilocode/OrganizationService"
import { GitWatcher, GitWatcherEvent } from "../../../shared/GitWatcher"
import { getCurrentBranch, isGitRepository } from "./git-utils"
import { getKilocodeConfig } from "../../../utils/kilo-config-file"
import { getGitRepositoryInfo } from "../../../utils/git"
import { getServerManifest, upsertFile } from "./api-client"
import { logger } from "../../../utils/logging"
import { MANAGED_MAX_CONCURRENT_FILES } from "../constants"
import { ServerManifest } from "./types"

interface ManagedIndexerConfig {
	kilocodeToken: string | null
	kilocodeOrganizationId: string | null
	kilocodeTesterWarningsDisabledUntil: number | null
}

/**
 * Serializable error information for managed indexing operations
 */
interface ManagedIndexerError {
	/** Error type for categorization */
	type: "setup" | "scan" | "file-upsert" | "git" | "manifest" | "config"
	/** Human-readable error message */
	message: string
	/** ISO timestamp when error occurred */
	timestamp: string
	/** Optional context about what was being attempted */
	context?: {
		filePath?: string
		branch?: string
		operation?: string
	}
	/** Original error details if available */
	details?: string
}

interface ManagedIndexerWorkspaceFolderState {
	workspaceFolder: vscode.WorkspaceFolder
	gitBranch: string | null
	projectId: string | null
	manifest: ServerManifest | null
	isIndexing: boolean
	watcher: GitWatcher | null
	error?: ManagedIndexerError
}

export class ManagedIndexer implements vscode.Disposable {
	// Handle changes to vscode workspace folder changes
	workspaceFoldersListener: vscode.Disposable | null = null
	// kilocode_change: Listen to configuration changes from ContextProxy
	configChangeListener: vscode.Disposable | null = null
	config: ManagedIndexerConfig | null = null
	organization: KiloOrganization | null = null
	isActive = false

	/**
	 * Tracks state that depends on workspace folders
	 */
	workspaceFolderState: ManagedIndexerWorkspaceFolderState[] = []

	// Concurrency limiter for file upserts
	private readonly fileUpsertLimit = pLimit(MANAGED_MAX_CONCURRENT_FILES)

	constructor(public contextProxy: ContextProxy) {}

	private async onConfigurationChange(config: ManagedIndexerConfig): Promise<void> {
		logger.info("[ManagedIndexer] Configuration changed, restarting...")
		this.config = config
		this.dispose()
		await this.start()
	}

	// TODO: The fetchConfig, fetchOrganization, and isEnabled functions are sort of spaghetti
	// code right now. We need to clean this up to be more stateless or better rely
	// on proper memoization/invalidation techniques

	async fetchConfig(): Promise<ManagedIndexerConfig> {
		// kilocode_change: Read directly from ContextProxy instead of ClineProvider
		const kilocodeToken = this.contextProxy.getSecret("kilocodeToken")
		const kilocodeOrganizationId = this.contextProxy.getValue("kilocodeOrganizationId")
		const kilocodeTesterWarningsDisabledUntil = this.contextProxy.getValue("kilocodeTesterWarningsDisabledUntil")

		this.config = {
			kilocodeToken: kilocodeToken ?? null,
			kilocodeOrganizationId: kilocodeOrganizationId ?? null,
			kilocodeTesterWarningsDisabledUntil: kilocodeTesterWarningsDisabledUntil ?? null,
		}

		return this.config
	}

	async fetchOrganization(): Promise<KiloOrganization | null> {
		const config = await this.fetchConfig()

		if (config.kilocodeToken && config.kilocodeOrganizationId) {
			this.organization = await OrganizationService.fetchOrganization(
				config.kilocodeToken,
				config.kilocodeOrganizationId,
				config.kilocodeTesterWarningsDisabledUntil ?? undefined,
			)

			return this.organization
		}

		this.organization = null

		return this.organization
	}

	async isEnabled(): Promise<boolean> {
		const organization = await this.fetchOrganization()

		if (!organization) {
			console.log("[ManagedIndexer] No organization found, skipping managed indexing")
			return false
		}

		if (!OrganizationService.isCodeIndexingEnabled(organization)) {
			return false
		}

		return true
	}

	async start() {
		this.configChangeListener = this.contextProxy.onManagedIndexerConfigChange(
			this.onConfigurationChange.bind(this),
		)
		vscode.workspace.onDidChangeWorkspaceFolders(this.onDidChangeWorkspaceFolders.bind(this))

		if (!vscode.workspace.workspaceFolders?.length) {
			console.log("[ManagedIndexer] No workspace folders found, skipping managed indexing")
			return
		}

		if (!(await this.isEnabled())) {
			console.log("[ManagedIndexer] Managed indexing is not enabled")
			return
		}

		// TODO: Plumb kilocodeTesterWarningsDisabledUntil through
		const { kilocodeOrganizationId, kilocodeToken } = this.config ?? {}

		if (!kilocodeOrganizationId || !kilocodeToken) {
			console.log("[ManagedIndexer] No organization ID or token found, skipping managed indexing")
			return
		}

		this.isActive = true

		// Build workspaceFolderState for each workspace folder
		const states = await Promise.all(
			vscode.workspace.workspaceFolders.map(async (workspaceFolder) => {
				const cwd = workspaceFolder.uri.fsPath

				// Initialize state with workspace folder
				const state: ManagedIndexerWorkspaceFolderState = {
					workspaceFolder,
					gitBranch: null,
					projectId: null,
					manifest: null,
					isIndexing: false,
					watcher: null,
				}

				// Check if it's a git repository
				if (!(await isGitRepository(cwd))) {
					return null
				}

				// Step 1: Get git information
				try {
					const [{ repositoryUrl }, gitBranch] = await Promise.all([
						getGitRepositoryInfo(cwd),
						getCurrentBranch(cwd),
					])
					state.gitBranch = gitBranch

					// Step 2: Get project configuration
					const config = await getKilocodeConfig(cwd, repositoryUrl)
					const projectId = config?.project?.id

					if (!projectId) {
						console.log("[ManagedIndexer] No project ID found for workspace folder", cwd)
						return null
					}
					state.projectId = projectId

					// Step 3: Fetch server manifest
					try {
						state.manifest = await getServerManifest(
							kilocodeOrganizationId,
							projectId,
							gitBranch,
							kilocodeToken,
						)
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error)
						logger.error(`[ManagedIndexer] Failed to fetch manifest for ${cwd}: ${errorMessage}`)
						state.error = {
							type: "manifest",
							message: `Failed to fetch server manifest: ${errorMessage}`,
							timestamp: new Date().toISOString(),
							context: {
								operation: "fetch-manifest",
								branch: gitBranch,
							},
							details: error instanceof Error ? error.stack : undefined,
						}
						return state
					}

					// Step 4: Create and start git watcher
					try {
						const watcher = new GitWatcher({ cwd })
						state.watcher = watcher

						// Register event handler
						watcher.onEvent(this.onEvent.bind(this))

						// Perform an initial scan
						await watcher.scan()
						// Then start the watcher
						await watcher.start()
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error)
						logger.error(`[ManagedIndexer] Failed to start watcher for ${cwd}: ${errorMessage}`)
						state.error = {
							type: "scan",
							message: `Failed to start file watcher: ${errorMessage}`,
							timestamp: new Date().toISOString(),
							context: {
								operation: "start-watcher",
								branch: gitBranch,
							},
							details: error instanceof Error ? error.stack : undefined,
						}
						return state
					}

					return state
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					logger.error(`[ManagedIndexer] Failed to get git info for ${cwd}: ${errorMessage}`)
					state.error = {
						type: "git",
						message: `Failed to get git information: ${errorMessage}`,
						timestamp: new Date().toISOString(),
						context: {
							operation: "get-git-info",
						},
						details: error instanceof Error ? error.stack : undefined,
					}
					return state
				}
			}),
		)

		this.workspaceFolderState = states.filter((s) => s !== null)
	}

	dispose() {
		// kilocode_change: Dispose configuration change listener
		this.configChangeListener?.dispose()
		this.configChangeListener = null

		this.workspaceFoldersListener?.dispose()
		this.workspaceFoldersListener = null

		// Dispose all watchers from workspaceFolderState
		this.workspaceFolderState.forEach((state) => state.watcher?.dispose())
		this.workspaceFolderState = []

		this.isActive = false
	}

	async onEvent(event: GitWatcherEvent): Promise<void> {
		if (!this.isActive) {
			return
		}

		const state = this.workspaceFolderState.find((s) => s.watcher === event.watcher)

		if (!state || !state.watcher) {
			logger.warn("[ManagedIndexer] Received event for unknown watcher")
			return
		}

		// Skip processing if state is not fully initialized
		if (!state.projectId || !state.manifest || !state.gitBranch) {
			logger.warn("[ManagedIndexer] Received event for incompletely initialized workspace folder")
			return
		}

		// Handle different event types
		switch (event.type) {
			case "scan-start":
				// Update isIndexing state and clear any previous errors
				state.isIndexing = true
				state.error = undefined
				logger.info(`[ManagedIndexer] Scan started on branch ${event.branch}`)
				break

			case "scan-end":
				// Update isIndexing state
				state.isIndexing = false
				logger.info(`[ManagedIndexer] Scan completed on branch ${event.branch}`)
				break

			case "file-deleted":
				logger.info(`[ManagedIndexer] File deleted: ${event.filePath} on branch ${event.branch}`)
				// TODO: Implement file deletion handling if needed
				break

			case "file-changed": {
				const { branch, filePath, fileHash, isBaseBranch, watcher } = event
				const { projectId, manifest } = state

				// Already indexed
				if (manifest.files.some((f) => f.filePath === filePath && f.fileHash === fileHash)) {
					return
				}

				// Concurrently process the file
				return this.fileUpsertLimit(async () => {
					try {
						// Ensure we have the necessary configuration
						if (!this.config?.kilocodeToken || !this.config?.kilocodeOrganizationId) {
							logger.warn("[ManagedIndexer] Missing token or organization ID, skipping file upsert")
							return
						}

						const absoluteFilePath = path.isAbsolute(filePath)
							? filePath
							: path.join(watcher.config.cwd, filePath)
						const fileBuffer = await fs.readFile(absoluteFilePath)
						const relativeFilePath = path.relative(watcher.config.cwd, absoluteFilePath)

						// Call the upsertFile API
						await upsertFile({
							fileBuffer,
							fileHash,
							filePath: relativeFilePath,
							gitBranch: branch,
							isBaseBranch,
							organizationId: this.config.kilocodeOrganizationId,
							projectId,
							kilocodeToken: this.config.kilocodeToken,
						})

						logger.info(
							`[ManagedIndexer] Successfully upserted file: ${relativeFilePath} (branch: ${branch})`,
						)

						// Clear any previous file-upsert errors on success
						if (state.error?.type === "file-upsert") {
							state.error = undefined
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error)
						logger.error(`[ManagedIndexer] Failed to upsert file ${filePath}: ${errorMessage}`)

						// Store the error in state
						state.error = {
							type: "file-upsert",
							message: `Failed to upsert file: ${errorMessage}`,
							timestamp: new Date().toISOString(),
							context: {
								filePath,
								branch,
								operation: "file-upsert",
							},
							details: error instanceof Error ? error.stack : undefined,
						}
					}
				})
			}
		}
	}

	async onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent) {
		// TODO we could more intelligently handle this instead of going scorched earth
		this.dispose()
		await this.start()
	}
}
