// Pure functions for workspace operations

import * as vscode from "vscode"
import { GitWatcher } from "../../../../shared/GitWatcher"
import { isGitRepository, getCurrentBranch } from "../git-utils"
import { getGitRepositoryInfo } from "../../../../utils/git"
import { getKilocodeConfig } from "../../../../utils/kilo-config-file"
import { WorkspaceFolderState, ConfigState, GitInfo } from "../state/types"
import { createError } from "./error"

/**
 * Fetch git information for a workspace
 */
async function fetchGitInfo(cwd: string): Promise<GitInfo> {
	const [{ repositoryUrl }, branch] = await Promise.all([getGitRepositoryInfo(cwd), getCurrentBranch(cwd)])

	return {
		repositoryUrl: repositoryUrl || "",
		branch,
	}
}

/**
 * Initialize a workspace folder state
 */
export async function initializeWorkspaceFolder(
	folder: vscode.WorkspaceFolder,
	config: ConfigState,
): Promise<WorkspaceFolderState | null> {
	const cwd = folder.uri.fsPath

	try {
		// Check if it's a git repository
		if (!(await isGitRepository(cwd))) {
			console.log(`[ManagedIndexer] ${cwd} is not a git repository`)
			return null
		}

		// Get git information
		const gitInfo = await fetchGitInfo(cwd)

		// Get project configuration
		const projectConfig = await getKilocodeConfig(cwd, gitInfo.repositoryUrl)

		if (!projectConfig?.project?.id) {
			console.log(`[ManagedIndexer] No project ID found for ${cwd}`)
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
	} catch (error) {
		console.error(`[ManagedIndexer] Failed to initialize workspace folder ${cwd}:`, error)
		return {
			folder,
			gitBranch: null,
			projectId: null,
			repositoryUrl: null,
			isIndexing: false,
			watcher: null,
			lastError: createError("setup", error, {
				operation: "initialize-workspace",
			}),
		}
	}
}

/**
 * Update a workspace folder in the map
 */
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

/**
 * Find workspace folder by watcher
 */
export function findWorkspaceFolderByWatcher(
	folders: Map<string, WorkspaceFolderState>,
	watcher: GitWatcher,
): WorkspaceFolderState | null {
	for (const state of folders.values()) {
		if (state.watcher === watcher) {
			return state
		}
	}
	return null
}

/**
 * Create a git watcher for a workspace folder
 */
export function createWatcher(state: WorkspaceFolderState, onEvent: (event: any) => void): GitWatcher | null {
	if (!state.folder) {
		return null
	}

	try {
		const watcher = new GitWatcher({
			cwd: state.folder.uri.fsPath,
		})
		watcher.onEvent(onEvent)
		return watcher
	} catch (error) {
		console.error(`[ManagedIndexer] Failed to create watcher for ${state.folder.uri.fsPath}:`, error)
		return null
	}
}

/**
 * Dispose all watchers in workspace folders
 */
export function disposeAllWatchers(folders: Map<string, WorkspaceFolderState>): void {
	for (const state of folders.values()) {
		if (state.watcher) {
			state.watcher.dispose()
		}
	}
}

/**
 * Get active workspace folders (those with watchers)
 */
export function getActiveWorkspaceFolders(folders: Map<string, WorkspaceFolderState>): WorkspaceFolderState[] {
	return Array.from(folders.values()).filter((f) => f.watcher !== null)
}

/**
 * Get workspace folders that are currently indexing
 */
export function getIndexingWorkspaceFolders(folders: Map<string, WorkspaceFolderState>): WorkspaceFolderState[] {
	return Array.from(folders.values()).filter((f) => f.isIndexing)
}

/**
 * Check if any workspace folder has errors
 */
export function hasWorkspaceFolderErrors(folders: Map<string, WorkspaceFolderState>): boolean {
	return Array.from(folders.values()).some((f) => f.lastError !== null)
}

/**
 * Get workspace folder errors
 */
export function getWorkspaceFolderErrors(
	folders: Map<string, WorkspaceFolderState>,
): Array<{ path: string; error: NonNullable<WorkspaceFolderState["lastError"]> }> {
	const errors: Array<{ path: string; error: NonNullable<WorkspaceFolderState["lastError"]> }> = []

	for (const [path, state] of folders.entries()) {
		if (state.lastError) {
			errors.push({ path, error: state.lastError })
		}
	}

	return errors
}

/**
 * Clear errors for a workspace folder
 */
export function clearWorkspaceFolderError(
	folders: Map<string, WorkspaceFolderState>,
	folderId: string,
): Map<string, WorkspaceFolderState> {
	return updateWorkspaceFolder(folders, folderId, { lastError: null })
}

/**
 * Update git branch for a workspace folder
 */
export async function updateWorkspaceFolderBranch(
	state: WorkspaceFolderState,
	newBranch: string,
): Promise<Partial<WorkspaceFolderState>> {
	try {
		// Re-fetch project config as it might be branch-specific
		const config = await getKilocodeConfig(state.folder.uri.fsPath, state.repositoryUrl || undefined)

		const projectId = config?.project?.id || state.projectId

		return {
			gitBranch: newBranch,
			projectId,
			lastError: null, // Clear any previous errors
		}
	} catch (error) {
		return {
			gitBranch: newBranch,
			lastError: createError("config", error, {
				operation: "update-branch",
				branch: newBranch,
			}),
		}
	}
}
