// Pure functions for manifest operations

import { Getter, Setter } from "jotai"
import { getServerManifest } from "../api-client"
import { ServerManifest } from "../types"
import { ManifestCacheEntry, ManifestFetchParams } from "../state/types"
import { manifestCacheAtom } from "../state/atoms"
import { createError } from "./error"
import { logger } from "../../../../utils/logging"

/**
 * Fetch manifest from the server
 */
export async function fetchManifest(params: ManifestFetchParams): Promise<ServerManifest> {
	return getServerManifest(params.organizationId, params.projectId, params.branch, params.token)
}

/**
 * Get cached manifest if still valid
 */
export function getCachedManifest(
	cache: Map<string, ManifestCacheEntry>,
	key: string,
	maxAgeMs: number = 5 * 60 * 1000, // 5 minutes default
): ServerManifest | null {
	const entry = cache.get(key)
	if (!entry || !entry.manifest) return null

	// Check if cache is still valid
	const isExpired = Date.now() - entry.fetchedAt > maxAgeMs
	return isExpired ? null : entry.manifest
}

/**
 * Get or fetch manifest with caching and deduplication
 */
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
		logger.info(`[ManagedIndexer] Reusing in-flight manifest fetch for ${key}`)
		return existing.fetchPromise
	}

	// Check cache
	const cached = getCachedManifest(cache, key)
	if (cached) {
		logger.info(`[ManagedIndexer] Using cached manifest for ${key}`)
		return cached
	}

	// Fetch new manifest
	logger.info(`[ManagedIndexer] Fetching manifest for ${key}`)
	const promise = fetchManifest(params)

	// Store promise in cache to prevent duplicate fetches
	const newCache = new Map(cache)
	newCache.set(key, {
		manifest: null,
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

		logger.info(`[ManagedIndexer] Successfully fetched manifest for ${key} (${manifest.files.length} files)`)

		return manifest
	} catch (error) {
		// Remove from cache on error
		const errorCache = new Map(get(manifestCacheAtom))
		errorCache.delete(key)
		set(manifestCacheAtom, errorCache)

		const errorMessage = error instanceof Error ? error.message : String(error)
		logger.error(`[ManagedIndexer] Failed to fetch manifest for ${key}: ${errorMessage}`)

		throw error
	}
}

/**
 * Check if a file is already indexed
 */
export function isFileIndexed(manifest: ServerManifest, filePath: string, fileHash: string): boolean {
	return manifest.files.some((f) => f.filePath === filePath && f.fileHash === fileHash)
}

/**
 * Clear manifest cache for a specific project
 */
export function clearManifestCache(
	cache: Map<string, ManifestCacheEntry>,
	projectId: string,
): Map<string, ManifestCacheEntry> {
	const newCache = new Map(cache)

	// Remove all entries for this project
	for (const key of newCache.keys()) {
		if (key.startsWith(`${projectId}:`)) {
			newCache.delete(key)
		}
	}

	return newCache
}

/**
 * Clear all manifest cache
 */
export function clearAllManifestCache(): Map<string, ManifestCacheEntry> {
	return new Map()
}

/**
 * Get manifest cache key
 */
export function getManifestCacheKey(projectId: string, branch: string): string {
	return `${projectId}:${branch}`
}

/**
 * Invalidate manifest cache for a branch change
 */
export function invalidateManifestForBranch(
	cache: Map<string, ManifestCacheEntry>,
	projectId: string,
	oldBranch: string,
	newBranch: string,
): Map<string, ManifestCacheEntry> {
	const newCache = new Map(cache)

	// Remove old branch cache
	const oldKey = getManifestCacheKey(projectId, oldBranch)
	newCache.delete(oldKey)

	// Optionally, we could pre-warm the new branch cache here
	// but that would require async operations

	return newCache
}

/**
 * Get cache statistics
 */
export function getManifestCacheStats(cache: Map<string, ManifestCacheEntry>): {
	totalEntries: number
	fetchingCount: number
	cachedCount: number
	oldestEntry: Date | null
	newestEntry: Date | null
} {
	let oldestEntry: Date | null = null
	let newestEntry: Date | null = null
	let fetchingCount = 0
	let cachedCount = 0

	for (const entry of cache.values()) {
		if (entry.fetchPromise) {
			fetchingCount++
		} else if (entry.manifest) {
			cachedCount++
		}

		const entryDate = new Date(entry.fetchedAt)
		if (!oldestEntry || entryDate < oldestEntry) {
			oldestEntry = entryDate
		}
		if (!newestEntry || entryDate > newestEntry) {
			newestEntry = entryDate
		}
	}

	return {
		totalEntries: cache.size,
		fetchingCount,
		cachedCount,
		oldestEntry,
		newestEntry,
	}
}

/**
 * Prune old cache entries
 */
export function pruneManifestCache(
	cache: Map<string, ManifestCacheEntry>,
	maxAgeMs: number = 30 * 60 * 1000, // 30 minutes default
): Map<string, ManifestCacheEntry> {
	const newCache = new Map<string, ManifestCacheEntry>()
	const cutoff = Date.now() - maxAgeMs

	for (const [key, entry] of cache.entries()) {
		// Keep entries that are still fetching or are recent enough
		if (entry.fetchPromise || entry.fetchedAt > cutoff) {
			newCache.set(key, entry)
		}
	}

	const pruned = cache.size - newCache.size
	if (pruned > 0) {
		logger.info(`[ManagedIndexer] Pruned ${pruned} old manifest cache entries`)
	}

	return newCache
}
