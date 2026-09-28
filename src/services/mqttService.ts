import { mqttClient, mqttClientId, topics } from '../config/mqtt.js'
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
import { publishMessage, clearRetained } from './mqttPublisher.js'
import {
  broadcastDeviceTelemetry,
  broadcastDeviceStatus,
  broadcastSensorUpdate,
  broadcastActuatorUpdate,
} from './realtimeService.js'

const log = (message: string, error?: unknown) =>
  console[error ? 'error' : 'log'](
    `[MQTT] ${message}`,
    error instanceof Error ? error.message : '',
  )

export function publishCommand(deviceId: string, input: unknown): Promise<void> {
  const payload = commandSchema.parse(input)
  return publishMessage(topics.command(deviceId), payload, { qos: 1 })
}

export function publishConfig(deviceId: string, input: unknown): Promise<void> {
  const payload = configSchema.parse(input)
  return publishMessage(topics.config(deviceId), payload, { qos: 1, retain: true })
}

// Devices whose legacy retained `devices/<id>/automation` message was already cleared
// in this process. Rules travel inside the retained config message now; the old topic
// only had ONE retained slot, so every new rule overwrote the previous one and a
// deleted rule stayed retained forever.
const legacyAutomationTopicCleared = new Set<string>()

/**
 * Build a complete hardware-independent configuration and publish it (retained).
 * GPIO is optional; buses such as I2C/SPI/UART/OneWire and virtual sensors
 * are represented through interface/pins/address/config.
 *
 * Best-effort: never throws. The database is the source of truth; if the broker is
 * down the API call that changed the data must still succeed (otherwise the client
 * gets a 500 for a record that WAS saved and a retry creates a duplicate). The device
 * gets the complete config again as soon as it reports `online` (see status()).
 * Returns whether the config reached the broker.
 */
export async function pushDeviceConfig(deviceMongoId: string): Promise<boolean> {
  try {
    const device = await Device.findById(deviceMongoId)
    if (!device) return false

    const deviceRunsAutomations = env.AUTOMATION_EXECUTOR === 'device'

    const [sensors, actuators, automations] = await Promise.all([
      Sensor.find({ deviceId: deviceMongoId }).lean(),
      Actuator.find({ deviceId: deviceMongoId }).lean(),
      deviceRunsAutomations
        ? Automation.find({ deviceId: deviceMongoId, enabled: true }).lean()
        : Promise.resolve([]),
    ])

    const actuatorNameById = new Map(
      actuators.map(a => [String(a._id), a.name]),
    )

    const config = {
      deviceId: device.deviceId,
      protocolVersion: '2.0',
      ...(device.config && typeof device.config === 'object' ? device.config : {}),
      sensors: sensors.map(sensor => ({
        sensorId: String(sensor._id),
        name: sensor.name,
        type: sensor.type,
        interface: sensor.interface || 'gpio',
        ...(sensor.gpio !== undefined ? { gpio: sensor.gpio } : {}),
        ...(sensor.pins && typeof sensor.pins === 'object' ? { pins: sensor.pins } : {}),
        ...(sensor.address !== undefined ? { address: sensor.address } : {}),
        ...(sensor.channel !== undefined ? { channel: sensor.channel } : {}),
        ...(sensor.unit ? { unit: sensor.unit } : {}),
        ...(sensor.config && typeof sensor.config === 'object' ? { config: sensor.config } : {}),
      })),
      actuators: actuators.map(actuator => ({
        actuatorId: actuator.name,
        name: actuator.name,
        type: actuator.type,
        interface: actuator.interface || 'gpio',
        ...(actuator.gpio !== undefined ? { gpio: actuator.gpio } : {}),
        ...(actuator.pins && typeof actuator.pins === 'object' ? { pins: actuator.pins } : {}),
        ...(actuator.address !== undefined ? { address: actuator.address } : {}),
        ...(actuator.channel !== undefined ? { channel: actuator.channel } : {}),
        ...(actuator.config && typeof actuator.config === 'object' ? { config: actuator.config } : {}),
      })),
      // Only in AUTOMATION_EXECUTOR=device mode. In 'server' mode the backend fires
      // the commands itself, so shipping the rules to the ESP32 as well would make
      // every actuator trigger twice.
      automations: automations
        .filter(a => a.conditions.every(c => c.sensorId) && a.actions.every(act => act.actuatorId && actuatorNameById.has(String(act.actuatorId))))
        .map(a => ({
          automationId: String(a._id),
          name: a.name,
          enabled: a.enabled,
          conditions: a.conditions.map(c => ({
            sensorId: String(c.sensorId),
            operator: c.operator,
            value: c.value,
          })),
          actions: a.actions.map(action => ({
            actuatorId: actuatorNameById.get(String(action.actuatorId))!,
            command: String(action.command).trim(),
            ...(action.value !== undefined ? { value: action.value } : {}),
            ...(action.duration != null ? { duration: action.duration } : {}),
            ...(action.parameters ? { parameters: action.parameters } : {}),
          })),
        })),
    }

    await publishConfig(device.deviceId, config)
    log(`Config pushed to ${device.deviceId}: ${sensors.length} sensors, ${actuators.length} actuators, ${automations.length} automations`)

    if (!legacyAutomationTopicCleared.has(device.deviceId)) {
      try {
        await clearRetained(topics.automation(device.deviceId))
        legacyAutomationTopicCleared.add(device.deviceId)
      } catch (error) {
        log(`Could not clear legacy automation topic of ${device.deviceId}`, error)
      }
    }

    return true
  } catch (error) {
    log(`Failed to push device config for ${deviceMongoId} (device receives it when it next reports online)`, error)
    return false
  }
}

