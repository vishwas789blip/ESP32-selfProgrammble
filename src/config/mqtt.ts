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
  command: (id: string) => `devices/${id}/command`,
  config: (id: string) => `devices/${id}/config`,
  automation: (id: string) => `devices/${id}/automation`,
}

export function deviceIdFromTopic(topic: string, kind: 'telemetry' | 'status') {
  const parts = topic.split('/')
  if (parts.length !== 3 || parts[0] !== 'devices' || parts[2] !== kind) return null
  return parts[1] || null
}
