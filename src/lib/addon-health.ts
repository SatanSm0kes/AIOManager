
import { SavedAddon } from '@/types/saved-addon'

/**
 * Check if an addon URL is accessible
 * @param addonUrl The addon install URL
 * @returns true if online (200 response), false otherwise
 */
export async function checkAddonHealth(addonUrl: string): Promise<boolean> {
  let domain = addonUrl;
  try { domain = new URL(addonUrl).origin } catch (e) { }

  const performCheck = async (target: string, timeoutMs: number) => {
    try {
      const controller = new AbortController()
      const id = setTimeout(() => controller.abort(), timeoutMs)

      // Priority 1: HEAD
      const response = await fetch(target, {
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-cache'
      })

      if (response.ok || response.status === 405) {
        clearTimeout(id)
        return true
      }

      // Priority 2: GET
      const response2 = await fetch(target, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-cache'
      })

      clearTimeout(id)
      return response2.ok
    } catch (error) {
      return false
    }
  }

  // 1. Silent Domain-Only Check (Anti-Flood)
  if (await performCheck(domain, 15000)) {
    return true
  }

  // 2. Definitive Manifest Check (Fallback)
  // Ensures we don't have false positives if the domain root is blocked.
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`
  if (await performCheck(manifestUrl, 15000)) {
    return true
  }

  // 3. Final Proxy Fallback (AllOrigins) - Last resort
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(domain)}`
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(proxyUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-cache'
    })

    clearTimeout(id)
    return response.ok
  } catch (err) {
    return false
  }
}

/**
 * Update a saved addon with health status
 */
export async function updateAddonHealth(addon: SavedAddon): Promise<SavedAddon> {
  const isOnline = await checkAddonHealth(addon.installUrl)

  return {
    ...addon,
    health: {
      isOnline,
      lastChecked: Date.now(),
    },
  }
}

/**
 * Check health for multiple addons with concurrency control
 * @param addons Array of saved addons to check
 * @param onProgress Optional callback for progress updates
 * @returns Array of addons with updated health status
 */
export async function checkAllAddonsHealth(
  addons: SavedAddon[],
  onProgress?: (completed: number, total: number) => void
): Promise<SavedAddon[]> {
  const CONCURRENT_LIMIT = 5
  const results: SavedAddon[] = [...addons]
  const domainHealthCache: Record<string, boolean> = {}
  const PENDING_CHECKS: Record<string, Promise<boolean>> = {}

  for (let i = 0; i < addons.length; i += CONCURRENT_LIMIT) {
    const batch = addons.slice(i, i + CONCURRENT_LIMIT)

    await Promise.all(batch.map(async (addon, batchIndex) => {
      const globalIndex = i + batchIndex

      let origin = ''
      try {
        origin = new URL(addon.installUrl).origin
      } catch (e) {
        origin = addon.installUrl
      }

      let isOnline: boolean
      if (domainHealthCache[origin] === true) {
        isOnline = true
      } else {
        // Use shared promise for in-flight checks to the same origin
        if (!PENDING_CHECKS[origin]) {
          PENDING_CHECKS[origin] = checkAddonHealth(addon.installUrl).then(status => {
            if (status) {
              domainHealthCache[origin] = true
            }
            // Temporarily keep it in the cache to collapse other simultaneous requests
            setTimeout(() => delete PENDING_CHECKS[origin], 2000)
            return status
          })
        }

        const sharedStatus = await PENDING_CHECKS[origin]
        if (sharedStatus) {
          isOnline = true
        } else {
          // If the shared/first check failed, don't assume everyone on this domain is dead.
          // This specific addon gets to try its own URL as a fallback.
          isOnline = await checkAddonHealth(addon.installUrl)
          if (isOnline) {
            domainHealthCache[origin] = true
          }
        }
      }

      results[globalIndex] = {
        ...addon,
        health: {
          isOnline,
          lastChecked: Date.now(),
        },
      }
    }))

    // Report progress
    if (onProgress) {
      onProgress(Math.min(i + CONCURRENT_LIMIT, addons.length), addons.length)
    }
  }

  return results
}

/**
 * Get health summary statistics
 */
export function getHealthSummary(addons: SavedAddon[]): {
  online: number
  offline: number
  unchecked: number
} {
  let online = 0
  let offline = 0
  let unchecked = 0

  for (const addon of addons) {
    if (!addon.health) {
      unchecked++
    } else if (addon.health.isOnline) {
      online++
    } else {
      offline++
    }
  }

  return { online, offline, unchecked }
}

/**
 * Perform a deep functional check on an addon
 * 1. Fetches manifest
 * 2. Fetches a catalog (if available) or a meta item (Big Buck Bunny) to verify response data
 */
export async function checkAddonFunctionality(addonUrl: string): Promise<{ isHealthy: boolean; message?: string; latency?: number }> {
  const start = Date.now()
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`

  try {
    // 1. Fetch Manifest
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    // Check direct first, then proxy (simplified for this snippet, reusing logic would be better)
    let manifest: any = null
    try {
      const res = await fetch(manifestUrl, { signal: controller.signal })
      if (res.ok) manifest = await res.json()
    } catch {
      // Try proxy
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(manifestUrl)}`
      const res = await fetch(proxyUrl, { signal: controller.signal })
      if (res.ok) manifest = await res.json()
    }
    clearTimeout(id)

    if (!manifest) return { isHealthy: false, message: "Manifest unreachable" }

    // 2. Determine Verification Capability
    // Priority: Catalog (easiest) -> Stream (needs ID) -> Meta (needs ID)
    let verifyUrl = ''

    if (manifest.catalogs && manifest.catalogs.length > 0) {
      const cat = manifest.catalogs[0]
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/catalog/${cat.type}/${cat.id}.json`
    } else if (manifest.resources && (manifest.resources.includes('stream') || manifest.resources.some((r: any) => r.name === 'stream'))) {
      // Try Big Buck Bunny (tt0054215)
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/stream/movie/tt0054215.json`
    }

    if (!verifyUrl) {
      return { isHealthy: true, message: "Manifest OK (No verifiable resources found)", latency: Date.now() - start }
    }

    // 3. Fetch Verification Resource
    const vController = new AbortController()
    const vId = setTimeout(() => vController.abort(), 10000)

    let verifySuccess = false
    try {
      const res = await fetch(verifyUrl, { signal: vController.signal })
      if (res.ok) {
        const data = await res.json()
        if (data.metas || data.streams) verifySuccess = true
      }
    } catch {
      // Try proxy
      const proxyVerifyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(verifyUrl)}`
      const res = await fetch(proxyVerifyUrl, { signal: vController.signal })
      if (res.ok) {
        const data = await res.json()
        if (data.metas || data.streams) verifySuccess = true
      }
    }
    clearTimeout(vId)

    if (verifySuccess) {
      return { isHealthy: true, message: "Functional (Returned Data)", latency: Date.now() - start }
    } else {
      return { isHealthy: false, message: "Manifest OK but Resource Fetch Failed" }
    }

  } catch (err) {
    return { isHealthy: false, message: err instanceof Error ? err.message : "Unknown Error" }
  }
}
