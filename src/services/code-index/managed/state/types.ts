// State type definitions for ManagedIndexer with Jotai

import * as vscode from "vscode"
import { GitWatcher } from "../../../../shared/GitWatcher"
import { ServerManifest } from "../types"

/**
 * Configuration state
 */
export interface ConfigState {
	token: string | null
	organizationId: string | null
	testerWarningsDisabledUntil: number | null
}

/**
 * Workspace folder state
 */
export interface WorkspaceFolderState {
	folder: vscode.WorkspaceFolder
	gitBranch: string | null
	projectId: string | null
	repositoryUrl: string | null
	isIndexing: boolean
	watcher: GitWatcher | null
	lastError: ManagedIndexerError | null
}

/**
 * Manifest cache entry
 */
export interface ManifestCacheEntry {
	manifest: ServerManifest | null
	fetchedAt: number
	fetchPromise: Promise<ServerManifest> | null
}

/**
 * File upsert task
 */
export interface FileUpsertTask {
	filePath: string
	fileHash: string
	branch: string
	isBaseBranch: boolean
	projectId: string
	workspacePath: string
}

/**
 * Managed indexer error
 */
export interface ManagedIndexerError {
	type: "setup" | "scan" | "file-upsert" | "git" | "manifest" | "config"
	message: string
	timestamp: string
	context?: {
		filePath?: string
		branch?: string
		operation?: string
	}
	details?: string
}

/**
 * Git information
 */
export interface GitInfo {
	branch: string
	repositoryUrl: string
}

/**
 * Manifest fetch parameters
 */
export interface ManifestFetchParams {
	organizationId: string
	projectId: string
	branch: string
	token: string
}
