// kilocode_change - new file
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { ManagedIndexer } from "../ManagedIndexer"
import { ContextProxy } from "../../../../core/config/ContextProxy"
import { GitWatcher, GitWatcherEvent } from "../../../../shared/GitWatcher"
import { OrganizationService } from "../../../kilocode/OrganizationService"
import * as gitUtils from "../git-utils"
import * as kiloConfigFile from "../../../../utils/kilo-config-file"
import * as git from "../../../../utils/git"
import * as apiClient from "../api-client"
import { logger } from "../../../../utils/logging"

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidChangeWorkspaceFolders: vi.fn(),
	},
	Uri: {
		file: (path: string) => ({ fsPath: path }),
	},
}))

// Mock dependencies
vi.mock("../../../../shared/GitWatcher")
vi.mock("../../../kilocode/OrganizationService")
vi.mock("../git-utils")
vi.mock("../../../../utils/kilo-config-file")
vi.mock("../../../../utils/git")
vi.mock("../api-client")
vi.mock("../../../../utils/logging", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}))
vi.mock("fs", () => ({
	promises: {
		readFile: vi.fn(),
	},
}))

describe("ManagedIndexer", () => {
	let mockContextProxy: any
	let indexer: ManagedIndexer
	let mockWorkspaceFolder: vscode.WorkspaceFolder

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock ContextProxy
		mockContextProxy = {
			getSecret: vi.fn((key: string) => {
				if (key === "kilocodeToken") return "test-token"
				return null
			}),
			getValue: vi.fn((key: string) => {
				if (key === "kilocodeOrganizationId") return "test-org-id"
				if (key === "kilocodeTesterWarningsDisabledUntil") return null
				return null
			}),
			onManagedIndexerConfigChange: vi.fn(() => ({
				dispose: vi.fn(),
			})),
		}

		// Setup mock workspace folder
		mockWorkspaceFolder = {
			uri: { fsPath: "/test/workspace" } as vscode.Uri,
			name: "test-workspace",
			index: 0,
		}

		// Default mock implementations
		vi.mocked(gitUtils.isGitRepository).mockResolvedValue(true)
		vi.mocked(gitUtils.getCurrentBranch).mockResolvedValue("main")
		vi.mocked(git.getGitRepositoryInfo).mockResolvedValue({
			repositoryUrl: "https://github.com/test/repo",
			repositoryName: "repo",
		})
		vi.mocked(kiloConfigFile.getKilocodeConfig).mockResolvedValue({
			project: { id: "test-project-id" },
		} as any)
		vi.mocked(apiClient.getServerManifest).mockResolvedValue({
			files: [],
		} as any)

		// Mock OrganizationService
		vi.mocked(OrganizationService.fetchOrganization).mockResolvedValue({
			id: "test-org-id",
			name: "Test Org",
		} as any)
		vi.mocked(OrganizationService.isCodeIndexingEnabled).mockReturnValue(true)

		// Mock GitWatcher
		vi.mocked(GitWatcher).mockImplementation(() => {
			const mockWatcher = {
				config: { cwd: "/test/workspace" },
				onEvent: vi.fn(),
				scan: vi.fn().mockResolvedValue(undefined),
				start: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
			}
			return mockWatcher as any
		})

		indexer = new ManagedIndexer(mockContextProxy)
	})

	afterEach(() => {
		indexer.dispose()
	})

	describe("constructor", () => {
		it("should create a ManagedIndexer instance", () => {
			expect(indexer).toBeInstanceOf(ManagedIndexer)
		})

		it("should subscribe to configuration changes", () => {
			expect(mockContextProxy.onManagedIndexerConfigChange).toHaveBeenCalled()
		})

		it("should initialize with empty workspaceFolderState", () => {
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should initialize with isActive false", () => {
			expect(indexer.isActive).toBe(false)
		})
	})

	describe("fetchConfig", () => {
		it("should fetch config from ContextProxy", async () => {
			const config = await indexer.fetchConfig()

			expect(mockContextProxy.getSecret).toHaveBeenCalledWith("kilocodeToken")
			expect(mockContextProxy.getValue).toHaveBeenCalledWith("kilocodeOrganizationId")
			expect(mockContextProxy.getValue).toHaveBeenCalledWith("kilocodeTesterWarningsDisabledUntil")
			expect(config).toEqual({
				kilocodeOrganizationId: "test-org-id",
				kilocodeToken: "test-token",
				kilocodeTesterWarningsDisabledUntil: null,
			})
		})

		it("should store config in instance", async () => {
			await indexer.fetchConfig()

			expect(indexer.config).toEqual({
				kilocodeOrganizationId: "test-org-id",
				kilocodeToken: "test-token",
				kilocodeTesterWarningsDisabledUntil: null,
			})
		})

		it("should handle missing config values", async () => {
			mockContextProxy.getSecret.mockReturnValue(null)
			mockContextProxy.getValue.mockReturnValue(null)

			const config = await indexer.fetchConfig()

			expect(config).toEqual({
				kilocodeOrganizationId: null,
				kilocodeToken: null,
				kilocodeTesterWarningsDisabledUntil: null,
			})
		})
	})

	describe("fetchOrganization", () => {
		it("should fetch organization when token and org ID are present", async () => {
			const org = await indexer.fetchOrganization()

			expect(OrganizationService.fetchOrganization).toHaveBeenCalledWith("test-token", "test-org-id", undefined)
			expect(org).toEqual({
				id: "test-org-id",
				name: "Test Org",
			})
		})

		it("should return null when token is missing", async () => {
			mockContextProxy.getSecret.mockReturnValue(null)

			const org = await indexer.fetchOrganization()

			expect(OrganizationService.fetchOrganization).not.toHaveBeenCalled()
			expect(org).toBeNull()
		})

		it("should return null when org ID is missing", async () => {
			mockContextProxy.getValue.mockImplementation((key: string) => {
				if (key === "kilocodeOrganizationId") return null
				if (key === "kilocodeTesterWarningsDisabledUntil") return null
				return null
			})

			const org = await indexer.fetchOrganization()

			expect(OrganizationService.fetchOrganization).not.toHaveBeenCalled()
			expect(org).toBeNull()
		})

		it("should store organization in instance", async () => {
			await indexer.fetchOrganization()

			expect(indexer.organization).toEqual({
				id: "test-org-id",
				name: "Test Org",
			})
		})
	})

	describe("isEnabled", () => {
		it("should return true when organization exists and feature is enabled", async () => {
			const enabled = await indexer.isEnabled()

			expect(enabled).toBe(true)
		})

		it("should return false when organization does not exist", async () => {
			vi.mocked(OrganizationService.fetchOrganization).mockResolvedValue(null)

			const enabled = await indexer.isEnabled()

			expect(enabled).toBe(false)
		})

		it("should return false when code indexing is not enabled", async () => {
			vi.mocked(OrganizationService.isCodeIndexingEnabled).mockReturnValue(false)

			const enabled = await indexer.isEnabled()

			expect(enabled).toBe(false)
		})
	})

	describe("start", () => {
		beforeEach(() => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
		})

		it("should not start when no workspace folders exist", async () => {
			vi.mocked(vscode.workspace).workspaceFolders = []

			await indexer.start()

			expect(indexer.isActive).toBe(false)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should not start when feature is not enabled", async () => {
			vi.mocked(OrganizationService.isCodeIndexingEnabled).mockReturnValue(false)

			await indexer.start()

			expect(indexer.isActive).toBe(false)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should not start when token is missing", async () => {
			mockContextProxy.getSecret.mockReturnValue(null)

			await indexer.start()

			expect(indexer.isActive).toBe(false)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should not start when organization ID is missing", async () => {
			mockContextProxy.getValue.mockImplementation((key: string) => {
				if (key === "kilocodeOrganizationId") return null
				return null
			})

			await indexer.start()

			expect(indexer.isActive).toBe(false)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should skip non-git repositories", async () => {
			vi.mocked(gitUtils.isGitRepository).mockResolvedValue(false)

			await indexer.start()

			expect(indexer.isActive).toBe(true)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should skip folders without project ID", async () => {
			vi.mocked(kiloConfigFile.getKilocodeConfig).mockResolvedValue(null)

			await indexer.start()

			expect(indexer.isActive).toBe(true)
			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should create workspaceFolderState for valid workspace folders", async () => {
			await indexer.start()

			expect(indexer.isActive).toBe(true)
			expect(indexer.workspaceFolderState).toHaveLength(1)

			const state = indexer.workspaceFolderState[0]
			expect(state.gitBranch).toBe("main")
			expect(state.projectId).toBe("test-project-id")
			expect(state.isIndexing).toBe(false)
			expect(state.watcher).toBeDefined()
			expect(state.workspaceFolder).toBe(mockWorkspaceFolder)
		})

		it("should register event handler for each watcher", async () => {
			await indexer.start()

			const mockWatcher = indexer.workspaceFolderState[0].watcher
			expect(mockWatcher).toBeDefined()
			expect(mockWatcher!.onEvent).toHaveBeenCalled()
		})

		it("should perform initial scan for each watcher", async () => {
			await indexer.start()

			const mockWatcher = indexer.workspaceFolderState[0].watcher
			expect(mockWatcher).toBeDefined()
			expect(mockWatcher!.scan).toHaveBeenCalled()
		})

		it("should start each watcher", async () => {
			await indexer.start()

			const mockWatcher = indexer.workspaceFolderState[0].watcher
			expect(mockWatcher).toBeDefined()
			expect(mockWatcher!.start).toHaveBeenCalled()
		})

		it("should handle multiple workspace folders", async () => {
			const folder2 = {
				uri: { fsPath: "/test/workspace2" } as vscode.Uri,
				name: "test-workspace-2",
				index: 1,
			}

			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder, folder2]

			vi.mocked(kiloConfigFile.getKilocodeConfig).mockImplementation(async (cwd) => {
				if (cwd === "/test/workspace") {
					return { project: { id: "project-1" } } as any
				}
				return { project: { id: "project-2" } } as any
			})

			await indexer.start()

			expect(indexer.workspaceFolderState).toHaveLength(2)
			expect(indexer.workspaceFolderState[0].projectId).toBe("project-1")
			expect(indexer.workspaceFolderState[1].projectId).toBe("project-2")
		})

		describe("error handling", () => {
			it("should capture git errors and create state with error", async () => {
				vi.mocked(git.getGitRepositoryInfo).mockRejectedValue(new Error("Git command failed"))

				await indexer.start()

				expect(indexer.workspaceFolderState).toHaveLength(1)
				const state = indexer.workspaceFolderState[0]
				expect(state.error).toBeDefined()
				expect(state.error?.type).toBe("git")
				expect(state.error?.message).toContain("Failed to get git information")
				expect(state.error?.timestamp).toBeDefined()
				expect(state.gitBranch).toBeNull()
				expect(state.projectId).toBeNull()
				expect(state.manifest).toBeNull()
				expect(state.watcher).toBeNull()
			})

			it("should capture manifest fetch errors and create partial state", async () => {
				vi.mocked(apiClient.getServerManifest).mockRejectedValue(new Error("API error"))

				await indexer.start()

				expect(indexer.workspaceFolderState).toHaveLength(1)
				const state = indexer.workspaceFolderState[0]
				expect(state.error).toBeDefined()
				expect(state.error?.type).toBe("manifest")
				expect(state.error?.message).toContain("Failed to fetch server manifest")
				expect(state.error?.context?.branch).toBe("main")
				expect(state.gitBranch).toBe("main")
				expect(state.projectId).toBe("test-project-id")
				expect(state.manifest).toBeNull()
				expect(state.watcher).toBeNull()
			})

			it("should capture watcher start errors and create partial state", async () => {
				vi.mocked(GitWatcher).mockImplementation(() => {
					throw new Error("Watcher initialization failed")
				})

				await indexer.start()

				expect(indexer.workspaceFolderState).toHaveLength(1)
				const state = indexer.workspaceFolderState[0]
				expect(state.error).toBeDefined()
				expect(state.error?.type).toBe("scan")
				expect(state.error?.message).toContain("Failed to start file watcher")
				expect(state.gitBranch).toBe("main")
				expect(state.projectId).toBe("test-project-id")
				expect(state.manifest).toBeDefined()
				expect(state.watcher).toBeNull()
			})

			it("should include error details in error object", async () => {
				const testError = new Error("Test error")
				testError.stack = "Error: Test error\n    at test.ts:1:1"
				vi.mocked(git.getGitRepositoryInfo).mockRejectedValue(testError)

				await indexer.start()

				const state = indexer.workspaceFolderState[0]
				expect(state.error?.details).toContain("Error: Test error")
				expect(state.error?.details).toContain("at test.ts:1:1")
			})

			it("should handle non-Error objects in catch blocks", async () => {
				vi.mocked(git.getGitRepositoryInfo).mockRejectedValue("String error")

				await indexer.start()

				const state = indexer.workspaceFolderState[0]
				expect(state.error?.message).toContain("String error")
				expect(state.error?.details).toBeUndefined()
			})
		})
	})

	describe("dispose", () => {
		it("should dispose all watchers", async () => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
			await indexer.start()

			const mockWatcher = indexer.workspaceFolderState[0].watcher
			expect(mockWatcher).toBeDefined()

			indexer.dispose()

			expect(mockWatcher!.dispose).toHaveBeenCalled()
		})

		it("should clear workspaceFolderState", async () => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
			await indexer.start()

			indexer.dispose()

			expect(indexer.workspaceFolderState).toEqual([])
		})

		it("should set isActive to false", async () => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
			await indexer.start()

			indexer.dispose()

			expect(indexer.isActive).toBe(false)
		})

		it("should dispose workspaceFoldersListener if present", () => {
			const mockDispose = vi.fn()
			indexer.workspaceFoldersListener = { dispose: mockDispose } as any

			indexer.dispose()

			expect(mockDispose).toHaveBeenCalled()
			expect(indexer.workspaceFoldersListener).toBeNull()
		})

		it("should dispose configChangeListener", () => {
			const mockDispose = vi.fn()
			indexer.configChangeListener = { dispose: mockDispose } as any

			indexer.dispose()

			expect(mockDispose).toHaveBeenCalled()
			expect(indexer.configChangeListener).toBeNull()
		})
	})

	describe("onEvent", () => {
		let mockWatcher: any
		let state: any

		beforeEach(async () => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
			await indexer.start()

			state = indexer.workspaceFolderState[0]
			mockWatcher = state.watcher
		})

		it("should not process events when not active", async () => {
			indexer.isActive = false

			const event: GitWatcherEvent = {
				type: "scan-start",
				branch: "main",
				isBaseBranch: true,
				watcher: mockWatcher,
			}

			await indexer.onEvent(event)

			expect(state.isIndexing).toBe(false)
		})

		it("should warn when event is from unknown watcher", async () => {
			const unknownWatcher = new GitWatcher({ cwd: "/unknown" })

			const event: GitWatcherEvent = {
				type: "scan-start",
				branch: "main",
				isBaseBranch: true,
				watcher: unknownWatcher,
			}

			await indexer.onEvent(event)

			expect(logger.warn).toHaveBeenCalledWith("[ManagedIndexer] Received event for unknown watcher")
		})

		describe("scan-start event", () => {
			it("should set isIndexing to true", async () => {
				const event: GitWatcherEvent = {
					type: "scan-start",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				expect(state.isIndexing).toBe(true)
				expect(logger.info).toHaveBeenCalledWith("[ManagedIndexer] Scan started on branch main")
			})
		})

		describe("scan-end event", () => {
			it("should set isIndexing to false", async () => {
				state.isIndexing = true

				const event: GitWatcherEvent = {
					type: "scan-end",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				expect(state.isIndexing).toBe(false)
				expect(logger.info).toHaveBeenCalledWith("[ManagedIndexer] Scan completed on branch main")
			})
		})

		describe("file-deleted event", () => {
			it("should log file deletion", async () => {
				const event: GitWatcherEvent = {
					type: "file-deleted",
					filePath: "deleted.ts",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				expect(logger.info).toHaveBeenCalledWith("[ManagedIndexer] File deleted: deleted.ts on branch main")
			})
		})

		describe("file-changed event", () => {
			it("should skip already indexed files", async () => {
				state.manifest = {
					files: [{ filePath: "test.ts", fileHash: "abc123" }],
				}

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "test.ts",
					fileHash: "abc123",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				expect(apiClient.upsertFile).not.toHaveBeenCalled()
			})

			it("should upsert new files", async () => {
				const fs = await import("fs")
				vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("file content"))

				state.manifest = { files: [] }

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "new-file.ts",
					fileHash: "def456",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				// Wait for async file upsert to complete
				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(apiClient.upsertFile).toHaveBeenCalledWith({
					fileBuffer: expect.any(Buffer),
					fileHash: "def456",
					filePath: "new-file.ts",
					gitBranch: "main",
					isBaseBranch: true,
					organizationId: "test-org-id",
					projectId: "test-project-id",
					kilocodeToken: "test-token",
				})
			})

			it("should handle absolute file paths", async () => {
				const fs = await import("fs")
				vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("file content"))

				state.manifest = { files: [] }

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "/test/workspace/absolute-file.ts",
					fileHash: "ghi789",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(apiClient.upsertFile).toHaveBeenCalledWith(
					expect.objectContaining({
						filePath: "absolute-file.ts",
					}),
				)
			})

			it("should skip upsert when token is missing", async () => {
				indexer.config = {
					kilocodeOrganizationId: "test-org-id",
					kilocodeToken: null,
					kilocodeTesterWarningsDisabledUntil: null,
				}

				state.manifest = { files: [] }

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "test.ts",
					fileHash: "abc123",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(logger.warn).toHaveBeenCalledWith(
					"[ManagedIndexer] Missing token or organization ID, skipping file upsert",
				)
				expect(apiClient.upsertFile).not.toHaveBeenCalled()
			})

			it("should handle file read errors", async () => {
				const fs = await import("fs")
				vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("File not found"))

				state.manifest = { files: [] }

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "missing.ts",
					fileHash: "xyz999",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(logger.error).toHaveBeenCalledWith(
					expect.stringContaining("[ManagedIndexer] Failed to upsert file missing.ts"),
				)
			})

			it("should handle API errors", async () => {
				const fs = await import("fs")
				vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("file content"))
				vi.mocked(apiClient.upsertFile).mockRejectedValue(new Error("API error"))

				state.manifest = { files: [] }

				const event: GitWatcherEvent = {
					type: "file-changed",
					filePath: "test.ts",
					fileHash: "abc123",
					branch: "main",
					isBaseBranch: true,
					watcher: mockWatcher,
				}

				await indexer.onEvent(event)

				await new Promise((resolve) => setTimeout(resolve, 10))

				expect(logger.error).toHaveBeenCalledWith(
					expect.stringContaining("[ManagedIndexer] Failed to upsert file test.ts: API error"),
				)
			})
		})
	})

	describe("onDidChangeWorkspaceFolders", () => {
		it("should dispose and restart", async () => {
			vi.mocked(vscode.workspace).workspaceFolders = [mockWorkspaceFolder]
			await indexer.start()

			const disposeSpy = vi.spyOn(indexer, "dispose")
			const startSpy = vi.spyOn(indexer, "start")

			const event = {
				added: [],
				removed: [],
			} as vscode.WorkspaceFoldersChangeEvent

			await indexer.onDidChangeWorkspaceFolders(event)

			expect(disposeSpy).toHaveBeenCalled()
			expect(startSpy).toHaveBeenCalled()
		})
	})

	describe("workspaceFolderState tracking", () => {
		it("should maintain separate state for each workspace folder", async () => {
			const folder1 = mockWorkspaceFolder
			const folder2 = {
				uri: { fsPath: "/test/workspace2" } as vscode.Uri,
				name: "test-workspace-2",
				index: 1,
			}

			vi.mocked(vscode.workspace).workspaceFolders = [folder1, folder2]

			vi.mocked(kiloConfigFile.getKilocodeConfig).mockImplementation(async (cwd) => {
				if (cwd === "/test/workspace") {
					return { project: { id: "project-1" } } as any
				}
				return { project: { id: "project-2" } } as any
			})

			vi.mocked(gitUtils.getCurrentBranch).mockImplementation(async (cwd) => {
				if (cwd === "/test/workspace") {
					return "main"
				}
				return "develop"
			})

			await indexer.start()

			expect(indexer.workspaceFolderState).toHaveLength(2)

			const state1 = indexer.workspaceFolderState[0]
			const state2 = indexer.workspaceFolderState[1]

			expect(state1.projectId).toBe("project-1")
			expect(state1.gitBranch).toBe("main")
			expect(state1.isIndexing).toBe(false)

			expect(state2.projectId).toBe("project-2")
			expect(state2.gitBranch).toBe("develop")
			expect(state2.isIndexing).toBe(false)
		})

		it("should update isIndexing independently for each workspace", async () => {
			const folder1 = mockWorkspaceFolder
			const folder2 = {
				uri: { fsPath: "/test/workspace2" } as vscode.Uri,
				name: "test-workspace-2",
				index: 1,
			}

			vi.mocked(vscode.workspace).workspaceFolders = [folder1, folder2]

			vi.mocked(kiloConfigFile.getKilocodeConfig).mockImplementation(async (cwd) => {
				if (cwd === "/test/workspace") {
					return { project: { id: "project-1" } } as any
				}
				return { project: { id: "project-2" } } as any
			})

			await indexer.start()

			const state1 = indexer.workspaceFolderState[0]
			const state2 = indexer.workspaceFolderState[1]

			// Start scan on first workspace
			expect(state1.watcher).toBeDefined()
			await indexer.onEvent({
				type: "scan-start",
				branch: "main",
				isBaseBranch: true,
				watcher: state1.watcher!,
			})

			expect(state1.isIndexing).toBe(true)
			expect(state2.isIndexing).toBe(false)

			// End scan on first workspace
			await indexer.onEvent({
				type: "scan-end",
				branch: "main",
				isBaseBranch: true,
				watcher: state1.watcher!,
			})

			expect(state1.isIndexing).toBe(false)
			expect(state2.isIndexing).toBe(false)
		})
	})
})
