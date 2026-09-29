import { mqttClient, topics } from '../config/mqtt.js'
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

const log = (message: string, error?: unknown) =>
  console[error ? 'error' : 'log'](
    `[MQTT] ${message}`,
    error instanceof Error ? error.message : '',
  )

function publish(topic: string, payload: unknown, options: { qos?: 0 | 1 | 2; retain?: boolean } = {}) {
  return new Promise<void>((resolve, reject) => {
    if (!mqttClient.connected) {
      reject(new Error('MQTT broker is not connected'))
      return
    }
    mqttClient.publish(topic, JSON.stringify(payload), { qos: 1, ...options }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export function publishCommand(deviceId: string, input: unknown): Promise<void> {
  const payload = commandSchema.parse(input)
  return publish(topics.command(deviceId), payload, { qos: 1 })
}

export function publishAutomation(deviceId: string, automation: unknown): Promise<void> {
  return publish(topics.automation(deviceId), automation, { qos: 1, retain: true })
}

export function publishConfig(deviceId: string, input: unknown): Promise<void> {
  const payload = configSchema.parse(input)
  return publish(topics.config(deviceId), payload, { qos: 1, retain: true })
}

/**
 * Build a complete hardware-independent configuration.
 * GPIO is optional; buses such as I2C/SPI/UART/OneWire and virtual sensors
 * are represented through interface/pins/address/config.
 */
export async function pushDeviceConfig(deviceMongoId: string) {
  const device = await Device.findById(deviceMongoId)
  if (!device) return

  const [sensors, actuators, automations] = await Promise.all([
    Sensor.find({ deviceId: deviceMongoId }).lean(),
    Actuator.find({ deviceId: deviceMongoId }).lean(),
    Automation.find({ deviceId: deviceMongoId, enabled: true }).lean(),
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
      ...(sensor.unit ? { unit: sensor.unit } : {}),
      ...(sensor.config && typeof sensor.config === 'object' ? { config: sensor.config } : {}),
    })),
    actuators: actuators.map(actuator => ({
      actuatorId: String(actuator._id),
      name: actuator.name,
      type: actuator.type,
      interface: actuator.interface || 'gpio',
      ...(actuator.gpio !== undefined ? { gpio: actuator.gpio } : {}),
      ...(actuator.pins && typeof actuator.pins === 'object' ? { pins: actuator.pins } : {}),
      ...(actuator.address !== undefined ? { address: actuator.address } : {}),
      ...(actuator.config && typeof actuator.config === 'object' ? { config: actuator.config } : {}),
    })),
    automations: automations
      .filter(a => a.conditions.every(c => c.sensorId) && a.actions.every(a => a.actuatorId && actuatorNameById.has(String(a.actuatorId))))
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

  try {
    await publishConfig(device.deviceId, config)
    log(`Config pushed to ${device.deviceId}: ${sensors.length} sensors, ${actuators.length} actuators, ${automations.length} automations`)
  } catch (error) {
    log(`Failed to push device config to ${device.deviceId}`, error)
    throw error
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
    await evaluateAutomations(
      { _id: device._id, deviceId: device.deviceId, userId: device.userId },
      id,
      newValue,
      previousValue,
    )
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

export function startMqtt() {
  mqttClient.on('connect', () => {
    log('Connected')
    mqttClient.subscribe([topics.telemetry, topics.status], { qos: 1 }, error => {
      if (error) log('Subscribe error', error)
      else log('Subscribed')
    })
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
}

export function stopMqtt() {
  mqttClient.removeAllListeners()
  if (mqttClient.connected || mqttClient.reconnecting) {
    mqttClient.end(true)
  }
}