function deriveSensorStatus(value: unknown): 'normal' | 'warning' | 'error' | 'unknown' {
  if (value === null || value === undefined) return 'unknown'
  // Boolean sensors commonly use true as an active/alarm state. Keep this
  // behaviour for compatibility, while numeric/string sensors remain normal.
  if (typeof value === 'boolean') return value ? 'warning' : 'normal'
  return 'normal'
}

function buildReadingIndex(
  readings: Record<string, unknown>,
  gpioReadings: Record<string, unknown>,
) {
  return { ...gpioReadings, ...readings }
}

async function applyActuatorStates(device: any, states: Record<string, unknown>) {
  for (const [identifier, state] of Object.entries(states)) {
    const actuator = await Actuator.findOne({
      deviceId: device._id,
      $or: [{ name: identifier }, ...(identifier.match(/^[a-f\d]{24}$/i) ? [{ _id: identifier }] : [])],
    })
    if (!actuator) continue

    actuator.state = state
    await actuator.save()
    broadcastActuatorUpdate(String(device.userId), actuator.toObject())
  }
}

async function telemetry(raw: unknown) {
  const result = telemetrySchema.safeParse(raw)
  if (!result.success) return log('Invalid telemetry payload', result.error)

  const device = await Device.findOne({ deviceId: result.data.deviceId })
  if (!device) return log(`Unknown device message: ${result.data.deviceId}`)

  const readings: Record<string, any> = buildReadingIndex(
    result.data.readings || {},
    result.data.gpioReadings || {},
  )

  // Backward compatibility for the original PIR firmware.
  if (typeof result.data.pirState === 'boolean') {
    const pir = await Sensor.findOne({ deviceId: device._id, type: { $in: ['pir', 'motion'] } })
    if (pir) readings[String(pir._id)] = result.data.pirState
  }

  const sensors = await Sensor.find({ deviceId: device._id })
  const now = new Date()

  // Phase 1: store every reading of this packet. Rules are evaluated only afterwards,
  // so a rule with conditions on two sensors sees this packet's values for BOTH
  // instead of one fresh and one stale value (which caused spurious triggers).
  const updates: Array<{ id: string; newValue: unknown; previousValue: unknown }> = []

  for (const sensor of sensors) {
    const id = String(sensor._id)
    const gpio = sensor.gpio != null ? String(sensor.gpio) : null
    const type = String(sensor.type || '').toLowerCase()
    const unit = String(sensor.unit || '').toLowerCase()

    // Preferred: sensor Mongo ID. This removes GPIO as the identity of a sensor.
    let key: string | null = id in readings ? id : null

    // Backward-compatible aliases for common multi-value DHT payloads.
    if (!key && gpio && type.includes('temp')) key = `${gpio}_temperature` in readings ? `${gpio}_temperature` : null
    if (!key && gpio && (type.includes('humid') || unit === '%')) key = `${gpio}_humidity` in readings ? `${gpio}_humidity` : null

    // Generic physical GPIO fallback.
    if (!key && gpio && gpio in readings) key = gpio

    if (!key) continue

    const previousValue = sensor.value
    const newValue = readings[key]
    sensor.value = newValue
    sensor.lastUpdated = now
    sensor.status = deriveSensorStatus(newValue)
    await sensor.save()

    broadcastSensorUpdate(String(device.userId), sensor.toObject())
    updates.push({ id, newValue, previousValue })
  }

  // Phase 2: rules. A failing rule (broker hiccup, bad data) must not abort the rest
  // of the packet: before, an exception here skipped the remaining sensors, the
  // lastSeen/online update and the WebSocket broadcast.
  if (env.AUTOMATION_EXECUTOR === 'server') {
    for (const { id, newValue, previousValue } of updates) {
      try {
        await evaluateAutomations(
          { _id: device._id, deviceId: device.deviceId, userId: device.userId },
          id,
          newValue,
          previousValue,
        )
      } catch (error) {
        log(`Automation evaluation failed for sensor ${id} of ${device.deviceId}`, error)
      }
    }
  }

  if (result.data.actuatorStates) {
    await applyActuatorStates(device, result.data.actuatorStates)
  }

  await Device.updateOne({ _id: device._id }, {
    $set: {
      lastSeen: now,
      status: 'online',
      ...(result.data.metadata ? { metadata: result.data.metadata } : {}),
    },
  })

  broadcastDeviceTelemetry(String(device.userId), device.deviceId, {
    ...result.data,
    readings,
  })
}

