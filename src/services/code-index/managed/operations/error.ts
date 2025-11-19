// Pure functions for error handling

import { ManagedIndexerError } from "../state/types"

/**
 * Create a standardized error object
 */
export function createError(
	type: ManagedIndexerError["type"],
	error: unknown,
	context?: ManagedIndexerError["context"],
): ManagedIndexerError {
	const message = error instanceof Error ? error.message : String(error)
	const details = error instanceof Error ? error.stack : undefined

	return {
		type,
		message,
		timestamp: new Date().toISOString(),
		context,
		details,
	}
}

/**
 * Check if an error is recoverable
 */
export function isRecoverableError(error: ManagedIndexerError): boolean {
	// Manifest errors are often temporary (network issues)
	if (error.type === "manifest") {
		return true
	}

	// File upsert errors might be temporary
	if (error.type === "file-upsert") {
		// Check for specific error patterns that indicate temporary issues
		const temporaryPatterns = [
			/network/i,
			/timeout/i,
			/ECONNREFUSED/i,
			/ETIMEDOUT/i,
			/429/, // Rate limiting
			/503/, // Service unavailable
		]
		return temporaryPatterns.some((pattern) => pattern.test(error.message))
	}

	// Git errors might be recoverable if they're about locks
	if (error.type === "git") {
		return /lock/i.test(error.message)
	}

	return false
}

/**
 * Format error for logging
 */
export function formatErrorForLogging(error: ManagedIndexerError): string {
	const parts = [`[${error.type.toUpperCase()}] ${error.message}`]

	if (error.context) {
		const contextStr = Object.entries(error.context)
			.map(([key, value]) => `${key}=${value}`)
			.join(", ")
		parts.push(`Context: ${contextStr}`)
	}

	parts.push(`Timestamp: ${error.timestamp}`)

	return parts.join(" | ")
}

/**
 * Group errors by type
 */
export function groupErrorsByType(
	errors: ManagedIndexerError[],
): Record<ManagedIndexerError["type"], ManagedIndexerError[]> {
	const grouped: Record<string, ManagedIndexerError[]> = {}

	for (const error of errors) {
		if (!grouped[error.type]) {
			grouped[error.type] = []
		}
		grouped[error.type].push(error)
	}

	return grouped as Record<ManagedIndexerError["type"], ManagedIndexerError[]>
}

/**
 * Get the most recent error of a specific type
 */
export function getMostRecentError(
	errors: ManagedIndexerError[],
	type?: ManagedIndexerError["type"],
): ManagedIndexerError | null {
	const filtered = type ? errors.filter((e) => e.type === type) : errors

	if (filtered.length === 0) {
		return null
	}

	return filtered.reduce((latest, current) => {
		return new Date(current.timestamp) > new Date(latest.timestamp) ? current : latest
	})
}

/**
 * Clear old errors (older than specified minutes)
 */
export function clearOldErrors(errors: ManagedIndexerError[], maxAgeMinutes: number = 60): ManagedIndexerError[] {
	const cutoff = Date.now() - maxAgeMinutes * 60 * 1000

	return errors.filter((error) => {
		return new Date(error.timestamp).getTime() > cutoff
	})
}
