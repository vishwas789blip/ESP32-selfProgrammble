import { createHash } from 'node:crypto'
import { Types } from 'mongoose'
import {
  mqttClient,
  topics,
  deviceIdFromTopic,
  type DeviceTopicKind,
} from '../config/mqtt.js'
import { env } from '../config/env.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
import { Automation } from '../models/Automation.js'
import { createEvent } from './eventService.js'
import {
  telemetrySchema,
  statusSchema,
  commandSchema,
  configSchema,
  configAckSchema,
} from '../validations/mqttSchemas.js'
import { evaluateAutomations } from './automationService.js'
import {
  broadcastDeviceTelemetry,
  broadcastDeviceStatus,
  broadcastDeviceUpdate,
  broadcastSensorUpdate,
  broadcastActuatorUpdate,
} from './realtimeService.js'
import { publishMessage } from './mqttPublisher.js'

/* -------------------------------------------------------------------------- */
/* Logging                                                                    */
/* -------------------------------------------------------------------------- */

const log = (message: string, error?: unknown) => {
  if (error === undefined) {
    console.log(`[MQTT] ${message}`)
    return
  }

  const detail = error instanceof Error ? error.message : String(error)
  console.error(`[MQTT] ${message}${detail ? `: ${detail}` : ''}`)
}

const logConfig = (message: string, error?: unknown) => {
  if (error === undefined) {
    console.log(`[CONFIG] ${message}`)
    return
  }

  const detail = error instanceof Error ? error.message : String(error)
  console.error(`[CONFIG] ${message}${detail ? `: ${detail}` : ''}`)
}

/**
 * "Unknown device" messages can arrive many times per second from a stray
 * publisher (or from a device whose DEVICE_ID does not match MongoDB). Each
 * unknown (kind, deviceId) pair is logged at most once per minute, but every
 * log line carries enough context to find the cause: topic, payload snippet and
 * a hint about what is registered in MongoDB.
 */
const UNKNOWN_DEVICE_LOG_INTERVAL_MS = 60_000
const unknownDeviceState = new Map<string, { last: number; suppressed: number }>()

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function unknownDeviceHint(topicDeviceId: string): Promise<string> {
  const trimmed = topicDeviceId.trim()
  const notes: string[] = []

  if (trimmed !== topicDeviceId) {
    notes.push('the id contains leading/trailing whitespace')
  }

  const [nearMatches, total] = await Promise.all([
    Device.find({ deviceId: new RegExp(`^${escapeRegex(trimmed)}$`, 'i') })
      .select('deviceId')
      .limit(3)
      .lean(),
    Device.countDocuments(),
  ])

  if (nearMatches.length > 0) {
    notes.push(
      `MongoDB has a near-identical id (${nearMatches
        .map((device) => `"${device.deviceId}"`)
        .join(', ')}); ids are case-sensitive, so make firmware DEVICE_ID and the dashboard deviceId exactly equal`,
    )
  } else if (total === 0) {
    notes.push('no devices are registered in MongoDB yet; create the device on the dashboard first')
  } else {
    notes.push(
      `${total} device(s) registered but none equals this id; register it on the dashboard or fix DEVICE_ID in the firmware`,
    )
  }

  return notes.join('; ')
}

async function logUnknownDevice(
  topicDeviceId: string,
  kind: DeviceTopicKind,
  raw?: unknown,
) {
  const key = `${kind}:${topicDeviceId}`
  const now = Date.now()
  const state = unknownDeviceState.get(key) ?? { last: 0, suppressed: 0 }

  if (now - state.last < UNKNOWN_DEVICE_LOG_INTERVAL_MS) {
    state.suppressed += 1
    unknownDeviceState.set(key, state)
    return
  }

  const suppressed = state.suppressed
  unknownDeviceState.set(key, { last: now, suppressed: 0 })

  let snippet = ''
  try {
    snippet = JSON.stringify(raw ?? null).slice(0, 200)
  } catch {
    snippet = '<unserializable>'
  }

  let hint = ''
  try {
    hint = await unknownDeviceHint(topicDeviceId)
  } catch (error) {
    hint = `could not query MongoDB (${error instanceof Error ? error.message : String(error)})`
  }

  log(
    `Unknown device message: id="${topicDeviceId}" kind=${kind} ` +
      `topic=devices/${topicDeviceId}/${kind} payload=${snippet} | ${hint}` +
      (suppressed > 0 ? ` | ${suppressed} similar message(s) suppressed` : ''),
  )
}

