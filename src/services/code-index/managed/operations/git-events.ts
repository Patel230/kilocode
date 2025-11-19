// Pure functions for git event processing

import { Getter, Setter } from "jotai"
import {
	GitWatcherEvent,
	GitWatcherFileChangedEvent,
	GitWatcherBranchChangedEvent,
} from "../../../../shared/GitWatcher"
import {
	workspaceFoldersAtom,
	configAtom,
	fileUpsertQueueAtom,
	updateWorkspaceFolderAtom,
	enqueueFileUpsertAtom,
	addErrorAtom,
} from "../state/atoms"
import { WorkspaceFolderState } from "../state/types"
import { findWorkspaceFolderByWatcher, updateWorkspaceFolder, updateWorkspaceFolderBranch } from "./workspace"
import { getOrFetchManifest, isFileIndexed } from "./manifest"
import { shouldProcessFile, createFileUpsertTask } from "./file-upsert"
import { createError } from "./error"
import { logger } from "../../../../utils/logging"

/**
 * Main event processor
 */
export async function processGitEvent(event: GitWatcherEvent, get: Getter, set: Setter): Promise<void> {
	const folders = get(workspaceFoldersAtom)
	const folder = findWorkspaceFolderByWatcher(folders, event.watcher)

	if (!folder) {
		logger.warn("[ManagedIndexer] Event from unknown watcher")
		return
	}

	// Skip processing if state is not fully initialized
	if (!folder.projectId || !folder.gitBranch) {
		logger.warn("[ManagedIndexer] Received event for incompletely initialized workspace folder")
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
			await handleFileChanged(folder, event as GitWatcherFileChangedEvent, get, set)
			break

		case "file-deleted":
			await handleFileDeleted(folder, event, get, set)
			break

		case "branch-changed":
			await handleBranchChanged(folder, event as GitWatcherBranchChangedEvent, get, set)
			break
	}
}

/**
 * Handle scan start event
 */
async function handleScanStart(
	folder: WorkspaceFolderState,
	event: GitWatcherEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	logger.info(`[ManagedIndexer] Scan started on branch ${event.branch}`)

	// Update folder state
	set(updateWorkspaceFolderAtom, {
		path: folder.folder.uri.fsPath,
		updates: {
			isIndexing: true,
			lastError: null, // Clear any previous errors
		},
	})
}

/**
 * Handle scan end event
 */
async function handleScanEnd(
	folder: WorkspaceFolderState,
	event: GitWatcherEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	logger.info(`[ManagedIndexer] Scan completed on branch ${event.branch}`)

	// Update folder state
	set(updateWorkspaceFolderAtom, {
		path: folder.folder.uri.fsPath,
		updates: { isIndexing: false },
	})
}

/**
 * Handle file changed event
 */
async function handleFileChanged(
	folder: WorkspaceFolderState,
	event: GitWatcherFileChangedEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	// Check file extension
	if (!shouldProcessFile(event.filePath)) {
		logger.info(`[ManagedIndexer] Skipping file with unsupported extension: ${event.filePath}`)
		return
	}

	// Get configuration
	const config = get(configAtom)
	if (!config.token || !config.organizationId || !folder.projectId) {
		logger.warn("[ManagedIndexer] Missing configuration for file upsert")
		return
	}

	try {
		// Get or fetch manifest
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
			logger.info(`[ManagedIndexer] File already indexed: ${event.filePath}`)
			return
		}

		// Create and queue file upsert task
		const task = createFileUpsertTask(
			event.filePath,
			event.fileHash,
			event.branch,
			event.isBaseBranch,
			folder.projectId,
			folder.folder.uri.fsPath,
		)

		set(enqueueFileUpsertAtom, task)
		logger.info(`[ManagedIndexer] Queued file for upsert: ${event.filePath}`)
	} catch (error) {
		const errorObj = createError("file-upsert", error, {
			filePath: event.filePath,
			branch: event.branch,
			operation: "queue-file-upsert",
		})

		set(addErrorAtom, errorObj)
		logger.error(`[ManagedIndexer] Failed to process file change: ${errorObj.message}`)
	}
}

/**
 * Handle file deleted event
 */
async function handleFileDeleted(
	folder: WorkspaceFolderState,
	event: GitWatcherEvent & { filePath: string },
	get: Getter,
	set: Setter,
): Promise<void> {
	logger.info(`[ManagedIndexer] File deleted: ${event.filePath} on branch ${event.branch}`)

	// TODO: Implement file deletion handling if needed
	// This might involve calling a delete API endpoint
	// For now, we just log it
}

/**
 * Handle branch changed event
 */
async function handleBranchChanged(
	folder: WorkspaceFolderState,
	event: GitWatcherBranchChangedEvent,
	get: Getter,
	set: Setter,
): Promise<void> {
	logger.info(`[ManagedIndexer] Branch changed from ${event.previousBranch} to ${event.newBranch}`)

	try {
		// Update workspace folder with new branch
		const updates = await updateWorkspaceFolderBranch(folder, event.newBranch)

		set(updateWorkspaceFolderAtom, {
			path: folder.folder.uri.fsPath,
			updates,
		})

		// Fetch manifest for the new branch
		const config = get(configAtom)
		if (config.token && config.organizationId && folder.projectId) {
			await getOrFetchManifest(
				{
					organizationId: config.organizationId,
					projectId: updates.projectId || folder.projectId,
					branch: event.newBranch,
					token: config.token,
				},
				get,
				set,
			)
		}
	} catch (error) {
		const errorObj = createError("manifest", error, {
			branch: event.newBranch,
			operation: "branch-change",
		})

		// Update folder with error
		set(updateWorkspaceFolderAtom, {
			path: folder.folder.uri.fsPath,
			updates: { lastError: errorObj },
		})

		logger.warn(`[ManagedIndexer] Continuing despite manifest fetch error`)
	}
}

/**
 * Check if we should skip processing an event
 */
export function shouldSkipEvent(folder: WorkspaceFolderState, event: GitWatcherEvent): boolean {
	// Skip if folder is not initialized
	if (!folder.projectId || !folder.gitBranch) {
		return true
	}

	// Skip if we're already processing too many files
	// This could be enhanced with more sophisticated logic
	return false
}

/**
 * Get event statistics for monitoring
 */
export function getEventStats(events: GitWatcherEvent[]): {
	byType: Record<string, number>
	byBranch: Record<string, number>
	total: number
} {
	const byType: Record<string, number> = {}
	const byBranch: Record<string, number> = {}

	for (const event of events) {
		// Count by type
		byType[event.type] = (byType[event.type] || 0) + 1

		// Count by branch
		byBranch[event.branch] = (byBranch[event.branch] || 0) + 1
	}

	return {
		byType,
		byBranch,
		total: events.length,
	}
}

/**
 * Create a batch of file upsert tasks from multiple file-changed events
 */
export function createBatchFromFileEvents(
	events: GitWatcherFileChangedEvent[],
	projectId: string,
	workspacePath: string,
): Array<ReturnType<typeof createFileUpsertTask>> {
	return events
		.filter((event) => shouldProcessFile(event.filePath))
		.map((event) =>
			createFileUpsertTask(
				event.filePath,
				event.fileHash,
				event.branch,
				event.isBaseBranch,
				projectId,
				workspacePath,
			),
		)
}

/**
 * Determine if an event requires immediate processing
 */
export function isHighPriorityEvent(event: GitWatcherEvent): boolean {
	// Branch changes are high priority
	if (event.type === "branch-changed") {
		return true
	}

	// Base branch file changes are high priority
	if (event.type === "file-changed" && event.isBaseBranch) {
		return true
	}

	return false
}
