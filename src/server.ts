import { app } from './app.js'
import { connectDatabase } from './config/db.js'
import { env } from './config/env.js'
import { startMqtt, stopMqtt } from './services/mqttService.js'
import { setupRealtime, realtimeWss } from './services/realtimeService.js'

connectDatabase().then(() => {
  const server = app.listen(env.PORT, () => {
    console.log(`Server started on port ${env.PORT}`)
    console.log(`WebSocket endpoint: ws://localhost:${env.PORT}/?token=<JWT>`)
  })

  setupRealtime(server)
  startMqtt()

  const shutdown = () => {
    stopMqtt()
    realtimeWss.close()
    server.close(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}).catch(() => process.exit(1))
