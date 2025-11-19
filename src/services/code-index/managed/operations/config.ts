// Pure functions for configuration operations

import { Setter } from "jotai"
import { ContextProxy } from "../../../../core/config/ContextProxy"
import { OrganizationService } from "../../../kilocode/OrganizationService"
import { KiloOrganization } from "../../../../shared/kilocode/organization"
import { configTokenAtom, configOrganizationIdAtom, configTesterWarningsDisabledUntilAtom } from "../state/atoms"
import { ConfigState } from "../state/types"

/**
 * Load configuration from ContextProxy into atoms
 */
export async function loadConfiguration(contextProxy: ContextProxy, set: Setter): Promise<void> {
	const token = contextProxy.getSecret("kilocodeToken")
	const organizationId = contextProxy.getValue("kilocodeOrganizationId")
	const testerWarnings = contextProxy.getValue("kilocodeTesterWarningsDisabledUntil")

	set(configTokenAtom, token ?? null)
	set(configOrganizationIdAtom, organizationId ?? null)
	set(configTesterWarningsDisabledUntilAtom, testerWarnings ?? null)
}

/**
 * Fetch organization from the API
 */
export async function fetchOrganization(config: ConfigState): Promise<KiloOrganization | null> {
	if (!config.token || !config.organizationId) {
		return null
	}

	return OrganizationService.fetchOrganization(
		config.token,
		config.organizationId,
		config.testerWarningsDisabledUntil ?? undefined,
	)
}

/**
 * Check if indexing is enabled for the organization
 */
export function isIndexingEnabled(org: KiloOrganization | null): boolean {
	return OrganizationService.isCodeIndexingEnabled(org)
}

/**
 * Validate configuration is complete
 */
export function isConfigValid(config: ConfigState): boolean {
	return !!(config.token && config.organizationId)
}

/**
 * Create a configuration snapshot for logging
 */
export function getConfigSnapshot(config: ConfigState): Record<string, any> {
	return {
		hasToken: !!config.token,
		hasOrganizationId: !!config.organizationId,
		testerWarningsDisabledUntil: config.testerWarningsDisabledUntil,
	}
}
