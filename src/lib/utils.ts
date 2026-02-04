import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email
  const [local, domain] = email.split('@')
  if (local.length <= 3) return `***@${domain}`
  return `${local.substring(0, 3)}***@${domain}`
}

export function maskString(str: string): string {
  if (!str) return ''
  if (str.length <= 8) return '********'
  return `${str.substring(0, 4)}****${str.substring(str.length - 4)}`
}

export function maskUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname
    return `${urlObj.protocol}//${hostname}/********`
  } catch {
    return '********'
  }
}

export function getStremioLink(url: string): string {
  return url.replace(/^https?:\/\//, 'stremio://')
}

export function getAddonConfigureUrl(installUrl: string): string {
  return installUrl.replace('manifest.json', 'configure')
}

/**
 * Normalizes an addon URL for consistent comparison.
 * Handles stremio:// protocols, trailing slashes, and manifest.json suffixes.
 * Note: Case is NOT forced here to preserve Base64 tokens; callers should .toLowerCase() if needed.
 */
export function normalizeAddonUrl(url: string): string {
  if (!url) return ''
  let normalized = url.trim()
  normalized = normalized.replace(/^stremio:\/\//i, 'https://')
  normalized = normalized.replace(/\/manifest\.json$/i, '')
  normalized = normalized.replace(/\/+$/, '')
  return normalized
}
