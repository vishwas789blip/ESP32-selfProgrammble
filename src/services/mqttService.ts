import { Types } from 'mongoose'
import { mqttClient, topics, deviceIdFromTopic } from '../config/mqtt.js'
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
} from '../validations/mqttSchemas.js'
import { evaluateAutomations } from './automationService.js'
import {
  broadcastDeviceTelemetry,
  broadcastDeviceStatus,
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

/**
 * "Unknown device" messages can arrive many times per second from a stray
 * publisher. Log each unknown device at most once per minute so real errors
 * do not get buried.
 */
const UNKNOWN_DEVICE_LOG_INTERVAL_MS = 60_000
const unknownDeviceLastLogged = new Map<string, number>()

function logUnknownDevice(deviceId: string) {
  const now = Date.now()
  const last = unknownDeviceLastLogged.get(deviceId) ?? 0

  if (now - last < UNKNOWN_DEVICE_LOG_INTERVAL_MS) return

  unknownDeviceLastLogged.set(deviceId, now)
  log(`Unknown device message: ${deviceId}`)
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

export async function pushDeviceConfig(deviceMongoId: string) {
  if (!Types.ObjectId.isValid(deviceMongoId)) {
    log(`Invalid device Mongo ID: ${deviceMongoId}`)
    return
  }

  const device = await Device.findById(deviceMongoId).lean()

  if (!device) {
    log(`Device not found: ${deviceMongoId}`)
    return
  }

  const [sensors, actuators] = await Promise.all([
    Sensor.find({ deviceId: device._id }).lean(),
    Actuator.find({ deviceId: device._id }).lean(),
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

  const config = {
    deviceId: device.deviceId,
    protocolVersion: '2.1',
    ...(device.config && typeof device.config === 'object'
      ? device.config
      : {}),
    sensors: sensorConfig,
    actuators: actuatorConfig,
    automationExecutor: env.AUTOMATION_EXECUTOR,
    ...(env.AUTOMATION_EXECUTOR === 'device'
      ? { automations: deviceAutomations ?? [] }
      : {}),
  }

  await publishConfig(device.deviceId, config)

  log(
    `Config pushed to ${device.deviceId}: ` +
      `${sensors.length} sensors, ` +
      `${actuators.length} actuators, ` +
      `${automations.length} automations ` +
      `(executor=${env.AUTOMATION_EXECUTOR})`,
  )
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
    log(`Config push failed for ${deviceMongoId}`, error)
    return false
  }
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
    logUnknownDevice(topicDeviceId)
    return
  }

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
    logUnknownDevice(topicDeviceId)
    return
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
    await pushDeviceConfigSafe(String(device._id))
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
      [topics.telemetry, topics.status],
      { qos: 1 },
      (error) => {
        if (error) {
          log('Subscribe error', error)
          return
        }

        log('Subscribed to telemetry/status')
      },
    )
  }

  mqttClient.on('connect', () => {
    log(`Connected as ${mqttClient.options.clientId}`)

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
      const kind = topic.endsWith('/telemetry')
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