/**
 * "Device recognized" is logged once per device per backend MQTT session (and
 * again after the device goes offline / the broker reconnects). "Telemetry
 * received" is rate-limited so it confirms the pipeline without flooding.
 */
const recognizedDevices = new Set<string>()

function logRecognized(deviceId: string) {
  if (recognizedDevices.has(deviceId)) return

  recognizedDevices.add(deviceId)
  log(`Device recognized: ${deviceId}`)
}

const TELEMETRY_LOG_INTERVAL_MS = 60_000
const telemetryLastLogged = new Map<string, number>()

function logTelemetryReceived(deviceId: string, readingCount: number) {
  const now = Date.now()
  if (now - (telemetryLastLogged.get(deviceId) ?? 0) < TELEMETRY_LOG_INTERVAL_MS) return

  telemetryLastLogged.set(deviceId, now)
  log(`Telemetry received: ${deviceId} (${readingCount} reading(s))`)
}

let started = false

/* -------------------------------------------------------------------------- */
/* Local types                                                                */
/* -------------------------------------------------------------------------- */

type AutomationCondition = {
  sensorId: Types.ObjectId
  operator: string
  value: unknown
}

type AutomationAction = {
  actuatorId: Types.ObjectId
  command: string
  value?: unknown
  duration?: number
  parameters?: Record<string, unknown>
}

type DeviceAutomation = {
  _id: Types.ObjectId
  name: string
  enabled: boolean
  conditions: AutomationCondition[]
  actions: AutomationAction[]
}

type DeviceLike = {
  _id: Types.ObjectId
  deviceId: string
  userId: Types.ObjectId
}

/* -------------------------------------------------------------------------- */
/* MQTT publish helpers                                                       */
/* -------------------------------------------------------------------------- */

export function publishCommand(deviceId: string, input: unknown) {
  const payload = commandSchema.parse(input)

  return publishMessage(topics.command(deviceId), payload, { qos: 1 })
}

export function publishAutomation(deviceId: string, automation: unknown) {
  return publishMessage(topics.automation(deviceId), automation, {
    qos: 1,
    retain: true,
  })
}

export function publishConfig(deviceId: string, input: unknown) {
  const payload = configSchema.parse(input)

  return publishMessage(topics.config(deviceId), payload, {
    qos: 1,
    retain: true,
  })
}

/* -------------------------------------------------------------------------- */
/* Device configuration                                                       */
/* -------------------------------------------------------------------------- */
/*
 * AUTOMATION_EXECUTOR=server
 *   -> Backend evaluates automations. Rules are NOT sent to the ESP32.
 *
 * AUTOMATION_EXECUTOR=device
 *   -> ESP32 evaluates automations. Enabled rules are sent in the config.
 */

/**
 * Config synchronisation
 *
 *   DB updated -> config generated (+ configVersion) -> MQTT published (retained)
 *              -> ESP32 applies -> CONFIG_ACK -> Device.configStatus = 'acked'
 *
 * - configVersion only increases when the generated content changes (sha256).
 *   Re-sending unchanged content (device reconnect, resync) reuses the version,
 *   so the ESP32 can skip re-applying it and simply acknowledge again.
 * - The message is retained (QoS 1): an ESP32 that reconnects receives the
 *   latest config from the broker immediately, even if the backend is down.
 * - Pushes for one device are serialised, so an older DB snapshot can never be
 *   published after a newer one.
 */
const CONFIG_HASH_LENGTH = 12
const deviceConfigLocks = new Map<string, Promise<unknown>>()

function withConfigLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = deviceConfigLocks.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)

  deviceConfigLocks.set(key, next)

  const cleanup = () => {
    if (deviceConfigLocks.get(key) === next) deviceConfigLocks.delete(key)
  }
  next.then(cleanup, cleanup)

  return next
}

// Key-order independent JSON so the same config always produces the same hash.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const source = current as Record<string, unknown>
      return Object.keys(source)
        .sort()
        .reduce<Record<string, unknown>>((sorted, key) => {
          sorted[key] = source[key]
          return sorted
        }, {})
    }
    return current
  })
}

// Config resync: a device that is online but has not confirmed the latest
// config gets it re-sent (cooldown + attempt limit, so an old firmware that
// never sends CONFIG_ACK is not spammed forever).
const CONFIG_RESYNC_COOLDOWN_MS = 30_000
const CONFIG_RESYNC_MAX_ATTEMPTS = 5
const configResync = new Map<string, { attempts: number; lastAttempt: number }>()

export function pushDeviceConfig(deviceMongoId: string): Promise<void> {
  if (!Types.ObjectId.isValid(deviceMongoId)) {
    logConfig(`Invalid device Mongo ID: ${deviceMongoId}`)
    return Promise.resolve()
  }

  return withConfigLock(deviceMongoId, () => pushDeviceConfigLocked(deviceMongoId))
}

