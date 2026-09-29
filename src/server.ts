import { app } from './app.js'
import { connectDatabase } from './config/db.js'
import { env } from './config/env.js'
import { startMqtt, stopMqtt } from './services/mqttService.js'
import { setupRealtime, realtimeWss } from './services/realtimeService.js'
import { startDeviceMonitor, stopDeviceMonitor } from './services/deviceMonitor.js'

async function main() {
  await connectDatabase()

  const server = app.listen(env.PORT, () => {
    console.log(`Server started on port ${env.PORT}`)
    console.log(`WebSocket endpoint: ws://localhost:${env.PORT}/?token=<JWT>`)
  })

  setupRealtime(server)
  startMqtt()
  startDeviceMonitor()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[SERVER] Shutting down (${signal})...`)

    stopDeviceMonitor()

    await new Promise<void>(resolve => {
      server.close(() => resolve())
    }).catch(() => {})

    await stopMqtt().catch(error => console.error('[SERVER] MQTT shutdown failed:', error))

    await new Promise<void>(resolve => {
      realtimeWss.close(() => resolve())
    }).catch(() => {})

    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(error => {
  console.error('Startup failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
