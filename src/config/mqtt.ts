import { randomUUID } from 'node:crypto'
import mqtt, { MqttClient } from 'mqtt'
import { env } from './env.js'

const persistentSession = env.MQTT_PERSISTENT_SESSION === 'true'

export const mqttClientId = persistentSession
  ? env.MQTT_CLIENT_ID
  : `${env.MQTT_CLIENT_ID}-${randomUUID().slice(0, 8)}`

export const mqttClient: MqttClient = mqtt.connect(env.MQTT_BROKER_URL, {
  clientId: mqttClientId,
  username: env.MQTT_USERNAME || undefined,
  password: env.MQTT_PASSWORD || undefined,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
  clean: !persistentSession,
  keepalive: 30,
})

// mqtt.js can emit an error before startMqtt() installs the rest of the handlers.
mqttClient.on('error', () => {})

export const topics = {
  telemetry: 'devices/+/telemetry',
  status: 'devices/+/status',
  // Device -> backend: "I received/applied config version N".
  configAck: 'devices/+/config/ack',
  command: (id: string) => `devices/${id}/command`,
  config: (id: string) => `devices/${id}/config`,
  automation: (id: string) => `devices/${id}/automation`,
}

export type DeviceTopicKind = 'telemetry' | 'status' | 'config/ack'

/**
 * Extracts the deviceId from `devices/<deviceId>/<kind>`.
 * The id is returned exactly as it appears in the topic (no trimming, no
 * case-folding) so that the DB lookup is a strict, exact match.
 */
export function deviceIdFromTopic(topic: string, kind: DeviceTopicKind) {
  const suffix = kind.split('/')
  const parts = topic.split('/')

  if (parts.length !== 2 + suffix.length || parts[0] !== 'devices') return null
  if (suffix.some((part, index) => parts[2 + index] !== part)) return null

  return parts[1] || null
}