async function status(raw: unknown) {
  const result = statusSchema.safeParse(raw)
  if (!result.success) return log('Invalid status payload', result.error)

  const device = await Device.findOne({ deviceId: result.data.deviceId })
  if (!device) return log(`Unknown device message: ${result.data.deviceId}`)

  await Device.updateOne({ _id: device._id }, {
    $set: {
      status: result.data.status,
      lastSeen: new Date(),
      ...(result.data.firmwareVersion ? { firmwareVersion: result.data.firmwareVersion } : {}),
      ...(result.data.ipAddress ? { ipAddress: result.data.ipAddress } : {}),
      ...(result.data.macAddress ? { macAddress: result.data.macAddress } : {}),
      ...(result.data.metadata ? { metadata: result.data.metadata } : {}),
    },
  })

  broadcastDeviceStatus(String(device.userId), device.deviceId, result.data.status, {
    firmwareVersion: result.data.firmwareVersion,
    ipAddress: result.data.ipAddress,
    macAddress: result.data.macAddress,
  })

  await createEvent({
    userId: String(device.userId),
    deviceId: String(device._id),
    type: 'system',
    message: `Device ${result.data.status}`,
    metadata: { mqtt: true },
  })

  if (result.data.status === 'online') await pushDeviceConfig(String(device._id))
}

let mqttStarted = false

export function startMqtt() {
  if (mqttStarted) return
  mqttStarted = true

  const subscribeAll = () =>
    mqttClient.subscribe([topics.telemetry, topics.status], { qos: 1 }, error => {
      if (error) log('Subscribe error', error)
      else log('Subscribed')
    })

  mqttClient.on('connect', () => {
    log(`Connected as ${mqttClientId}`)
    subscribeAll()
  })
  mqttClient.on('reconnect', () => log('Connecting...'))
  mqttClient.on('error', error => log('Connection error', error))
  mqttClient.on('offline', () => log('Offline'))
  mqttClient.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString())
      if (topic.endsWith('/telemetry')) await telemetry(payload)
      else if (topic.endsWith('/status')) await status(payload)
    } catch (error) {
      log(`Message processing failed for ${topic}`, error)
    }
  })

  // The client starts connecting when config/mqtt.ts is imported, i.e. before this
  // function runs (server.ts calls it after MongoDB is up). If the broker answered
  // first, the 'connect' event has already fired and nobody was listening, so the
  // topics would never have been subscribed - silently, with no error.
  if (mqttClient.connected) {
    log(`Already connected as ${mqttClientId}`)
    subscribeAll()
  }
}

export function stopMqtt() {
  mqttClient.removeAllListeners()
  // A late connection error after removeAllListeners() would otherwise be an
  // unhandled 'error' event and crash the process during shutdown.
  mqttClient.on('error', () => {})
  mqttStarted = false
  if (mqttClient.connected || mqttClient.reconnecting) {
    mqttClient.end(true)
  }
}
