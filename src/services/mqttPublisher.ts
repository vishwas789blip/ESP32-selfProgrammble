import { mqttClient } from '../config/mqtt.js'

const PUBLISH_TIMEOUT_MS = 8000

type PublishOptions = { qos?: 0 | 1 | 2; retain?: boolean }

const mqttUnavailable = (message: string) =>
  Object.assign(new Error(message), { statusCode: 503, code: 'MQTT_UNAVAILABLE' })

function rawPublish(topic: string, body: string, options: PublishOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!mqttClient.connected) {
      console.error(`[MQTT] publish skipped, broker not connected topic=${topic}`)
      reject(mqttUnavailable('MQTT broker is not connected'))
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.error(`[MQTT] publish timed out topic=${topic}`)
      reject(mqttUnavailable('MQTT publish timed out'))
    }, PUBLISH_TIMEOUT_MS)

    mqttClient.publish(topic, body, { qos: 1, ...options }, error => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (error) {
        console.error(`[MQTT] publish failed topic=${topic}: ${error.message}`)
        reject(error)
        return
      }

      // Log commands only, so config/telemetry traffic does not flood the logs.
      if (topic.endsWith('/command')) {
        console.log(`[MQTT] publish acked topic=${topic} body=${body}`)
      }

      resolve()
    })
  })
}

export function publishMessage(topic: string, payload: unknown, options: PublishOptions = {}) {
  return rawPublish(topic, JSON.stringify(payload), options)
}

export function clearRetained(topic: string) {
  return rawPublish(topic, '', { qos: 1, retain: true })
}