async function pushDeviceConfigLocked(deviceMongoId: string) {
  const device = await Device.findById(deviceMongoId).lean()

  if (!device) {
    logConfig(`Device not found: ${deviceMongoId}`)
    return
  }

  const [sensors, actuators] = await Promise.all([
    Sensor.find({ deviceId: device._id }).sort({ _id: 1 }).lean(),
    Actuator.find({ deviceId: device._id }).sort({ _id: 1 }).lean(),
  ])

  let automations: DeviceAutomation[] = []

  if (env.AUTOMATION_EXECUTOR === 'device') {
    const databaseAutomations = await Automation.find({
      deviceId: device._id,
      enabled: true,
    }).lean()

    // Mongoose Mixed fields can cause implicit `any`, so assert explicitly.
    automations = databaseAutomations as unknown as DeviceAutomation[]
  }

  const sensorConfig = sensors.map((sensor) => ({
    sensorId: String(sensor._id),
    name: sensor.name,
    type: sensor.type,
    interface: sensor.interface || 'gpio',
    ...(sensor.gpio !== undefined ? { gpio: sensor.gpio } : {}),
    ...(sensor.pins && typeof sensor.pins === 'object'
      ? { pins: sensor.pins }
      : {}),
    ...(sensor.address !== undefined ? { address: sensor.address } : {}),
    ...(sensor.channel !== undefined ? { channel: sensor.channel } : {}),
    ...(sensor.unit ? { unit: sensor.unit } : {}),
    ...(sensor.config && typeof sensor.config === 'object'
      ? { config: sensor.config }
      : {}),
  }))

  const actuatorConfig = actuators.map((actuator) => ({
    actuatorId: String(actuator._id),
    name: actuator.name,
    type: actuator.type,
    interface: actuator.interface || 'gpio',
    ...(actuator.gpio !== undefined ? { gpio: actuator.gpio } : {}),
    ...(actuator.pins && typeof actuator.pins === 'object'
      ? { pins: actuator.pins }
      : {}),
    ...(actuator.address !== undefined ? { address: actuator.address } : {}),
    ...(actuator.channel !== undefined ? { channel: actuator.channel } : {}),
    ...(actuator.config && typeof actuator.config === 'object'
      ? { config: actuator.config }
      : {}),
  }))

  const deviceAutomations =
    env.AUTOMATION_EXECUTOR === 'device'
      ? automations
          // Only send rules whose sensor/actuator references are all present.
          .filter(
            (automation: DeviceAutomation) =>
              automation.conditions.every((condition: AutomationCondition) =>
                Boolean(condition.sensorId),
              ) &&
              automation.actions.every((action: AutomationAction) =>
                Boolean(action.actuatorId),
              ),
          )
          .map((automation: DeviceAutomation) => ({
            automationId: String(automation._id),
            name: automation.name,
            enabled: automation.enabled,
            conditions: automation.conditions.map(
              (condition: AutomationCondition) => ({
                sensorId: String(condition.sensorId),
                operator: condition.operator,
                value: condition.value,
              }),
            ),
            actions: automation.actions.map((action: AutomationAction) => ({
              actuatorId: String(action.actuatorId),
              command: String(action.command).trim(),
              ...(action.value !== undefined ? { value: action.value } : {}),
              ...(action.duration != null
                ? { duration: action.duration }
                : {}),
              ...(action.parameters ? { parameters: action.parameters } : {}),
            })),
          }))
      : undefined

  // deviceId is set AFTER the spread: a user-defined `config.deviceId` must
  // never be able to override the device's real MQTT identity.
  const body = {
    protocolVersion: '2.1',
    ...(device.config && typeof device.config === 'object'
      ? device.config
      : {}),
    deviceId: device.deviceId,
    sensors: sensorConfig,
    actuators: actuatorConfig,
    automationExecutor: env.AUTOMATION_EXECUTOR,
    ...(env.AUTOMATION_EXECUTOR === 'device'
      ? { automations: deviceAutomations ?? [] }
      : {}),
  }

  const hash = createHash('sha256').update(stableStringify(body)).digest('hex')

  let version = device.configVersion ?? 0
  let changed = false

  if (version < 1 || device.configHash !== hash) {
    const bumped = await Device.findOneAndUpdate(
      { _id: device._id },
      {
        $inc: { configVersion: 1 },
        $set: { configHash: hash, configStatus: 'pending' },
        $unset: { lastConfigError: '' },
      },
      { new: true },
    ).lean()

    if (!bumped) {
      logConfig(`Device ${device.deviceId} was deleted while its config was generated`)
      return
    }

    version = bumped.configVersion ?? 1
    changed = true
    configResync.delete(device.deviceId)
  }

  const config = {
    ...body,
    configVersion: version,
    configHash: hash.slice(0, CONFIG_HASH_LENGTH),
  }

  // If this publish fails the DB already says configStatus='pending', and the
  // device receives the config on its next connect / resync.
  await publishConfig(device.deviceId, config)

  await Device.updateOne(
    { _id: device._id },
    { $set: { lastConfigPublishedAt: new Date() } },
  )

  logConfig(
    `Published to ${device.deviceId} version=${version}` +
      `${changed ? '' : ' (re-sent, unchanged)'}: ` +
      `${sensors.length} sensors, ` +
      `${actuators.length} actuators, ` +
      `${automations.length} automations ` +
      `(executor=${env.AUTOMATION_EXECUTOR})`,
  )

  const fresh = await Device.findById(device._id).lean()
  if (fresh) broadcastDeviceUpdate(String(fresh.userId), fresh)
}

/**
 * Best-effort config push. Never throws: a broker problem must not turn a
 * successful database write (create sensor, toggle automation, ...) into a
 * failed API request. Returns true when the config was published.
 */
