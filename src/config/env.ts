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
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
})
export const env = schema.parse(process.env)

export const allowedOrigins = env.CLIENT_URL
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)