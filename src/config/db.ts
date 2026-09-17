import mongoose from 'mongoose'
import { env } from './env.js'

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(env.MONGO_URI, { dbName: 'esp32_self_programmable' })
    console.log('MongoDB connected successfully')
  } catch (error) {
    console.error('MongoDB connection failed:', error instanceof Error ? error.message : error)
    throw error
  }
}
