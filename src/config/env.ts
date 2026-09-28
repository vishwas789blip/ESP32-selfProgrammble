import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  MONGO_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CLIENT_URL: z.string().min(1).default('http://localhost:3000'),
  MQTT_BROKER_URL: z.string().url().default('mqtt://127.0.0.1:1883'),
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  MQTT_CLIENT_ID: z.string().min(1).default('esp32-backend'),

  // 'false' (default): every process gets a unique clientId (MQTT_CLIENT_ID + random
  //   suffix) and a clean session, so dev + prod / several instances never kick each
  //   other off the broker.
  // 'true': stable clientId + persistent session (clean:false), so the broker queues
  //   QoS1 telemetry/status while the backend is down. Run ONLY ONE instance per
  //   MQTT_CLIENT_ID in this mode.
  MQTT_PERSISTENT_SESSION: z.enum(['true', 'false']).default('false'),

  // Who evaluates automation rules?
  // 'server' (default): backend evaluates rules on telemetry and sends commands.
  //   Rules are NOT pushed to the ESP32, so an actuator can never fire twice.
  // 'device': the ESP32 runs the rules itself (they are pushed inside the retained
  //   config message). The backend does not evaluate rules.
  AUTOMATION_EXECUTOR: z.enum(['server', 'device']).default('server'),

  // A device that is 'online' but has sent nothing for this many seconds is marked
  // offline. Set to 0 to disable. Keep it > 2x the device's telemetry interval.
  DEVICE_OFFLINE_TIMEOUT_SEC: z.coerce.number().int().min(0).default(120),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
})
export const env = schema.parse(process.env)

export const allowedOrigins = env.CLIENT_URL
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)
