import { app } from './app.js'
import { connectDatabase } from './config/db.js'
import { env } from './config/env.js'
import { startMqtt, stopMqtt } from './services/mqttService.js'
import { setupRealtime, realtimeWss } from './services/realtimeService.js'
import { startDeviceMonitor, stopDeviceMonitor } from './services/deviceMonitor.js'

connectDatabase().then(() => {
  const server = app.listen(env.PORT, () => {
    console.log(`Server started on port ${env.PORT}`)
    console.log(`WebSocket endpoint: ws://localhost:${env.PORT}/?token=<JWT>`)
  })

  setupRealtime(server)
  startMqtt()
  startDeviceMonitor()

  const shutdown = () => {
    stopDeviceMonitor()
    stopMqtt()
    realtimeWss.close()
    server.close(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}).catch((error) => {
  console.error('Startup failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
