// Pure functions for file upsert operations

import * as path from "path"
import { promises as fs } from "fs"
import { upsertFile, UpsertFileParams } from "../api-client"
import { FileUpsertTask, ConfigState } from "../state/types"
import { createError } from "./error"
import { logger } from "../../../../utils/logging"
import { scannerExtensions } from "../../shared/supported-extensions"

/**
 * Check if a file should be processed based on its extension
 */
export function shouldProcessFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase()
	return scannerExtensions.includes(ext)
}

/**
 * Process a file upsert task
 */
export async function processFileUpsert(task: FileUpsertTask, config: ConfigState): Promise<void> {
	if (!config.token || !config.organizationId) {
		logger.warn("[ManagedIndexer] Missing token or organization ID, skipping file upsert")
		return
	}

	const absoluteFilePath = path.isAbsolute(task.filePath)
		? task.filePath
		: path.join(task.workspacePath, task.filePath)

	const relativeFilePath = path.relative(task.workspacePath, absoluteFilePath)

	try {
		// Read the file
		const fileBuffer = await fs.readFile(absoluteFilePath)

		// Prepare upsert parameters
		const params: UpsertFileParams = {
			fileBuffer,
			fileHash: task.fileHash,
			filePath: relativeFilePath,
			gitBranch: task.branch,
			isBaseBranch: task.isBaseBranch,
			organizationId: config.organizationId,
			projectId: task.projectId,
			kilocodeToken: config.token,
		}

		// Call the API
		await upsertFile(params)

		logger.info(`[ManagedIndexer] Successfully upserted file: ${relativeFilePath} (branch: ${task.branch})`)
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		logger.error(`[ManagedIndexer] Failed to upsert file ${relativeFilePath}: ${errorMessage}`)
		throw createError("file-upsert", error, {
			filePath: relativeFilePath,
			branch: task.branch,
			operation: "upsert-file",
		})
	}
}

/**
 * Batch process multiple file upserts
 */
export async function batchProcessFileUpserts(
	tasks: FileUpsertTask[],
	config: ConfigState,
	onProgress?: (completed: number, total: number) => void,
): Promise<{ successful: number; failed: Array<{ task: FileUpsertTask; error: Error }> }> {
	const results = {
		successful: 0,
		failed: [] as Array<{ task: FileUpsertTask; error: Error }>,
	}

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]

		try {
			await processFileUpsert(task, config)
			results.successful++
		} catch (error) {
			results.failed.push({
				task,
				error: error instanceof Error ? error : new Error(String(error)),
			})
		}

		if (onProgress) {
			onProgress(i + 1, tasks.length)
		}
	}

	return results
}

/**
 * Filter tasks to remove duplicates
 */
export function deduplicateFileUpsertTasks(tasks: FileUpsertTask[]): FileUpsertTask[] {
	const seen = new Set<string>()
	const deduplicated: FileUpsertTask[] = []

	for (const task of tasks) {
		const key = `${task.projectId}:${task.branch}:${task.filePath}:${task.fileHash}`
		if (!seen.has(key)) {
			seen.add(key)
			deduplicated.push(task)
		}
	}

	return deduplicated
}

/**
 * Group tasks by project and branch for efficient processing
 */
export function groupFileUpsertTasks(tasks: FileUpsertTask[]): Map<string, FileUpsertTask[]> {
	const grouped = new Map<string, FileUpsertTask[]>()

	for (const task of tasks) {
		const key = `${task.projectId}:${task.branch}`
		const group = grouped.get(key) || []
		group.push(task)
		grouped.set(key, group)
	}

	return grouped
}

/**
 * Validate a file upsert task
 */
export function validateFileUpsertTask(task: FileUpsertTask): string[] {
	const errors: string[] = []

	if (!task.filePath) {
		errors.push("Missing file path")
	}

	if (!task.fileHash) {
		errors.push("Missing file hash")
	}

	if (!task.branch) {
		errors.push("Missing branch")
	}

	if (!task.projectId) {
		errors.push("Missing project ID")
	}

	if (!task.workspacePath) {
		errors.push("Missing workspace path")
	}

	if (!shouldProcessFile(task.filePath)) {
		errors.push(`Unsupported file extension: ${path.extname(task.filePath)}`)
	}

	return errors
}

/**
 * Create a file upsert task from event data
 */
export function createFileUpsertTask(
	filePath: string,
	fileHash: string,
	branch: string,
	isBaseBranch: boolean,
	projectId: string,
	workspacePath: string,
): FileUpsertTask {
	return {
		filePath,
		fileHash,
		branch,
		isBaseBranch,
		projectId,
		workspacePath,
	}
}

/**
 * Get file stats for logging
 */
export async function getFileStats(filePath: string): Promise<{ size: number; modified: Date } | null> {
	try {
		const stats = await fs.stat(filePath)
		return {
			size: stats.size,
			modified: stats.mtime,
		}
	} catch {
		return null
	}
}

/**
 * Estimate time for file upsert based on file size
 */
export function estimateUpsertTime(fileSize: number): number {
	// Rough estimate: 1MB per second + 500ms overhead
	const mbPerSecond = 1024 * 1024
	const overhead = 500
	return Math.ceil((fileSize / mbPerSecond) * 1000 + overhead)
}

/**
 * Priority comparator for file upsert tasks
 * Prioritizes smaller files and base branch files
 */
export async function compareFileUpsertPriority(a: FileUpsertTask, b: FileUpsertTask): Promise<number> {
	// Base branch files have higher priority
	if (a.isBaseBranch !== b.isBaseBranch) {
		return a.isBaseBranch ? -1 : 1
	}

	// Try to prioritize by file size (smaller first)
	const aPath = path.isAbsolute(a.filePath) ? a.filePath : path.join(a.workspacePath, a.filePath)
	const bPath = path.isAbsolute(b.filePath) ? b.filePath : path.join(b.workspacePath, b.filePath)

	const [aStats, bStats] = await Promise.all([getFileStats(aPath), getFileStats(bPath)])

	if (aStats && bStats) {
		return aStats.size - bStats.size
	}

	// If we can't get stats, maintain original order
	return 0
}
