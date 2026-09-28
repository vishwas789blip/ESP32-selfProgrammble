import { randomUUID } from 'node:crypto'
import mqtt, { MqttClient } from 'mqtt'
import { env } from './env.js'

const persistentSession = env.MQTT_PERSISTENT_SESSION === 'true'

// Fixed clientId + two processes on one broker => the broker disconnects the older
// one, both reconnect every 5s and kick each other forever. Use a unique id unless a
// persistent session (which needs a stable id) was requested.
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
})

// The client connects as soon as this module is imported, which is BEFORE startMqtt()
// attaches its listeners (it runs after MongoDB is connected). An 'error' event with
// no listener would crash the process, so keep a baseline handler from the start.
mqttClient.on('error', () => {})

export const topics = { telemetry: 'devices/+/telemetry', status: 'devices/+/status', command: (id: string) => `devices/${id}/command`, config: (id: string) => `devices/${id}/config`, automation: (id: string) => `devices/${id}/automation` }