export async function pushDeviceConfigSafe(
  deviceMongoId: string,
): Promise<boolean> {
  try {
    await pushDeviceConfig(deviceMongoId)
    return true
  } catch (error) {
    logConfig(`Publish failed for ${deviceMongoId}`, error)
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Config resync + CONFIG_ACK                                                 */
/* -------------------------------------------------------------------------- */

type ConfigSyncDevice = {
  _id: Types.ObjectId
  deviceId: string
  configStatus?: string | null
}

/** Device (re)connected: always hand it the latest config with a fresh retry budget. */
async function pushConfigOnReconnect(device: ConfigSyncDevice) {
  configResync.set(device.deviceId, { attempts: 0, lastAttempt: Date.now() })
  await pushDeviceConfigSafe(String(device._id))
}

/** Telemetry proves the device is alive; if it never confirmed the config, re-send it. */
async function maybeResyncConfig(device: ConfigSyncDevice) {
  if (device.configStatus === 'acked' || device.configStatus === 'failed') return

  const now = Date.now()
  const state = configResync.get(device.deviceId) ?? { attempts: 0, lastAttempt: 0 }

  if (now - state.lastAttempt < CONFIG_RESYNC_COOLDOWN_MS) return

  if (state.attempts >= CONFIG_RESYNC_MAX_ATTEMPTS) {
    if (state.attempts === CONFIG_RESYNC_MAX_ATTEMPTS) {
      configResync.set(device.deviceId, { attempts: state.attempts + 1, lastAttempt: now })
      logConfig(
        `${device.deviceId} never acknowledged the config after ${CONFIG_RESYNC_MAX_ATTEMPTS} re-sends; ` +
          'giving up until it reconnects (does the firmware send CONFIG_ACK?)',
      )
    }
    return
  }

  configResync.set(device.deviceId, { attempts: state.attempts + 1, lastAttempt: now })
  logConfig(
    `${device.deviceId} has not acknowledged its config yet; re-sending ` +
      `(attempt ${state.attempts + 1}/${CONFIG_RESYNC_MAX_ATTEMPTS})`,
  )
  await pushDeviceConfigSafe(String(device._id))
}

async function configAck(raw: unknown, topicDeviceId: string) {
  const result = configAckSchema.safeParse(raw)

  if (!result.success) {
    log(`Invalid CONFIG_ACK payload from ${topicDeviceId}`, result.error)
    return
  }

  const ack = result.data

  if (ack.deviceId !== topicDeviceId) {
    log(`Device ID mismatch: topic=${topicDeviceId}, payload=${ack.deviceId}`)
    return
  }

  const device = await Device.findOne({ deviceId: topicDeviceId })

  if (!device) {
    await logUnknownDevice(topicDeviceId, 'config/ack', raw)
    return
  }

  logRecognized(device.deviceId)

  const currentVersion = device.configVersion ?? 0
  const expectedHash = device.configHash?.slice(0, CONFIG_HASH_LENGTH)

  // An ACK for an older config (published before the latest DB change) says
  // nothing about the current one; the device will ACK the newer version too.
  if (
    ack.configVersion !== currentVersion ||
    (ack.configHash && expectedHash && ack.configHash !== expectedHash)
  ) {
    logConfig(
      `Stale CONFIG_ACK from ${device.deviceId}: ack version=${ack.configVersion}, ` +
        `current version=${currentVersion}; waiting for the latest`,
    )
    return
  }

  const now = new Date()
  const previousStatus = device.configStatus

  if (ack.status === 'applied') {
    // Filtering on configVersion means a newer push that happened while this
    // ACK was processed is never marked as acknowledged by mistake.
    await Device.updateOne(
      { _id: device._id, configVersion: currentVersion },
      {
        $set: {
          configStatus: 'acked',
          lastConfigAckVersion: ack.configVersion,
          lastConfigAckAt: now,
        },
        $unset: { lastConfigError: '' },
      },
    )

    configResync.delete(device.deviceId)

    logConfig(
      `ACK from ${device.deviceId}: version=${ack.configVersion} applied` +
        (ack.sensors !== undefined || ack.actuators !== undefined
          ? ` (${ack.sensors ?? '?'} sensors, ${ack.actuators ?? '?'} actuators)`
          : ''),
    )

    if (previousStatus !== 'acked') {
      await createEvent({
        userId: String(device.userId),
        deviceId: String(device._id),
        type: 'system',
        message: `Config v${ack.configVersion} applied by device`,
        metadata: { mqtt: true, configVersion: ack.configVersion },
      })
    }
  } else {
    const reason = ack.error || 'unknown error'

    await Device.updateOne(
      { _id: device._id, configVersion: currentVersion },
      {
        $set: {
          configStatus: 'failed',
          lastConfigAckAt: now,
          lastConfigError: reason,
        },
      },
    )

    logConfig(`ACK from ${device.deviceId}: version=${ack.configVersion} FAILED: ${reason}`)

    await createEvent({
      userId: String(device.userId),
      deviceId: String(device._id),
      type: 'system',
      message: `Device rejected config v${ack.configVersion}: ${reason}`,
      metadata: { mqtt: true, configVersion: ack.configVersion },
    })
  }

  const fresh = await Device.findById(device._id).lean()
  if (fresh) broadcastDeviceUpdate(String(fresh.userId), fresh)
}

/* -------------------------------------------------------------------------- */
/* Sensor status                                                              */
/* -------------------------------------------------------------------------- */

function deriveSensorStatus(
  value: unknown,
): 'normal' | 'warning' | 'error' | 'unknown' {
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'boolean') return value ? 'warning' : 'normal'
  return 'normal'
}

/* -------------------------------------------------------------------------- */
/* Reading normalization                                                      */
/* -------------------------------------------------------------------------- */

function buildReadingIndex(
  readings: Record<string, unknown>,
  gpioReadings: Record<string, unknown>,
): Record<string, unknown> {
  return { ...gpioReadings, ...readings }
}

/* -------------------------------------------------------------------------- */
/* Actuator state acknowledgement                                             */
/* -------------------------------------------------------------------------- */

async function applyActuatorStates(
  device: DeviceLike,
  states: Record<string, unknown>,
) {
  for (const [identifier, state] of Object.entries(states)) {
    const query: Record<string, unknown>[] = [{ name: identifier }]

    if (/^[a-f\d]{24}$/i.test(identifier)) {
      query.push({ _id: identifier })
    }

    const actuator = await Actuator.findOne({
      deviceId: device._id,
      $or: query,
    })

    if (!actuator) {
      log(`Actuator state received for unknown actuator: ${identifier}`)
      continue
    }

    actuator.state = state
    await actuator.save()

    broadcastActuatorUpdate(String(device.userId), actuator.toObject())
  }
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

async function telemetry(raw: unknown, topicDeviceId: string) {
  const result = telemetrySchema.safeParse(raw)

  if (!result.success) {
    log(`Invalid telemetry payload from ${topicDeviceId}`, result.error)
    return
  }

  // Never trust a payload deviceId that does not match the MQTT topic.
  if (result.data.deviceId !== topicDeviceId) {
    log(
      `Device ID mismatch: topic=${topicDeviceId}, payload=${result.data.deviceId}`,
    )
    return
  }

  const device = await Device.findOne({ deviceId: topicDeviceId })

  if (!device) {
    await logUnknownDevice(topicDeviceId, 'telemetry', raw)
    return
  }

  logRecognized(device.deviceId)

  // Merge generic readings and legacy GPIO readings.
  const readings = buildReadingIndex(
    result.data.readings || {},
    result.data.gpioReadings || {},
  )

  // Backward compatibility for existing PIR firmware.
  if (typeof result.data.pirState === 'boolean') {
    const pir = await Sensor.findOne({
      deviceId: device._id,
      type: { $in: ['pir', 'motion'] },
    })

    if (pir) {
      readings[String(pir._id)] = result.data.pirState
    }
  }

  const sensors = await Sensor.find({ deviceId: device._id })
  const now = new Date()

  // Process every registered sensor.
  for (const sensor of sensors) {
    const id = String(sensor._id)
    const gpio = sensor.gpio != null ? String(sensor.gpio) : null
    const type = String(sensor.type || '').toLowerCase()
    const unit = String(sensor.unit || '').toLowerCase()

    let key: string | null = id in readings ? id : null

    // Temperature fallback.
    if (!key && gpio && type.includes('temp')) {
      const candidate = `${gpio}_temperature`
      if (candidate in readings) key = candidate
    }

    // Humidity fallback.
    if (!key && gpio && (type.includes('humid') || unit === '%')) {
      const candidate = `${gpio}_humidity`
      if (candidate in readings) key = candidate
    }

    // GPIO fallback.
    if (!key && gpio && gpio in readings) {
      key = gpio
    }

    if (!key) continue

    const previousValue = sensor.value
    const newValue = readings[key]

    // Log only real changes so telemetry does not flood the logs.
    if (JSON.stringify(previousValue) !== JSON.stringify(newValue)) {
      log(
        `[telemetry] ${device.deviceId} sensor=${sensor.name}(${id}) ` +
          `${String(previousValue)} -> ${String(newValue)}`,
      )
    }

    sensor.value = newValue
    sensor.lastUpdated = now
    sensor.status = deriveSensorStatus(newValue)
    sensor.healthStatus = 'healthy'

    await sensor.save()

    broadcastSensorUpdate(String(device.userId), sensor.toObject())

    // Server-side automation. If executor=device, the backend must NOT evaluate.
    if (env.AUTOMATION_EXECUTOR === 'server') {
      await evaluateAutomations(
        {
          _id: device._id,
          deviceId: device.deviceId,
          userId: device.userId,
        },
        id,
        newValue,
        previousValue,
      )
    }
  }

  // Actuator acknowledgement.
  if (result.data.actuatorStates) {
    await applyActuatorStates(
      {
        _id: device._id,
        deviceId: device.deviceId,
        userId: device.userId,
      },
      result.data.actuatorStates,
    )
  }

  // Device heartbeat.
  await Device.updateOne(
    { _id: device._id },
    {
      $set: {
        lastSeen: now,
        status: 'online',
        ...(result.data.metadata ? { metadata: result.data.metadata } : {}),
      },
    },
  )

  // Realtime telemetry.
  broadcastDeviceTelemetry(String(device.userId), device.deviceId, {
    ...result.data,
    readings,
  })

  logTelemetryReceived(device.deviceId, Object.keys(readings).length)

  // Telemetry arrives but the device never confirmed its config: re-send it.
  await maybeResyncConfig({
    _id: device._id,
    deviceId: device.deviceId,
    configStatus: device.configStatus,
  })
}

/* -------------------------------------------------------------------------- */
/* Device status                                                              */
/* -------------------------------------------------------------------------- */

async function status(raw: unknown, topicDeviceId: string) {
  const result = statusSchema.safeParse(raw)

  if (!result.success) {
    log(`Invalid status payload from ${topicDeviceId}`, result.error)
    return
  }

  // Topic identity must match payload identity.
  if (result.data.deviceId !== topicDeviceId) {
    log(
      `Device ID mismatch: topic=${topicDeviceId}, payload=${result.data.deviceId}`,
    )
    return
  }

  const device = await Device.findOne({ deviceId: topicDeviceId })

  if (!device) {
    await logUnknownDevice(topicDeviceId, 'status', raw)
    return
  }

  if (result.data.status === 'online') {
    logRecognized(device.deviceId)
  } else {
    // Offline (Last Will or clean disconnect): announce recognition again next time.
    recognizedDevices.delete(device.deviceId)
    telemetryLastLogged.delete(device.deviceId)
  }

  const previousStatus = device.status
  const now = new Date()

  await Device.updateOne(
    { _id: device._id },
    {
      $set: {
        status: result.data.status,
        lastSeen: now,
        ...(result.data.firmwareVersion
          ? { firmwareVersion: result.data.firmwareVersion }
          : {}),
        ...(result.data.ipAddress ? { ipAddress: result.data.ipAddress } : {}),
        ...(result.data.macAddress
          ? { macAddress: result.data.macAddress }
          : {}),
        ...(result.data.metadata ? { metadata: result.data.metadata } : {}),
      },
    },
  )

  broadcastDeviceStatus(
    String(device.userId),
    device.deviceId,
    result.data.status,
    {
      firmwareVersion: result.data.firmwareVersion,
      ipAddress: result.data.ipAddress,
      macAddress: result.data.macAddress,
    },
  )

  if (previousStatus !== result.data.status) {
    await createEvent({
      userId: String(device.userId),
      deviceId: String(device._id),
      type: 'system',
      message: `Device ${result.data.status}`,
      metadata: { mqtt: true },
    })
  }

  // Device came online: push the latest hardware configuration.
  if (result.data.status === 'online') {
    await pushConfigOnReconnect({
      _id: device._id,
      deviceId: device.deviceId,
      configStatus: device.configStatus,
    })
  }
}

/* -------------------------------------------------------------------------- */
/* MQTT startup                                                               */
/* -------------------------------------------------------------------------- */

export function startMqtt() {
  if (started) return

  started = true

  const subscribe = () => {
    if (!mqttClient.connected) {
      log('Cannot subscribe because MQTT is not connected')
      return
    }

    mqttClient.subscribe(
      [topics.telemetry, topics.status, topics.configAck],
      { qos: 1 },
      (error) => {
        if (error) {
          log('Subscribe error', error)
          return
        }

        log('Subscribed to telemetry/status/config-ack')
        void logRegisteredDevices()
      },
    )
  }

  // Startup diagnostic: which ids does the backend accept? Compare with the
  // firmware DEVICE_ID if "Unknown device message" ever shows up.
  const logRegisteredDevices = async () => {
    try {
      const [total, sample] = await Promise.all([
        Device.countDocuments(),
        Device.find().select('deviceId').limit(20).lean(),
      ])

      log(
        `Registered devices (${total}): ` +
          (sample.length > 0
            ? sample.map((device) => `"${device.deviceId}"`).join(', ')
            : 'none') +
          (total > sample.length ? ', ...' : ''),
      )
    } catch (error) {
      log('Could not list registered devices', error)
    }
  }

  mqttClient.on('connect', () => {
    log(`Connected as ${mqttClient.options.clientId}`)

    // Device state is unknown after a broker reconnect: re-announce recognition.
    recognizedDevices.clear()

    // Re-subscribe every time MQTT reconnects.
    subscribe()
  })

  mqttClient.on('reconnect', () => {
    log('Reconnecting...')
  })

  mqttClient.on('error', (error) => {
    log('Connection error', error)
  })

  mqttClient.on('offline', () => {
    log('Offline')
  })

  mqttClient.on('close', () => {
    log('Connection closed')
  })

  mqttClient.on('message', async (topic, message) => {
    try {
      const kind: DeviceTopicKind | null = topic.endsWith('/config/ack')
        ? 'config/ack'
        : topic.endsWith('/telemetry')
          ? 'telemetry'
          : topic.endsWith('/status')
            ? 'status'
            : null

      if (!kind) return

      const topicDeviceId = deviceIdFromTopic(topic, kind)

      if (!topicDeviceId) {
        log(`Ignoring malformed MQTT topic: ${topic}`)
        return
      }

      let payload: unknown

      try {
        payload = JSON.parse(message.toString())
      } catch (error) {
        log(`Invalid JSON received on ${topic}`, error)
        return
      }

      if (kind === 'telemetry') {
        await telemetry(payload, topicDeviceId)
        return
      }

      if (kind === 'config/ack') {
        await configAck(payload, topicDeviceId)
        return
      }

      await status(payload, topicDeviceId)
    } catch (error) {
      log(`Message processing failed for ${topic}`, error)
    }
  })

  // mqtt.js can connect before startMqtt() is called.
  if (mqttClient.connected) {
    subscribe()
  }
}

/* -------------------------------------------------------------------------- */
/* MQTT shutdown                                                              */
/* -------------------------------------------------------------------------- */

export async function stopMqtt() {
  if (!started) return

  started = false

  recognizedDevices.clear()
  telemetryLastLogged.clear()
  unknownDeviceState.clear()
  configResync.clear()

  mqttClient.removeAllListeners('connect')
  mqttClient.removeAllListeners('reconnect')
  mqttClient.removeAllListeners('error')
  mqttClient.removeAllListeners('offline')
  mqttClient.removeAllListeners('close')
  mqttClient.removeAllListeners('message')

  if (mqttClient.connected || mqttClient.reconnecting) {
    await new Promise<void>((resolve) => {
      mqttClient.end(false, {}, () => resolve())
    })
  }
}