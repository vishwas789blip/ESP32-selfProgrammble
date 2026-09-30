import { env } from '../config/env.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { createEvent } from './eventService.js'
import { broadcastDeviceStatus } from './realtimeService.js'

const SWEEP_INTERVAL_MS = 15_000

let timer: NodeJS.Timeout | null = null

/**
 * Marks devices that are 'online' but silent for DEVICE_OFFLINE_TIMEOUT_SEC as
 * offline. Without this, a device that loses power or Wi-Fi without publishing its
 * own "offline" message (a Last Will, if the firmware even sets one) stays 'online'
 * forever, and so does every device after the backend itself was down.
 */
export async function markStaleDevicesOffline(now: Date = new Date()): Promise<number> {
  const timeoutSec = env.DEVICE_OFFLINE_TIMEOUT_SEC
  if (timeoutSec <= 0) return 0

  const cutoff = new Date(now.getTime() - timeoutSec * 1000)
  const isStale = { $or: [{ lastSeen: { $lt: cutoff } }, { lastSeen: null }] }

  const stale = await Device.find({ status: 'online', ...isStale })
  let changed = 0

  for (const device of stale) {
    // Same staleness condition in the update: if fresh telemetry arrived since the
    // find(), lastSeen moved forward, nothing matches and the device stays online.
    const result = await Device.updateOne(
      { _id: device._id, status: 'online', ...isStale },
      { $set: { status: 'offline' } },
    )
    if (result.modifiedCount !== 1) continue
    changed++

    broadcastDeviceStatus(String(device.userId), device.deviceId, 'offline', { reason: 'timeout' })

    try {
      await createEvent({
        userId: String(device.userId),
        deviceId: String(device._id),
        type: 'system',
        message: `Device offline (no data for ${timeoutSec}s)`,
        metadata: { reason: 'timeout' },
      })
    } catch (error) {
      console.error('[MONITOR] Could not store offline event:', error instanceof Error ? error.message : error)
    }
  }

  // Sensor freshness is tracked independently from device heartbeat. A device can
  // still publish telemetry while one configured sensor stops reporting.
  const sensorStaleCutoff = cutoff
  const staleSensors = await Sensor.find({
    healthStatus: { $in: ['healthy'] },
    lastUpdated: { $lt: sensorStaleCutoff },
  }).select('_id deviceId name lastUpdated')

  if (staleSensors.length > 0) {
    await Sensor.updateMany(
      {
        _id: { $in: staleSensors.map((sensor) => sensor._id) },
        healthStatus: 'healthy',
        lastUpdated: { $lt: sensorStaleCutoff },
      },
      { $set: { healthStatus: 'stale' } },
    )

    for (const sensor of staleSensors) {
      console.log(
        `[MONITOR] Sensor stale: ${sensor.name} (${String(sensor._id)}) ` +
        `no telemetry for ${timeoutSec}s`,
      )
    }
  }

  if (changed > 0) console.log(`[MONITOR] Marked ${changed} device(s) offline (no data for ${timeoutSec}s)`)
  return changed
}

export function startDeviceMonitor() {
  if (timer || env.DEVICE_OFFLINE_TIMEOUT_SEC <= 0) return

  timer = setInterval(() => {
    markStaleDevicesOffline().catch(error =>
      console.error('[MONITOR] Sweep failed:', error instanceof Error ? error.message : error),
    )
  }, SWEEP_INTERVAL_MS)
  timer.unref()

  console.log(`[MONITOR] Devices are marked offline after ${env.DEVICE_OFFLINE_TIMEOUT_SEC}s without data`)
}

export function stopDeviceMonitor() {
  if (timer) clearInterval(timer)
  timer = null
}
