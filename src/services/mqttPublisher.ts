import { mqttClient } from '../config/mqtt.js'

const PUBLISH_TIMEOUT_MS = 8000

type PublishOptions = { qos?: 0 | 1 | 2; retain?: boolean }

const mqttUnavailable = (message: string) =>
  Object.assign(new Error(message), { statusCode: 503, code: 'MQTT_UNAVAILABLE' })

function rawPublish(topic: string, body: string, options: PublishOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // mqtt.js would otherwise queue the packet and the QoS1 callback would not fire
    // until the broker is back, hanging the HTTP request / telemetry handler.
    if (!mqttClient.connected) {
      reject(mqttUnavailable('MQTT broker is not connected'))
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(mqttUnavailable('MQTT publish timed out'))
    }, PUBLISH_TIMEOUT_MS)

    mqttClient.publish(topic, body, { qos: 1, ...options }, error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Single publish path for the whole backend (connected check + timeout + 503 errors). */
export function publishMessage(topic: string, payload: unknown, options: PublishOptions = {}): Promise<void> {
  return rawPublish(topic, JSON.stringify(payload), options)
}

/** An empty retained payload removes the retained message from the broker. */
export function clearRetained(topic: string): Promise<void> {
  return rawPublish(topic, '', { qos: 1, retain: true })
}
