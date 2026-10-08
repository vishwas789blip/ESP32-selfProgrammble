import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { env } from '../config/env.js'
import { FirmwareRelease } from '../models/FirmwareRelease.js'
import { Device } from '../models/Device.js'
import { createEvent } from './eventService.js'
import { publishCommand } from './mqttService.js'
import { broadcastDeviceUpdate } from './realtimeService.js'

export function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  // 1. Prioritize real Wi-Fi or Ethernet adapter (avoid virtual adapters like WSL/Hyper-V/Docker)
  for (const name of Object.keys(interfaces)) {
    if (/vethernet|wsl|virtual|docker|hyper-v|loopback/i.test(name)) continue
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address
      }
    }
  }
  // 2. Fallback to any valid non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('.')
    .map((part) => {
      const n = parseInt(part, 10)
      return isNaN(n) ? 0 : n
    })
}

export function isNewerVersion(current: string, target: string): boolean {
  const c = parseVersion(current)
  const t = parseVersion(target)
  const len = Math.max(c.length, t.length)
  for (let i = 0; i < len; i++) {
    const cv = c[i] || 0
    const tv = t[i] || 0
    if (tv > cv) return true
    if (tv < cv) return false
  }
  return false
}

export async function listReleases() {
  return FirmwareRelease.find({ status: { $ne: 'deprecated' } })
    .sort({ releaseDate: -1, createdAt: -1 })
    .lean()
}

export async function getLatestRelease() {
  const latest = await FirmwareRelease.findOne({ isLatest: true }).lean()
  if (latest) return latest
  return FirmwareRelease.findOne({ status: 'available' })
    .sort({ releaseDate: -1 })
    .lean()
}

export async function checkDeviceUpdate(userId: string, deviceMongoId: string) {
  const device = await Device.findOne({ _id: deviceMongoId, userId })
  if (!device) {
    throw new Error('Device not found or unauthorized')
  }

  const latest = await getLatestRelease()
  const currentVersion = device.firmwareVersion || '0.0.0'
  const latestVersion = latest ? latest.version : currentVersion

  const updateAvailable = latest ? isNewerVersion(currentVersion, latestVersion) : false

  return {
    deviceId: device.deviceId,
    name: device.name,
    currentVersion,
    latestVersion,
    updateAvailable,
    release: latest,
    lastSeen: device.lastSeen,
    status: device.status,
  }
}

export async function deployOta(userId: string, deviceMongoId: string, version: string) {
  const device = await Device.findOne({ _id: deviceMongoId, userId })
  if (!device) {
    throw new Error('Device not found or unauthorized')
  }

  if (device.status !== 'online') {
    throw new Error(`Device '${device.name}' is currently offline. Connect the device before deploying firmware updates.`)
  }

  const release = await FirmwareRelease.findOne({ version })
  if (!release) {
    throw new Error(`Firmware release '${version}' not found in registry`)
  }

  const now = new Date()

  // Update device with OTA status
  const updatedDevice = await Device.findByIdAndUpdate(
    device._id,
    {
      $set: {
        otaStatus: 'deploying',
        targetFirmwareVersion: version,
        lastOtaAt: now,
      },
    },
    { new: true },
  ).lean()

  // Dispatch MQTT OTA command
  try {
    let downloadUrl = release.downloadUrl || ''
    if (!env.PUBLIC_URL && downloadUrl.includes('/api/firmware/bin/')) {
      const filename = downloadUrl.split('/api/firmware/bin/')[1]
      const realIp = getLocalIp()
      downloadUrl = `http://${realIp}:${env.PORT}/api/firmware/bin/${filename}`
    } else if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
      const realIp = getLocalIp()
      downloadUrl = downloadUrl.replace(/localhost|127\.0\.0\.1/, realIp)
    }

    console.log(`[OTA] Dispatching OTA command to ${device.deviceId}: version=${version} url=${downloadUrl}`)
    await publishCommand(device.deviceId, {
      type: 'ota',
      command: 'upgrade',
      version,
      url: downloadUrl,
      checksum: release.checksum || '',
      timestamp: now.toISOString(),
    })
    console.log(`[OTA] Successfully published OTA command to ${device.deviceId}`)
  } catch (err) {
    console.error(`[OTA] Failed to publish MQTT OTA command to ${device.deviceId}:`, err)
  }

  // Create audit event
  await createEvent({
    userId: String(device.userId),
    deviceId: String(device._id),
    type: 'system',
    message: `OTA firmware update to ${version} dispatched to node '${device.name}'`,
    metadata: { version, otaStatus: 'deploying', deviceId: device.deviceId },
  })

  // Broadcast realtime WebSocket update
  if (updatedDevice) {
    broadcastDeviceUpdate(String(device.userId), updatedDevice)
  }

  return {
    success: true,
    message: `Firmware ${version} update dispatched to ${device.name}`,
    device: updatedDevice,
  }
}

export async function createReleaseFromUpload(
  userId: string,
  data: {
    version: string
    title: string
    description?: string
    changelog?: string[]
    file: Express.Multer.File
    deviceId?: string
    autoDeploy?: boolean
  },
  serverHost?: string,
) {
  const { version, title, description, changelog, file, deviceId, autoDeploy } = data
  const normalizedVersion = version.trim().replace(/^v/i, '')

  // Calculate sha256 checksum and size
  const buffer = await fs.promises.readFile(file.path)
  const checksum = createHash('sha256').update(buffer).digest('hex')
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2) + ' MB'

  // Determine host for download URL (prefer public cloud domain if configured, else reachable IP)
  const realIp = getLocalIp()
  const resolvedHost = (serverHost && !serverHost.includes('localhost') && !serverHost.startsWith('127.0.0.1'))
    ? serverHost
    : `${realIp}:${env.PORT}`

  const downloadUrl = env.PUBLIC_URL
    ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/api/firmware/bin/${path.basename(file.path)}`
    : `http://${resolvedHost}/api/firmware/bin/${path.basename(file.path)}`

  // Demote previous latest
  await FirmwareRelease.updateMany({}, { $set: { isLatest: false } })

  const release = await FirmwareRelease.findOneAndUpdate(
    { version: normalizedVersion },
    {
      version: normalizedVersion,
      title: title.trim(),
      description: description?.trim() || 'Uploaded via Web Dashboard',
      changelog: changelog && changelog.length > 0 ? changelog : ['Direct binary upload via IoT dashboard'],
      releaseDate: new Date(),
      fileSize: sizeMB,
      downloadUrl,
      checksum,
      status: 'available',
      isLatest: true,
    },
    { upsert: true, new: true },
  )

  // Log system audit event
  await createEvent({
    userId,
    type: 'system',
    message: `New firmware binary v${normalizedVersion} registered: ${title}`,
    metadata: { version: normalizedVersion, checksum, fileSize: sizeMB, fileName: file.originalname },
  })

  let deployResult = null
  if (autoDeploy && deviceId) {
    deployResult = await deployOta(userId, deviceId, normalizedVersion)
  }

  return {
    release,
    deployResult,
  }
}
