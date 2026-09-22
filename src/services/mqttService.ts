import { mqttClient, topics } from '../config/mqtt.js'
import { Device } from '../models/Device.js'
import { Sensor } from '../models/Sensor.js'
import { Actuator } from '../models/Actuator.js'
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
} from './realtimeService.js'
import { Automation } from '../models/Automation.js'

const log = (message: string, error?: unknown) =>
  console[error ? 'error' : 'log'](
    `[MQTT] ${message}`,
    error instanceof Error ? error.message : '',
  )

/**
 * Publish actuator command to MQTT.
 */
export function publishCommand(
  deviceId: string,
  input: unknown,
): Promise<void> {
  const payload = commandSchema.parse(input)

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topics.command(deviceId),
      JSON.stringify(payload),
      { qos: 1 },
      error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      },
    )
  })
}

/**
 * Publish complete automation rule to MQTT.
 *
 * This is called when an automation is:
 * - created
 * - updated
 * - enabled/disabled
 *
 * retain=true means the broker keeps the latest automation
 * so an ESP32 connecting later can receive it.
 */
export function publishAutomation(
  deviceId: string,
  automation: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topics.automation(deviceId),
      JSON.stringify(automation),
      {
        qos: 1,
        retain: true,
      },
      error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      },
    )
  })
}

/**
 * Publish device configuration to MQTT.
 */
export function publishConfig(
  deviceId: string,
  input: unknown,
): Promise<void> {
  const payload = configSchema.parse(input)

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topics.config(deviceId),
      JSON.stringify(payload),
      { qos: 1 },
      error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      },
    )
  })
}

/**
 * Rebuild device GPIO configuration from MongoDB
 * and publish it to the ESP32.
 */
export async function pushDeviceConfig(
  deviceMongoId: string,
) {
  try {
    const device = await Device.findById(deviceMongoId)

    if (!device) {
      return
    }

    const [sensors, actuators, automations] = await Promise.all([
      Sensor.find({ deviceId: deviceMongoId }),
      Actuator.find({ deviceId: deviceMongoId }),
      Automation.find({ deviceId: deviceMongoId, enabled: true }),
    ])

    // The device identifies actuators by name (it has no database), so
    // every actuatorId sent to it — both in the actuators list below and
    // inside each automation's actions — must be the actuator's name,
    // not its Mongo ObjectId.
    const actuatorNameById = new Map(
      actuators.map(actuator => [String(actuator._id), actuator.name]),
    )

    await publishConfig(device.deviceId, {
  deviceId: device.deviceId,

  ...(device.config &&
  typeof device.config === 'object'
    ? device.config
    : {}),

  sensors: sensors
    .filter(
      sensor =>
        sensor.gpio !== undefined &&
        sensor.gpio !== null,
    )
    .map(sensor => ({
      sensorId: String(sensor._id),
      type: sensor.type,
      gpio: sensor.gpio,
    })),

  actuators: actuators
    .filter(
      actuator =>
        actuator.gpio !== undefined &&
        actuator.gpio !== null,
    )
    .map(actuator => ({
      actuatorId: actuator.name,
      type: actuator.type,
      gpio: actuator.gpio,
    })),

  automations: automations
    .filter(automation =>
      automation.conditions.every(c => c.sensorId) &&
      automation.actions.every(a => a.actuatorId && actuatorNameById.has(String(a.actuatorId))),
    )
    .map(automation => ({
    automationId: String(automation._id),
    name: automation.name,
    enabled: automation.enabled,

    conditions: automation.conditions.map(condition => ({
      sensorId: String(condition.sensorId),
      operator: condition.operator,
      value: condition.value,
    })),

    actions: automation.actions.map(action => ({
      actuatorId: actuatorNameById.get(String(action.actuatorId))!,
      command: String(action.command).trim().toUpperCase() as 'ON' | 'OFF',
      ...(action.duration !== undefined &&
      action.duration !== null
        ? { duration: action.duration }
        : {}),
    })),
  })),
})
  } catch (err) {
    log('Failed to push device config', err)
  }
}

/**
 * Generic sensor status.
 */
function deriveSensorStatus(
  value: unknown,
): 'normal' | 'warning' | 'error' {
  if (typeof value === 'boolean') {
    return value ? 'warning' : 'normal'
  }

  return 'normal'
}

/**
 * Process MQTT telemetry.
 *
 * Supports generic readings:
 *
 * {
 *   deviceId: "esp32-001",
 *   readings: {
 *     "26": true,
 *     "34": 31.5
 *   }
 * }
 *
 * Also supports old PIR firmware:
 *
 * {
 *   deviceId: "esp32-001",
 *   pirState: true
 * }
 */
