import mqtt, { MqttClient } from 'mqtt'
import { env } from './env.js'

export const mqttClient: MqttClient = mqtt.connect(env.MQTT_BROKER_URL, {
  clientId: env.MQTT_CLIENT_ID,
  username: env.MQTT_USERNAME || undefined,
  password: env.MQTT_PASSWORD || undefined,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
  clean: true,
})

export const topics = { telemetry: 'devices/+/telemetry', status: 'devices/+/status', command: (id: string) => `devices/${id}/command`, config: (id: string) => `devices/${id}/config`, automation: (id: string) => `devices/${id}/automation` }