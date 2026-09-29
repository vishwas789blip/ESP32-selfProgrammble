import { z } from 'zod'

// Backend -> device messages always carry an ISO-8601 timestamp.
const timestamp = z.string().datetime({ offset: true }).optional()

// Device -> backend messages: ESP32 firmware often has no RTC/NTP and sends millis(),
// epoch seconds or a free-form string. Accepting only ISO strings made the whole
// telemetry/status packet fail validation ("Invalid telemetry payload").
const deviceTimestamp = z.union([z.string(), z.number()]).optional()

/**
 * The backend intentionally does not maintain a closed sensor/actuator enum.
 * Hardware drivers are an ESP32 concern; the backend transports arbitrary
 * typed values and driver configuration.
 */
export const readingValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
])

const sensorConfig = z.record(z.string(), z.unknown()).optional()
const actuatorConfig = z.record(z.string(), z.unknown()).optional()

export const telemetrySchema = z.object({
  deviceId: z.string().min(1),

  // Preferred protocol: sensorId -> value. This works for GPIO, ADC, I2C,
  // SPI, UART, OneWire, virtual/calculated sensors, etc.
  readings: z.record(z.string().min(1), readingValue).optional(),

  // Optional physical pin fallback for backward-compatible ESP32 firmware.
  gpioReadings: z.record(z.string(), readingValue).optional(),

  // Actuator state acknowledgement: actuator name/id -> on/off/other state.
  actuatorStates: z.record(z.string(), z.union([
    z.string(), z.number().finite(), z.boolean(), z.null(),
  ])).optional(),

  // Generic device metadata from firmware.
  metadata: z.record(z.string(), z.unknown()).optional(),

  // Legacy PIR fields.
  pirEnabled: z.boolean().optional(),
  pirState: z.boolean().optional(),
  buzzerDuration: z.number().optional(),
  maxRules: z.number().optional(),
  enabledRules: z.number().optional(),
  rules: z.array(z.unknown()).optional(),
  timestamp: deviceTimestamp,
})

export const statusSchema = z.object({
  deviceId: z.string().min(1),
  status: z.enum(['online', 'offline']),
  firmwareVersion: z.string().max(100).optional(),
  ipAddress: z.string().max(64).optional(),
  macAddress: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: deviceTimestamp,
})

/**
 * Commands are deliberately generic. ON/OFF remains fully supported, while
 * value/parameters allow servo angle, PWM, RGB, motor speed, display text,
 * valve position, etc. without a backend schema change.
 */
export const commandSchema = z.object({
  type: z.literal('actuator'),
  actuatorId: z.string().min(1),
  command: z.string().trim().min(1).max(100),
  value: z.union([z.boolean(), z.number().finite(), z.string(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  duration: z.number().int().positive().max(86400).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  timestamp,
})

const configuredSensor = z.object({
  sensorId: z.string().min(1),
  name: z.string().optional(),
  type: z.string().min(1),
  interface: z.string().optional(),
  gpio: z.number().int().min(0).max(48).optional(),
  pins: z.record(z.string(), z.number().int().min(0).max(48)).optional(),
  address: z.union([z.number().int(), z.string()]).optional(),
  channel: z.union([z.number().int(), z.string()]).optional(),
  unit: z.string().optional(),
  config: sensorConfig,
})

const configuredActuator = z.object({
  actuatorId: z.string().min(1),
  name: z.string().optional(),
  type: z.string().min(1),
  interface: z.string().optional(),
  gpio: z.number().int().min(0).max(48).optional(),
  pins: z.record(z.string(), z.number().int().min(0).max(48)).optional(),
  address: z.union([z.number().int(), z.string()]).optional(),
  channel: z.union([z.number().int(), z.string()]).optional(),
  state: z.unknown().optional(),
  config: actuatorConfig,
})

const configuredAutomation = z.object({
  automationId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  conditions: z.array(z.object({
    sensorId: z.string(),
    operator: z.string(),
    value: z.unknown(),
  })),
  actions: z.array(z.object({
    actuatorId: z.string(),
    command: z.string(),
    value: z.union([z.boolean(), z.number().finite(), z.string(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    duration: z.number().int().positive().max(86400).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })),
})

export const configSchema = z.object({
  deviceId: z.string().min(1),
  protocolVersion: z.string().optional(),
  // Config synchronisation: the ESP32 echoes these back in CONFIG_ACK.
  configVersion: z.number().int().positive().optional(),
  configHash: z.string().max(64).optional(),
  sensors: z.array(configuredSensor),
  actuators: z.array(configuredActuator),
  automations: z.array(configuredAutomation).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

/**
 * Device -> backend acknowledgement on `devices/<deviceId>/config/ack`.
 * `applied` means the ESP32 parsed the config and reconfigured its hardware.
 */
export const configAckSchema = z.object({
  deviceId: z.string().min(1),
  configVersion: z.number().int().min(0),
  configHash: z.string().max(64).optional(),
  status: z.enum(['applied', 'failed']),
  error: z.string().max(300).optional(),
  sensors: z.number().int().min(0).optional(),
  actuators: z.number().int().min(0).optional(),
  firmwareVersion: z.string().max(100).optional(),
  timestamp: deviceTimestamp,
})