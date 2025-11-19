// Export refactored ManagedIndexer and all its modules

// Main class
export { ManagedIndexer } from "./ManagedIndexerRefactored"

// State management
export * from "./state/types"
export * from "./state/atoms"

// Operations
export * from "./operations/config"
export * from "./operations/error"
export * from "./operations/workspace"
export * from "./operations/manifest"
export * from "./operations/file-upsert"
export * from "./operations/git-events"

// Re-export existing types that are still used
export type { ServerManifest, ManifestFileEntry } from "./types"