async function telemetry(raw: unknown) {
  const result = telemetrySchema.safeParse(raw)

  if (!result.success) {
    return log(
      'Invalid telemetry payload',
      result.error,
    )
  }

  const device = await Device.findOne({
    deviceId: result.data.deviceId,
  })

  if (!device) {
    return log(
      `Unknown device message: ${result.data.deviceId}`,
    )
  }

  /**
   * Generic GPIO -> value map.
   */
  const readings: Record<
    string,
    boolean | number | string
  > = {
    ...(result.data.readings || {}),
  }

  /**
   * Backward compatibility for old PIR firmware.
   */
  if (typeof result.data.pirState === 'boolean') {
    const pirSensor = await Sensor.findOne({
      deviceId: device._id,
      type: 'pir',
    })

    if (
      pirSensor?.gpio !== undefined &&
      pirSensor?.gpio !== null
    ) {
      readings[String(pirSensor.gpio)] =
        result.data.pirState
    } else {
      log(
        `PIR sensor not found for device ${device.deviceId}`,
      )
    }
  }

  /**
   * Process ALL sensors.
   *
   * PIR, temperature, humidity, LDR, flame,
   * gas, door, etc.
   */
  if (Object.keys(readings).length > 0) {
    const sensors = await Sensor.find({
      deviceId: device._id,
    })

    for (const sensor of sensors) {
      if (
        sensor.gpio === undefined ||
        sensor.gpio === null
      ) {
        continue
      }

      const gpioKey = String(sensor.gpio)

      if (!(gpioKey in readings)) {
        continue
      }

      const previousValue = sensor.value
      const newValue = readings[gpioKey]

      sensor.value = newValue
      sensor.lastUpdated = new Date()
      sensor.status = deriveSensorStatus(newValue)

      await sensor.save()

      broadcastSensorUpdate(
        String(device.userId),
        sensor.toObject(),
      )

      console.log(
        `[MQTT] ${sensor.type} (${sensor.name}): ` +
          `${String(previousValue)} -> ${String(newValue)}`,
      )

      /**
       * Every sensor goes through the same
       * automation engine.
       */
      await evaluateAutomations(
        {
          _id: device._id,
          deviceId: device.deviceId,
          userId: device.userId,
        },
        String(sensor._id),
        newValue,
        previousValue,
      )
    }
  }

  await Device.updateOne(
    {
      _id: device._id,
    },
    {
      lastSeen: new Date(),
      status: 'online',
    },
  )

  broadcastDeviceTelemetry(
    String(device.userId),
    device.deviceId,
    {
      ...result.data,
      readings,
    },
  )

  log('Telemetry received')
}

/**
 * Process MQTT device status.
 */
async function status(raw: unknown) {
  const result = statusSchema.safeParse(raw)

  if (!result.success) {
    return log(
      'Invalid status payload',
      result.error,
    )
  }

  const device = await Device.findOne({
    deviceId: result.data.deviceId,
  })

  if (!device) {
    return log(
      `Unknown device message: ${result.data.deviceId}`,
    )
  }

  await Device.updateOne(
    {
      _id: device._id,
    },
    {
      status: result.data.status,
      lastSeen: new Date(),

      ...(result.data.firmwareVersion
        ? {
            firmwareVersion:
              result.data.firmwareVersion,
          }
        : {}),

      ...(result.data.ipAddress
        ? {
            ipAddress:
              result.data.ipAddress,
          }
        : {}),
    },
  )

  broadcastDeviceStatus(
    String(device.userId),
    device.deviceId,
    result.data.status,
    {
      firmwareVersion:
        result.data.firmwareVersion,
      ipAddress:
        result.data.ipAddress,
    },
  )

  await createEvent({
    userId: String(device.userId),
    deviceId: String(device._id),
    type: 'system',
    message: `Device ${result.data.status}`,
    metadata: {
      mqtt: true,
    },
  })

  if (result.data.status === 'online') {
    await pushDeviceConfig(
      String(device._id),
    )
  }

  log('Status received')
}

/**
 * Start MQTT service.
 */
export function startMqtt() {
  const handleConnect = () => {
    log('Connected')

    mqttClient.subscribe(
      [topics.telemetry, topics.status],
      { qos: 1 },
      error => {
        if (error) {
          log(
            'Subscribe error',
            error,
          )
        } else {
          log('Subscribed')
        }
      },
    )
  }

  mqttClient.on(
    'connect',
    handleConnect,
  )

  mqttClient.on(
    'reconnect',
    () => {
      log('Connecting...')
    },
  )

  mqttClient.on(
    'error',
    error => {
      log(
        'Connection error',
        error,
      )
    },
  )

  mqttClient.on(
    'message',
    async (topic, message) => {
      try {
        const data = JSON.parse(
          message.toString(),
        )

        if (
          topic.endsWith('/telemetry')
        ) {
          await telemetry(data)
        } else if (
          topic.endsWith('/status')
        ) {
          await status(data)
        }
      } catch (error) {
        log(
          'Message processing error',
          error,
        )
      }
    },
  )

  if (mqttClient.connected) {
    handleConnect()
  } else {
    log('Connecting...')
  }
}

/**
 * Stop MQTT service.
 */
export function stopMqtt() {
  mqttClient.end(false)
}